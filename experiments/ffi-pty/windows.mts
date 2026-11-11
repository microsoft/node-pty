import { PassThrough } from "node:stream";
import { createConnection, type Socket } from "node:net";
import type { Backend, SpawnOptions, ExitStatus } from "./contract.mts";
import { validateDimension } from "./validation.mts";
import { buildWindowsCommandLine, buildWindowsEnvironmentBlock } from "./windows-commandline.mts";
import type { BrokerReply, BrokerRequest } from "./windows-protocol.mts";
import { createWindowsTransport } from "./windows-selection.mts";

export type { Backend, SpawnOptions } from "./contract.mts";

const MAX_QUEUED_INPUT = 8 * 1024 * 1024;
const STARTUP_TIMEOUT_MS = 15_000;
const COMMAND_TIMEOUT_MS = 10_000;
const GRACEFUL_STOP_MS = 1_000;
const BROKER_STOP_MS = 3_000;
export { createWindowsTransport };

export async function promiseWithTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function dimensions(cols: number, rows: number): void {
  validateDimension(cols, "cols");
  validateDimension(rows, "rows");
}

export function windowsSignalNumber(signal: string): number {
  const signals: Record<string, number> = { SIGTERM: 15, SIGKILL: 9 };
  const value = signals[signal.toUpperCase()];
  if (value === undefined) throw new Error(`Unsupported Windows termination signal: ${signal}`);
  return value;
}

export function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

export async function createBackend(options: SpawnOptions): Promise<Backend> {
  if (process.platform !== "win32") throw new Error("Windows ConPTY backend requires Windows");
  if (process.arch !== "x64" && process.arch !== "arm64")
    throw new Error(`Unsupported Windows architecture: ${process.arch}`);
  dimensions(options.cols, options.rows);
  if (!options.file || options.file.includes("\0") || options.cwd.includes("\0"))
    throw new Error("Invalid executable path or cwd");
  buildWindowsCommandLine(options.file, options.args);
  buildWindowsEnvironmentBlock(options.env);

  const transport = await createWindowsTransport();
  const output = new PassThrough({ highWaterMark: 64 * 1024 });
  const sockets = new Set<Socket>();
  const pending = new Map<
    number,
    { resolve(): void; reject(error: Error): void; timer: NodeJS.Timeout }
  >();
  let input: Socket | undefined;
  let outputSocket: Socket | undefined;
  let forwardOutput: ((chunk: Buffer) => void) | undefined;
  let serial = 0;
  let queued = 0;
  let writeTail = Promise.resolve();
  let startupTimer: NodeJS.Timeout | undefined;
  let brokerDone = false;
  let transportStopped = false;
  let outputEnded = false;
  let remoteOutputEnded = false;
  let exitStatus: ExitStatus | undefined;
  let failure: Error | undefined;
  let closed = false;
  let closing = false;
  let terminationRequested = false;
  let settled = false;
  let closePromise: Promise<void> | undefined;
  let cleanupPromise: Promise<void> | undefined;
  let resolvePipes!: () => void;
  let rejectPipes!: (error: Error) => void;
  let resolveSpawned!: (pid: number) => void;
  let rejectSpawned!: (error: Error) => void;
  let resolveBrokerDone!: () => void;
  let rejectFailure!: (error: Error) => void;
  let rejectExited!: (error: Error) => void;
  let resolveExited!: (status: ExitStatus) => void;
  const pipesReady = new Promise<void>((resolve, reject) => {
    resolvePipes = resolve;
    rejectPipes = reject;
  });
  const spawned = new Promise<number>((resolve, reject) => {
    resolveSpawned = resolve;
    rejectSpawned = reject;
  });
  const brokerDonePromise = new Promise<void>((resolve) => {
    resolveBrokerDone = resolve;
  });
  const failurePromise = new Promise<never>((_, reject) => {
    rejectFailure = reject;
  });
  const exited = new Promise<ExitStatus>((resolve, reject) => {
    resolveExited = resolve;
    rejectExited = reject;
  });
  void pipesReady.catch(() => {});
  void spawned.catch(() => {});
  void exited.catch(() => {});
  void failurePromise.catch(() => {});
  output.on("error", () => {});

  const allSocketsClosed = () => [...sockets].every((socket) => socket.closed);
  const finishExit = () => {
    if (
      !settled &&
      !failure &&
      exitStatus &&
      outputEnded &&
      brokerDone &&
      transportStopped &&
      allSocketsClosed()
    ) {
      settled = true;
      resolveExited(exitStatus);
    }
  };
  const destroySockets = async () => {
    await Promise.all(
      [...sockets].map(
        (socket) =>
          new Promise<void>((resolve) => {
            if (socket.closed) return resolve();
            socket.once("close", () => resolve());
            socket.destroy();
          }),
      ),
    );
    finishExit();
  };
  const stopBroker = (error: Error): Promise<void> => {
    if (cleanupPromise) return cleanupPromise;
    cleanupPromise = (async () => {
      output.resume();
      input?.destroy();
      if (outputSocket && !remoteOutputEnded) {
        if (forwardOutput) outputSocket.off("data", forwardOutput);
        outputSocket.on("data", () => {});
        outputSocket.resume();
      }
      void transport.send({ type: "abort", error: error.message }).catch(() => {});
      try {
        await promiseWithTimeout(
          brokerDonePromise,
          GRACEFUL_STOP_MS,
          "PTY broker cleanup timed out",
        );
      } catch {
        await destroySockets();
      }
      let cleanupError: Error | undefined;
      try {
        await promiseWithTimeout(
          transport.terminate(),
          BROKER_STOP_MS,
          "Windows PTY transport termination timed out",
        );
      } catch (cause) {
        cleanupError = asError(cause);
      }
      try {
        await promiseWithTimeout(
          transport.closed,
          BROKER_STOP_MS,
          "Windows PTY transport exit timed out",
        );
      } catch (cause) {
        cleanupError ??= asError(cause);
      }
      await destroySockets();
      if (!output.destroyed) output.destroy(error);
      if (cleanupError) throw cleanupError;
    })();
    return cleanupPromise;
  };
  const fail = (cause: unknown) => {
    if (failure || settled) return;
    failure = asError(cause);
    if (startupTimer) clearTimeout(startupTimer);
    rejectPipes(failure);
    rejectSpawned(failure);
    if (!settled) {
      settled = true;
      rejectExited(failure);
    }
    rejectFailure(failure);
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(failure);
    }
    pending.clear();
    void stopBroker(failure).catch(() => {});
  };
  const send = async (message: BrokerRequest): Promise<void> => {
    try {
      await transport.send(message);
    } catch (error) {
      fail(error);
      throw asError(error);
    }
  };
  const connectPipe = (path: string, isOutput = false): Promise<Socket> => {
    const socket = createConnection(path);
    sockets.add(socket);
    if (isOutput) outputSocket = socket;
    socket.on("error", (error) => {
      const expectedInputEof =
        !isOutput &&
        (closing || terminationRequested) &&
        (error as NodeJS.ErrnoException).code === "EOF";
      // A pending write still rejects through its write callback on deliberate shutdown.
      if (!expectedInputEof) fail(error);
    });
    socket.on("close", () => {
      if (isOutput && !remoteOutputEnded) {
        remoteOutputEnded = true;
        output.end();
      }
      finishExit();
    });
    return new Promise((resolve, reject) => {
      const onConnect = () => {
        socket.off("error", onConnectError);
        socket.off("close", onCloseBeforeConnect);
        resolve(socket);
      };
      const onConnectError = (error: Error) => {
        socket.off("connect", onConnect);
        socket.off("close", onCloseBeforeConnect);
        reject(error);
      };
      const onCloseBeforeConnect = () => {
        socket.off("connect", onConnect);
        socket.off("error", onConnectError);
        reject(new Error("PTY broker pipe closed before connecting"));
      };
      socket.once("connect", onConnect);
      socket.once("error", onConnectError);
      socket.once("close", onCloseBeforeConnect);
    });
  };
  const onReply = (reply: BrokerReply) => {
    if (reply.type === "pipes") {
      if (sockets.size || failure) return fail(new Error("Unexpected PTY broker pipe setup"));
      const inputPromise = connectPipe(reply.input);
      const outputPromise = connectPipe(reply.output, true);
      void Promise.all([inputPromise, outputPromise])
        .then(async ([inputSocket, connectedOutput]) => {
          if (failure) return;
          input = inputSocket;
          outputSocket = connectedOutput;
          forwardOutput = (chunk: Buffer) => {
            if (!output.write(chunk)) connectedOutput.pause();
          };
          connectedOutput.on("data", forwardOutput);
          output.on("drain", () => connectedOutput.resume());
          connectedOutput.once("end", () => {
            remoteOutputEnded = true;
            output.end();
            connectedOutput.destroy();
          });
          await send({ type: "connected" });
          resolvePipes();
        }, fail)
        .catch(fail);
    } else if (reply.type === "spawned") {
      if (startupTimer) clearTimeout(startupTimer);
      resolveSpawned(reply.pid);
    } else if (reply.type === "ack") {
      const request = pending.get(reply.id);
      if (!request) return;
      pending.delete(reply.id);
      clearTimeout(request.timer);
      if (reply.error) request.reject(new Error(reply.error));
      else request.resolve();
    } else if (reply.type === "exited") {
      exitStatus = { exitCode: reply.signal ? null : reply.exitCode, signal: reply.signal };
      input?.destroy();
      finishExit();
    } else if (reply.type === "error") {
      fail(new Error(reply.error));
    } else if (reply.type === "brokerDone") {
      brokerDone = true;
      resolveBrokerDone();
      for (const request of pending.values()) {
        clearTimeout(request.timer);
        request.reject(new Error("PTY broker stopped"));
      }
      pending.clear();
      if (!exitStatus && !failure) fail(new Error("PTY broker stopped without an exit status"));
      finishExit();
    }
  };

  startupTimer = setTimeout(
    () => fail(new Error("Timed out starting ConPTY process")),
    STARTUP_TIMEOUT_MS,
  );
  output.once("end", () => {
    outputEnded = true;
    finishExit();
  });
  const removeMessageListener = transport.onMessage(onReply);
  const removeErrorListener = transport.onError(fail);
  void transport.closed.then(() => {
    removeMessageListener();
    removeErrorListener();
    transportStopped = true;
    if (!brokerDone && !failure) fail(new Error("Windows PTY transport closed before brokerDone"));
    finishExit();
  }, fail);
  const command = (request: Extract<BrokerRequest, { type: "command" }>): Promise<void> => {
    if (closed || closing || failure || brokerDone || exitStatus)
      return Promise.reject(new Error("PTY is closed or the process has exited"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(request.id);
        const error = new Error(`ConPTY ${request.command} request timed out`);
        reject(error);
        fail(error);
      }, COMMAND_TIMEOUT_MS);
      pending.set(request.id, { resolve, reject, timer });
      void send(request).catch((error) => {
        pending.delete(request.id);
        clearTimeout(timer);
        reject(asError(error));
      });
    });
  };

  const stop = async () => {
    try {
      if (failure) await stopBroker(failure);
      else {
        output.resume();
        if (!exitStatus && !brokerDone) {
          const id = ++serial;
          void send({ type: "command", id, command: "close" }).catch(() => {});
        }
        await promiseWithTimeout(exited, STARTUP_TIMEOUT_MS, "ConPTY process exit timed out");
        await destroySockets();
        await writeTail;
      }
    } catch (error) {
      const failureError = asError(error);
      fail(failureError);
      await stopBroker(failureError).catch(() => {});
      throw error;
    }
  };

  try {
    await promiseWithTimeout(
      Promise.race([transport.ready, failurePromise]),
      STARTUP_TIMEOUT_MS,
      "Windows PTY transport startup timed out",
    );
    await send({ type: "start", options });
    await promiseWithTimeout(pipesReady, STARTUP_TIMEOUT_MS, "ConPTY pipes timed out");
    const pid = await promiseWithTimeout(
      spawned,
      STARTUP_TIMEOUT_MS,
      "ConPTY process startup timed out",
    );
    return {
      pid,
      readable: output,
      write(buffer) {
        if (closed || closing || failure || exitStatus || brokerDone || !input || input.destroyed)
          return Promise.reject(new Error("PTY is closed"));
        const copy = Buffer.from(buffer);
        if (queued + copy.length > MAX_QUEUED_INPUT)
          return Promise.reject(new Error("PTY input queue limit exceeded (8 MiB maximum)"));
        queued += copy.length;
        const operation = writeTail
          .then(
            () =>
              new Promise<void>((resolve, reject) => {
                const socket = input;
                if (
                  closed ||
                  closing ||
                  failure ||
                  exitStatus ||
                  brokerDone ||
                  !socket ||
                  socket.destroyed
                )
                  return reject(new Error("PTY input pipe is closed"));
                socket.write(copy, (error) => (error ? reject(error) : resolve()));
              }),
          )
          .finally(() => {
            queued -= copy.length;
          });
        writeTail = operation.catch(() => {});
        return operation;
      },
      resize(cols, rows) {
        dimensions(cols, rows);
        return command({ type: "command", id: ++serial, command: "resize", cols, rows });
      },
      kill(signal = "SIGTERM") {
        let number: number;
        try {
          number = windowsSignalNumber(signal);
        } catch (error) {
          return Promise.reject(error);
        }
        terminationRequested = true;
        return command({ type: "command", id: ++serial, command: "kill", signal: number }).catch(
          (error) => {
            if (!closing && !exitStatus) terminationRequested = false;
            throw error;
          },
        );
      },
      close() {
        if (!closePromise) {
          closed = true;
          closing = true;
          terminationRequested = true;
          closePromise = stop().finally(async () => {
            output.resume();
            input?.destroy();
            await destroySockets();
            await writeTail;
          });
        }
        return closePromise;
      },
      exited,
    };
  } catch (error) {
    fail(error);
    await stopBroker(asError(error)).catch(() => {});
    throw error;
  }
}
