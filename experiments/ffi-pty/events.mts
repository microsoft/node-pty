import { setImmediate as defer } from "node:timers";
import { StringDecoder } from "node:string_decoder";
import type { Backend, ExitStatus, FfiPty } from "./contract.mts";
import { validateDimension } from "./validation.mts";

export function createPtyFromBackend(
  backend: Backend,
  initialCols: number,
  initialRows: number,
): FfiPty {
  const decoder = new StringDecoder("utf8");
  const dataListeners = new Set<(data: string) => void>();
  const exitListeners = new Set<(status: ExitStatus) => void>();
  let cols = initialCols;
  let rows = initialRows;
  let paused = false;
  let closing = false;
  let outputEnded = false;
  let status: ExitStatus | undefined;
  let streamError: Error | undefined;
  let settled = false;
  let closePromise: Promise<void> | undefined;
  let resolveExit!: (status: ExitStatus) => void;
  let rejectExit!: (error: Error) => void;
  const exited = new Promise<ExitStatus>((resolve, reject) => {
    resolveExit = resolve;
    rejectExit = reject;
  });
  void exited.catch(() => {});

  const cleanupBackend = () => {
    if (closePromise) return;
    closing = true;
    paused = false;
    backend.readable.resume();
    closePromise = backend.close();
    void closePromise.catch(() => {});
  };

  const settle = () => {
    if (settled) return;
    if (streamError) {
      settled = true;
      rejectExit(streamError);
      return;
    }
    if (!outputEnded || !status) return;
    settled = true;
    for (const listener of [...exitListeners]) {
      try {
        listener(status);
      } catch (error) {
        queueMicrotask(() => {
          throw error;
        });
      }
    }
    resolveExit(status);
  };
  const emit = (value: string) => {
    if (!value) return;
    for (const listener of [...dataListeners]) {
      try {
        listener(value);
      } catch (error) {
        queueMicrotask(() => {
          throw error;
        });
      }
    }
  };
  const onData = (chunk: Buffer | string) => {
    emit(typeof chunk === "string" ? decoder.write(Buffer.from(chunk)) : decoder.write(chunk));
  };
  const onEnd = () => {
    emit(decoder.end());
    outputEnded = true;
    settle();
  };
  const onError = (error: Error) => {
    streamError = error;
    outputEnded = true;
    settle();
    cleanupBackend();
  };
  backend.readable.pause();
  backend.readable.on("data", onData);
  backend.readable.once("end", onEnd);
  backend.readable.once("error", onError);
  defer(() => {
    if (!paused && !closing) backend.readable.resume();
  });
  backend.exited.then(
    (value) => {
      status = value;
      settle();
    },
    (error: unknown) => {
      streamError = error instanceof Error ? error : new Error(String(error));
      settle();
      cleanupBackend();
    },
  );

  return {
    pid: backend.pid,
    get cols() {
      return cols;
    },
    get rows() {
      return rows;
    },
    exited,
    onData(listener) {
      dataListeners.add(listener);
      return { dispose: () => dataListeners.delete(listener) };
    },
    onExit(listener) {
      exitListeners.add(listener);
      let active = true;
      if (settled && status && !streamError)
        queueMicrotask(() => {
          if (active) listener(status!);
        });
      return {
        dispose: () => {
          active = false;
          exitListeners.delete(listener);
        },
      };
    },
    async write(data) {
      if (closing) throw new Error("PTY is closed");
      if (status || outputEnded || settled) throw new Error("PTY has exited");
      const bytes = Buffer.isBuffer(data) ? Buffer.from(data) : Buffer.from(data, "utf8");
      await backend.write(bytes);
    },
    async resize(nextCols, nextRows) {
      if (closing) throw new Error("PTY is closed");
      if (status || outputEnded || settled) throw new Error("PTY has exited");
      validateDimension(nextCols, "cols");
      validateDimension(nextRows, "rows");
      await backend.resize(nextCols, nextRows);
      cols = nextCols;
      rows = nextRows;
    },
    async kill(signal) {
      if (!closing && !status && !settled) await backend.kill(signal);
    },
    pause() {
      if (paused || closing) return;
      paused = true;
      backend.readable.pause();
    },
    resume() {
      if (!paused || closing) return;
      paused = false;
      backend.readable.resume();
    },
    close() {
      if (!closePromise) {
        closing = true;
        paused = false;
        backend.readable.resume();
        closePromise = backend.close();
      }
      return closePromise;
    },
  };
}
