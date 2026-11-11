import { Worker } from "node:worker_threads";
import type { BrokerReply, BrokerRequest } from "./windows-protocol.mts";
import type { WindowsTransport } from "./windows-transport.mts";
import type { WindowsStart } from "./windows-launch.mts";
import { getWindowsBindings, initializeWindowsBindings, lastError } from "./windows-native.mts";
import { classifyWindowsVersion, detectWindowsVersion } from "./windows-version.mts";

const NULL = 0n;
const THREAD_TERMINATE = 0x0001;
const ERROR_NOT_FOUND = 1168;
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;

export type FfiWorkerEnvelope =
  | { kind: "threadId"; threadId: number }
  | { kind: "reply"; reply: BrokerReply }
  | { kind: "error"; error: string };

export interface FfiWorkerOptions {
  requireModernOs?: boolean;
  preparedStart?: WindowsStart;
}

export function rehydrateWindowsStart(start: WindowsStart): WindowsStart {
  return {
    ...start,
    application: Buffer.from(start.application),
    commandLine: Buffer.from(start.commandLine),
    cwd: Buffer.from(start.cwd),
    environment: Buffer.from(start.environment),
  };
}

export function createKillOnCloseJob(native = getWindowsBindings()): bigint {
  const job = native.CreateJobObjectW(NULL, NULL) as bigint;
  if (!job || job === 0xffff_ffff_ffff_ffffn) throw lastError("CreateJobObjectW");
  const info = Buffer.alloc(144);
  info.writeUInt32LE(JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, 16);
  if (!native.SetInformationJobObject(job, 9, info, info.length)) {
    const error = lastError("SetInformationJobObject");
    native.CloseHandle(job);
    throw error;
  }
  return job;
}

export class FfiTransport implements WindowsTransport {
  readonly ready = Promise.resolve();
  readonly closed: Promise<void>;
  private readonly worker: Worker;
  private readonly native = getWindowsBindings();
  private job: bigint;
  private readonly messages = new Set<(reply: BrokerReply) => void>();
  private readonly errors = new Set<(error: Error) => void>();
  private resolveClosed!: () => void;
  private threadId: number | undefined;
  private syncThreadHandle = 0n;
  private cancelTimer: NodeJS.Timeout | undefined;
  private abortError: Error | undefined;
  private jobTerminated = false;
  private brokerDone = false;
  private ending = false;

  constructor(job: bigint, preparedStart?: WindowsStart) {
    this.job = job;
    this.closed = new Promise((resolve) => (this.resolveClosed = resolve));
    try {
      this.worker = new Worker(new URL("./windows-ffi-worker.mts", import.meta.url), {
        workerData: { jobHandle: job, preparedStart },
      });
    } catch (error) {
      this.closeJob();
      throw error;
    }
    this.worker.on("message", (message: FfiWorkerEnvelope) => this.onWorkerMessage(message));
    this.worker.on("error", (error) => this.report(error));
    this.worker.on("exit", (code) => this.onWorkerExit(code));
  }

  onMessage(listener: (reply: BrokerReply) => void): () => void {
    this.messages.add(listener);
    return () => this.messages.delete(listener);
  }

  onError(listener: (error: Error) => void): () => void {
    this.errors.add(listener);
    return () => this.errors.delete(listener);
  }

  async send(request: BrokerRequest): Promise<void> {
    if (request.type === "abort") {
      this.requestAbort(new Error(request.error ?? "PTY transport was aborted"));
      return;
    }
    if (this.ending) throw this.abortError ?? new Error("Windows FFI transport is closed");
    try {
      this.worker.postMessage(request);
    } catch (error) {
      this.report(error);
      throw error;
    }
  }

  async terminate(): Promise<void> {
    if (!this.ending) this.requestAbort(new Error("PTY transport terminated"));
    await this.closed;
  }

  onWorkerMessage(message: FfiWorkerEnvelope): void {
    if (message.kind === "threadId") {
      this.threadId = message.threadId;
      this.openWorkerThreadHandle();
      if (this.abortError) this.cancelSynchronousIo();
    } else if (message.kind === "error") {
      this.report(new Error(message.error));
    } else {
      if (message.reply.type === "brokerDone") this.brokerDone = true;
      for (const listener of this.messages) {
        try {
          listener(message.reply);
        } catch (error) {
          this.report(error);
        }
      }
    }
  }

  onWorkerExit(code: number): void {
    if (this.cancelTimer) clearInterval(this.cancelTimer);
    this.cancelTimer = undefined;
    if (this.syncThreadHandle) {
      try {
        this.native.CloseHandle(this.syncThreadHandle);
      } catch (error) {
        this.report(error);
      }
      this.syncThreadHandle = 0n;
    }
    this.closeJob();
    if (code !== 0 && !this.abortError) {
      this.report(new Error(`Windows FFI worker exited with code ${code}`));
    }
    if (!this.brokerDone && !this.abortError) {
      this.report(new Error("Windows FFI worker exited before brokerDone"));
    }
    this.ending = true;
    this.resolveClosed();
  }

  requestAbort(error: Error): void {
    if (this.ending) return;
    this.ending = true;
    this.abortError = error;
    this.terminateJob();
    try {
      this.worker.postMessage({ type: "abort", error: error.message } satisfies BrokerRequest);
    } catch (cause) {
      this.report(cause);
    }
    this.cancelSynchronousIo();
    this.cancelTimer = setInterval(() => this.cancelSynchronousIo(), 25);
  }

  terminateJob(): void {
    if (this.jobTerminated) return;
    this.jobTerminated = true;
    try {
      if (!this.native.TerminateJobObject(this.job, 1)) {
        this.report(lastError("TerminateJobObject from FFI transport"));
      }
    } catch (error) {
      this.report(error);
    }
  }

  openWorkerThreadHandle(): void {
    if (!this.threadId) return;
    if (this.syncThreadHandle) return;
    try {
      this.syncThreadHandle = this.native.OpenThread(THREAD_TERMINATE, 0, this.threadId) as bigint;
      if (!this.syncThreadHandle) this.report(lastError("OpenThread(FFI worker)"));
    } catch (error) {
      this.report(error);
    }
  }

  cancelSynchronousIo(): void {
    this.openWorkerThreadHandle();
    if (!this.syncThreadHandle) return;
    try {
      if (!this.native.CancelSynchronousIo(this.syncThreadHandle)) {
        const code = this.native.GetLastError();
        if (code !== ERROR_NOT_FOUND)
          this.report(new Error(`CancelSynchronousIo failed with Win32 error ${code}`));
      }
    } catch (error) {
      this.report(error);
    }
  }

  closeJob(): void {
    if (!this.job) return;
    try {
      if (!this.native.CloseHandle(this.job)) {
        this.report(lastError("CloseHandle(job)"));
        return;
      }
      this.job = 0n;
    } catch (error) {
      this.report(error);
    }
  }

  report(value: unknown): void {
    const error = value instanceof Error ? value : new Error(String(value));
    for (const listener of this.errors) {
      try {
        listener(error);
      } catch {
        // Error listeners must not prevent Worker cleanup.
      }
    }
  }
}

export function createFfiWorkerTransport(options: FfiWorkerOptions = {}): WindowsTransport {
  if (process.platform !== "win32") throw new Error("Windows ConPTY FFI requires Windows");
  if (process.arch !== "x64" && process.arch !== "arm64") {
    throw new Error(`Unsupported Windows FFI architecture: ${process.arch}`);
  }
  if (
    options.requireModernOs !== false &&
    classifyWindowsVersion(detectWindowsVersion()) !== "ffi"
  ) {
    throw new Error("Direct Windows FFI requires Windows build 26100 or newer");
  }
  initializeWindowsBindings();
  return new FfiTransport(createKillOnCloseJob(), options.preparedStart);
}

export function createFfiTransport(): WindowsTransport {
  return createFfiWorkerTransport({ requireModernOs: true });
}
