import { setImmediate as yieldToLoop, setTimeout as delay } from "node:timers/promises";
import { ReadStream } from "node:tty";
import { PassThrough } from "node:stream";
import { writeSync } from "node:fs";
import type { SpawnOptions, ExitStatus, Backend } from "./contract.mts";
import { initializeNonblockingPoll } from "./unix-poll.mts";

export interface UnixBindings {
  spawn(options: SpawnOptions): { pid: number; masterFd: number; slaveName: string };
  wait(pid: number): ExitStatus | null;
  kill(pid: number, signal: string): void;
  resize(slaveName: string, cols: number, rows: number): Promise<void>;
  closeFd(fd: number): void;
}

const WRITE_QUEUE_LIMIT = 8 * 1024 * 1024;
const DRAIN_AFTER_EXIT_MS = 1500;
const CLOSE_GRACE_MS = 500;

export async function destroyReadStream(source: ReadStream): Promise<void> {
  if (source.closed) return;
  await new Promise<void>((resolve) => {
    source.once("close", resolve);
    source.destroy();
    if (source.closed) resolve();
  });
}

export function waitForOutputDrain(readable: PassThrough, timeoutMs: number): Promise<boolean> {
  if (readable.readableEnded || readable.destroyed) return Promise.resolve(true);
  return new Promise((resolve) => {
    let remaining = timeoutMs;
    let startedAt = 0;
    let timer: NodeJS.Timeout | undefined;
    let settled = false;
    const finish = (drained: boolean) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      readable.removeListener("resume", update);
      readable.removeListener("pause", update);
      readable.removeListener("end", onEnd);
      readable.removeListener("close", onEnd);
      resolve(drained);
    };
    const onEnd = () => finish(true);
    const update = () => {
      if (readable.readableEnded || readable.destroyed) {
        finish(true);
      } else if (readable.readableFlowing !== false && !timer) {
        startedAt = Date.now();
        timer = setTimeout(() => {
          timer = undefined;
          if (readable.readableFlowing !== false) finish(false);
          else update();
        }, remaining);
      } else if (readable.readableFlowing === false && timer) {
        clearTimeout(timer);
        timer = undefined;
        remaining = Math.max(0, remaining - (Date.now() - startedAt));
      }
    };
    readable.on("resume", update);
    readable.on("pause", update);
    readable.once("end", onEnd);
    readable.once("close", onEnd);
    update();
  });
}

export function createUnixBackend(options: SpawnOptions, bindings: UnixBindings): Backend {
  const child = bindings.spawn(options);
  let source: ReadStream;
  try {
    initializeNonblockingPoll(child.masterFd);
    source = new ReadStream(child.masterFd);
  } catch (error) {
    try {
      bindings.closeFd(child.masterFd);
    } catch {
      /* descriptor was not acquired */
    }
    try {
      bindings.kill(child.pid, "SIGTERM");
    } catch {
      /* child may have exited */
    }
    void (async () => {
      const deadline = Date.now() + CLOSE_GRACE_MS;
      let status = bindings.wait(child.pid);
      while (Date.now() < deadline && !status) {
        await delay(20);
        status = bindings.wait(child.pid);
      }
      if (!status) {
        try {
          bindings.kill(child.pid, "SIGKILL");
        } catch {
          /* child may have exited */
        }
        while (!bindings.wait(child.pid)) await delay(20);
      }
    })().catch(() => {});
    throw error;
  }
  const readable = new PassThrough({ highWaterMark: 64 * 1024 });
  const endReadable = () => {
    if (!readable.writableEnded) readable.end();
  };
  const forwardData = (chunk: Buffer) => {
    if (!readable.write(chunk)) source.pause();
  };
  source.on("data", forwardData);
  readable.on("drain", () => source.resume());
  source.on("end", endReadable);
  source.on("close", endReadable);
  source.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EIO") endReadable();
    else readable.destroy(error);
  });
  let closed = false;
  let closing = false;
  let reaped = false;
  let queuedBytes = 0;
  let writeTail = Promise.resolve();
  let closePromise: Promise<void> | undefined;
  let resolveExit!: (status: ExitStatus) => void;
  let rejectExit!: (error: Error) => void;
  const exited = new Promise<ExitStatus>((resolve, reject) => {
    resolveExit = resolve;
    rejectExit = reject;
  });
  void exited.catch(() => {});

  const write = (data: Buffer): Promise<void> => {
    if (closed || closing || source.destroyed || source.closed)
      return Promise.reject(new Error("PTY is closed"));
    if (reaped) return Promise.reject(new Error("PTY has exited"));
    const bytes = Buffer.from(data);
    if (queuedBytes + bytes.length > WRITE_QUEUE_LIMIT) {
      return Promise.reject(new Error("PTY write queue exceeds 8 MiB"));
    }
    queuedBytes += bytes.length;
    const operation = writeTail
      .then(async () => {
        let offset = 0;
        while (offset < bytes.length) {
          if (closed || closing || source.destroyed || source.closed)
            throw new Error("PTY is closed");
          if (reaped) throw new Error("PTY has exited");
          let count: number;
          try {
            // ReadStream sets the PTY master nonblocking. A sync write avoids a
            // thread-pool write racing the stream's fd close and reuse.
            count = writeSync(
              child.masterFd,
              bytes,
              offset,
              Math.min(bytes.length - offset, 64 * 1024),
            );
          } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code === "EINTR" || code === "EAGAIN" || code === "EWOULDBLOCK") {
              await delay(10);
              continue;
            }
            throw error;
          }
          if (!count) {
            await delay(10);
            continue;
          }
          offset += count;
          await yieldToLoop();
        }
      })
      .finally(() => {
        queuedBytes -= bytes.length;
      });
    writeTail = operation.catch(() => {});
    return operation;
  };

  const poll = async () => {
    try {
      for (;;) {
        const status = bindings.wait(child.pid);
        if (status) {
          reaped = true;
          // Allow buffered kernel output and inherited descendant descriptors to drain.
          const drained = await waitForOutputDrain(readable, DRAIN_AFTER_EXIT_MS);
          if (!drained) {
            source.removeListener("data", forwardData);
            await destroyReadStream(source);
            endReadable();
          }
          if (!source.closed) await destroyReadStream(source);
          resolveExit(status);
          return;
        }
        await delay(20);
      }
    } catch (error) {
      reaped = true;
      source.removeListener("data", forwardData);
      await destroyReadStream(source).catch(() => {});
      endReadable();
      rejectExit(error instanceof Error ? error : new Error(String(error)));
    }
  };
  void poll();

  return {
    pid: child.pid,
    readable,
    write,
    resize: async (cols, rows) => {
      if (closed || closing || source.destroyed || source.closed) throw new Error("PTY is closed");
      if (reaped) throw new Error("PTY has exited");
      await bindings.resize(child.slaveName, cols, rows);
    },
    kill: async (signal = "SIGTERM") => {
      if (closed || closing || reaped || source.destroyed || source.closed) return;
      bindings.kill(child.pid, signal);
    },
    close: () => {
      if (!closePromise) {
        closing = true;
        // Backend callers may bypass the facade, so close must unblock drain itself.
        readable.resume();
        closePromise = (async () => {
          if (!closed) {
            if (!reaped) {
              try {
                bindings.kill(child.pid, "SIGTERM");
              } catch {
                /* process may have exited */
              }
            }
            await Promise.race([
              exited.catch(() => undefined),
              delay(CLOSE_GRACE_MS).then(() => undefined),
            ]);
            if (!reaped) {
              try {
                bindings.kill(child.pid, "SIGKILL");
              } catch {
                /* process may have exited */
              }
            }
            await exited.catch(() => undefined);
            closed = true;
            source.removeListener("data", forwardData);
            await destroyReadStream(source);
          }
          await writeTail;
        })();
      }
      return closePromise;
    },
    exited,
  };
}
