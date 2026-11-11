import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Writable } from "node:stream";
import type { WindowsTransport } from "./windows-transport.mts";
import { prepareWindowsStart } from "./windows-launch.mts";
import {
  decodeHelperFrames,
  decodeHelperReply,
  encodeHelperRequest,
  type PreparedWindowsStart,
} from "./windows-helper-protocol.mts";
import type { BrokerReply, BrokerRequest } from "./windows-protocol.mts";

export function helperExecutablePath(arch = process.arch): string {
  if (arch !== "x64" && arch !== "arm64")
    throw new Error(`No Windows helper is available for ${arch}`);
  return resolve(
    fileURLToPath(new URL(`../../build/ffi-pty/win32-${arch}/helper.exe`, import.meta.url)),
  );
}

export function helperStartupEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const allowed = new Set(["SYSTEMROOT", "WINDIR", "TEMP", "TMP"]);
  const result: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source)) {
    if (value !== undefined && allowed.has(name.toUpperCase())) result[name] = value;
  }
  return result;
}

export function emitError(listeners: Set<(error: Error) => void>, error: unknown): void {
  const normalized = error instanceof Error ? error : new Error(String(error));
  for (const listener of listeners) {
    try {
      listener(normalized);
    } catch {
      // Transport error observers cannot interfere with process cleanup.
    }
  }
}

export function writePipe(stdin: Writable, data: Buffer): Promise<void> {
  return new Promise<void>((resolveWrite, rejectWrite) => {
    if (stdin.destroyed || stdin.writableEnded) {
      rejectWrite(new Error("Windows helper input is closed"));
      return;
    }
    stdin.write(data, (error) => (error ? rejectWrite(error) : resolveWrite()));
  });
}

export function createHelperTransport(executablePath = helperExecutablePath()): WindowsTransport {
  if (process.platform !== "win32")
    throw new Error("The native Windows helper transport requires Windows");
  const executable = executablePath;
  const child = spawn(executable, [], {
    stdio: ["pipe", "pipe", "ignore"],
    windowsHide: true,
    env: helperStartupEnv(process.env),
  });
  const errors = new Set<(error: Error) => void>();
  const messages = new Set<(reply: BrokerReply) => void>();
  let pending = Buffer.alloc(0);
  let startPrepared: PreparedWindowsStart | undefined;
  let startSent = false;
  let expectedTermination = false;
  let sendChain = Promise.resolve();
  const ready = new Promise<void>((resolveReady, rejectReady) => {
    child.once("spawn", () => resolveReady());
    child.once("error", rejectReady);
  });
  const closed = new Promise<void>((resolveClosed) => child.once("close", () => resolveClosed()));
  void ready.catch((error) => emitError(errors, error));
  void closed.then(() => {
    if (!expectedTermination && child.exitCode !== 0) {
      emitError(
        errors,
        new Error(`Windows helper exited with code ${child.exitCode ?? "unknown"}`),
      );
    }
  });
  child.on("error", (error) => emitError(errors, error));
  child.stdout.on("data", (chunk: Buffer) => {
    try {
      const decoded = decodeHelperFrames(Buffer.from(chunk), pending);
      pending = decoded.pending;
      for (const frame of decoded.frames) {
        const reply = decodeHelperReply(frame);
        if (reply.type === "pipes") {
          if (!startPrepared) throw new Error("helper sent PIPES before START");
          reply.input = startPrepared.inputName;
          reply.output = startPrepared.outputName;
        }
        for (const listener of messages) {
          try {
            listener(reply);
          } catch (error) {
            emitError(errors, error);
          }
        }
      }
    } catch (error) {
      emitError(errors, error);
      child.kill();
    }
  });
  child.stdout.on("end", () => {
    if (pending.length) emitError(errors, new Error("truncated Windows helper reply frame"));
  });
  child.stdin.on("error", (error) => emitError(errors, error));

  return {
    ready,
    closed,
    send(request: BrokerRequest): Promise<void> {
      const operation = sendChain.then(async () => {
        let prepared: PreparedWindowsStart | undefined;
        if (request.type === "start") {
          if (startSent) throw new Error("Windows helper START was already sent");
          prepared = prepareWindowsStart(request.options);
          startPrepared = prepared;
          startSent = true;
        }
        await ready;
        await writePipe(child.stdin, encodeHelperRequest(request, prepared));
      });
      sendChain = operation.catch(() => {});
      return operation;
    },
    onMessage(listener): () => void {
      messages.add(listener);
      return () => messages.delete(listener);
    },
    onError(listener): () => void {
      errors.add(listener);
      return () => errors.delete(listener);
    },
    async terminate(): Promise<void> {
      expectedTermination = true;
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await closed;
    },
  };
}
