import { setTimeout as delay } from "node:timers/promises";
import { getRawPointer } from "node:ffi";
import { parentPort, workerData } from "node:worker_threads";
import type { BrokerReply, BrokerRequest } from "./windows-protocol.mts";
import { rehydrateWindowsStart, type FfiWorkerEnvelope } from "./windows-ffi.mts";
import { prepareWindowsStart, type WindowsStart } from "./windows-launch.mts";
import {
  initializeWindowsBindings,
  INVALID_HANDLE_VALUE,
  lastError,
  utf16,
} from "./windows-native.mts";

const NULL = 0n;
const ATTRIBUTE_PSEUDOCONSOLE = 0x00020016n;
const ATTRIBUTE_JOB_LIST = 0x0002000dn;
const CREATE_UNICODE_ENVIRONMENT = 0x00000400;
const EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
const STARTF_USESTDHANDLES = 0x00000100;
const ERROR_PIPE_CONNECTED = 535;
const WAIT_OBJECT_0 = 0;
const WAIT_TIMEOUT = 258;

type Command = Extract<BrokerRequest, { type: "command" }>;

export class FfiSession {
  private resolveStart!: (start: WindowsStart) => void;
  private rejectStart!: (error: Error) => void;
  private readonly startPromise: Promise<WindowsStart>;
  private resolveConnected!: () => void;
  private rejectConnected!: (error: Error) => void;
  private readonly connectedPromise: Promise<void>;
  private commands: Command[] = [];
  private input = 0n;
  private output = 0n;
  private conpty = 0n;
  private job = 0n;
  private processHandle = 0n;
  private threadHandle = 0n;
  private attrs: Buffer | undefined;
  private attrsInitialized = false;
  private attributeValues: Buffer[] = [];
  private started = false;
  private abortError: Error | undefined;
  private ending = false;
  private terminationSignal = 0;
  private readonly startTimer: NodeJS.Timeout;
  private readonly win: ReturnType<typeof initializeWindowsBindings>;
  private readonly sendReply: (reply: BrokerReply) => void;
  private readonly sendError: (error: Error) => void;

  constructor(
    job: bigint,
    win: ReturnType<typeof initializeWindowsBindings>,
    sendReply: (reply: BrokerReply) => void,
    sendError: (error: Error) => void,
    preparedStart?: WindowsStart,
  ) {
    this.job = job;
    this.win = win;
    this.sendReply = sendReply;
    this.sendError = sendError;
    this.startPromise = new Promise<WindowsStart>((resolve, reject) => {
      this.resolveStart = resolve;
      this.rejectStart = reject;
    });
    if (preparedStart) {
      this.started = true;
      this.resolveStart(rehydrateWindowsStart(preparedStart));
    }
    this.connectedPromise = new Promise((resolve, reject) => {
      this.resolveConnected = resolve;
      this.rejectConnected = reject;
    });
    void this.startPromise.catch(() => {});
    void this.connectedPromise.catch(() => {});
    this.startTimer = setTimeout(() => {
      void this.fail(new Error("Timed out connecting ConPTY pipes"));
    }, 15_000);
  }

  async send(request: BrokerRequest): Promise<void> {
    if (this.ending) throw this.abortError ?? new Error("Windows FFI transport is closed");
    if (request.type === "start") {
      if (this.started) throw new Error("Windows FFI transport can only start once");
      this.started = true;
      this.resolveStart(prepareWindowsStart(request.options));
      return;
    }
    if (request.type === "connected") {
      this.resolveConnected();
      return;
    }
    if (request.type === "abort") {
      void this.fail(new Error(request.error ?? "PTY transport was aborted"));
      return;
    }
    this.commands.push(request);
  }

  emit(reply: BrokerReply): void {
    this.sendReply(reply);
  }

  async run(): Promise<void> {
    try {
      const start = await this.waitForStart();
      this.input = this.createPipe(this.win, start.inputName);
      this.output = this.createPipe(this.win, start.outputName);
      this.emit({ type: "pipes", input: start.inputName, output: start.outputName });
      await this.waitForConnected();
      if (this.abortError) throw this.abortError;
      this.connect(this.win, this.input);
      this.connect(this.win, this.output);
      this.createPseudoConsole(this.win, start.cols, start.rows);
      this.createProcess(this.win, start);
      clearTimeout(this.startTimer);
      await this.monitor(this.win);
    } catch (error) {
      await this.fail(error instanceof Error ? error : new Error(String(error)));
    } finally {
      this.ending = true;
      try {
        await this.cleanup();
      } catch (error) {
        this.report(error);
      } finally {
        this.emit({ type: "brokerDone" });
      }
    }
  }

  waitForStart(): Promise<WindowsStart> {
    return this.startPromise;
  }

  waitForConnected(): Promise<void> {
    return this.connectedPromise;
  }

  createPipe(win: any, name: string): bigint {
    const handle = win.CreateNamedPipeW(
      utf16(name),
      0x00000003 | 0x00080000,
      0x00000008,
      1,
      65536,
      65536,
      0,
      NULL,
    ) as bigint;
    if (handle === INVALID_HANDLE_VALUE) throw lastError("CreateNamedPipeW");
    return handle;
  }

  connect(win: any, handle: bigint): void {
    if (win.ConnectNamedPipe(handle, NULL)) return;
    const error = win.GetLastError();
    if (error !== ERROR_PIPE_CONNECTED)
      throw new Error(`ConnectNamedPipe failed with Win32 error ${error}`);
  }

  createPseudoConsole(win: any, cols: number, rows: number): void {
    const size = Buffer.alloc(4);
    size.writeUInt16LE(cols, 0);
    size.writeUInt16LE(rows, 2);
    const result = Buffer.alloc(8);
    const status = win.CreatePseudoConsole(size.readUInt32LE(), this.input, this.output, 0, result);
    if (status !== 0) throw new Error(`CreatePseudoConsole failed with HRESULT ${status}`);
    this.conpty = result.readBigUInt64LE();
  }

  createProcess(win: any, start: ReturnType<typeof prepareWindowsStart>): void {
    const size = Buffer.alloc(8);
    win.InitializeProcThreadAttributeList(NULL, 2, 0, size);
    const bytes = size.readBigUInt64LE();
    if (!bytes || bytes > 65536n) throw new Error("Invalid process attribute list size");
    this.attrs = Buffer.alloc(Number(bytes));
    if (!win.InitializeProcThreadAttributeList(this.attrs, 2, 0, size))
      throw lastError("InitializeProcThreadAttributeList");
    this.attrsInitialized = true;
    if (
      !win.UpdateProcThreadAttribute(
        this.attrs,
        0,
        ATTRIBUTE_PSEUDOCONSOLE,
        this.conpty,
        8n,
        NULL,
        NULL,
      )
    ) {
      throw lastError("UpdateProcThreadAttribute(PSEUDOCONSOLE)");
    }
    const jobValue = Buffer.alloc(8);
    jobValue.writeBigUInt64LE(this.job);
    this.attributeValues.push(jobValue);
    if (
      !win.UpdateProcThreadAttribute(this.attrs, 0, ATTRIBUTE_JOB_LIST, jobValue, 8n, NULL, NULL)
    ) {
      throw lastError("UpdateProcThreadAttribute(JOB_LIST)");
    }
    const startup = Buffer.alloc(112);
    startup.writeUInt32LE(112, 0);
    startup.writeUInt32LE(STARTF_USESTDHANDLES, 60);
    const startupEx = Buffer.from(startup);
    const attrPointer = Buffer.alloc(8);
    attrPointer.writeBigUInt64LE(getRawPointer(this.attrs));
    attrPointer.copy(startupEx, 104);
    const info = Buffer.alloc(24);
    const created = win.CreateProcessW(
      start.application,
      start.commandLine,
      NULL,
      NULL,
      0,
      EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT,
      start.environment,
      start.cwd,
      startupEx,
      info,
    );
    if (!created) throw lastError("CreateProcessW");
    this.processHandle = info.readBigUInt64LE(0);
    this.threadHandle = info.readBigUInt64LE(8);
    this.emit({ type: "spawned", pid: info.readUInt32LE(16) });
    this.closeHandle(win, this.threadHandle, "CloseHandle(thread)");
    this.threadHandle = 0n;
    // Keep attrs and jobValue alive until DeleteProcThreadAttributeList below.
    this.deleteAttributes(win);
    this.closeHandle(win, this.input, "CloseHandle(input pipe)");
    this.input = 0n;
    this.closeHandle(win, this.output, "CloseHandle(output pipe)");
    this.output = 0n;
  }

  async monitor(win: any): Promise<void> {
    while (true) {
      const status = win.WaitForSingleObject(this.processHandle, 0);
      if (status !== WAIT_OBJECT_0 && status !== WAIT_TIMEOUT)
        throw lastError("WaitForSingleObject");
      if (this.abortError) {
        if (status !== WAIT_OBJECT_0 && this.job) {
          if (!win.TerminateJobObject(this.job, 1)) {
            throw lastError("TerminateJobObject after abort");
          }
          this.terminationSignal = 1;
        }
        throw this.abortError;
      }
      if (status === WAIT_OBJECT_0) break;
      const request = this.commands.shift();
      if (request) this.runCommand(win, request);
      await delay(10);
    }
    const exit = Buffer.alloc(4);
    if (!win.GetExitCodeProcess(this.processHandle, exit)) throw lastError("GetExitCodeProcess");
    if (!win.TerminateJobObject(this.job, 1)) {
      throw lastError("TerminateJobObject after target exit");
    }
    this.closeHandle(win, this.processHandle, "CloseHandle(process)");
    this.processHandle = 0n;
    win.ClosePseudoConsole(this.conpty);
    this.conpty = 0n;
    this.emit({ type: "exited", exitCode: exit.readUInt32LE(), signal: this.terminationSignal });
  }

  runCommand(win: any, request: Command): void {
    try {
      if (request.command === "resize") {
        const size = Buffer.alloc(4);
        size.writeUInt16LE(request.cols, 0);
        size.writeUInt16LE(request.rows, 2);
        const result = win.ResizePseudoConsole(this.conpty, size.readUInt32LE());
        if (result !== 0) throw new Error(`ResizePseudoConsole failed with HRESULT ${result}`);
      } else if (request.command === "kill" || request.command === "close") {
        if (!win.TerminateJobObject(this.job, 1)) throw lastError("TerminateJobObject");
        this.terminationSignal = request.command === "close" ? 1 : request.signal;
      }
      this.emit({ type: "ack", id: request.id });
    } catch (error) {
      this.emit({ type: "ack", id: request.id, error: String(error) });
    }
  }

  async fail(error: Error): Promise<void> {
    if (this.ending) return;
    this.ending = true;
    this.abortError = error;
    clearTimeout(this.startTimer);
    this.rejectStart(error);
    this.rejectConnected(error);
    if (this.job) {
      try {
        this.win.TerminateJobObject(this.job, 1);
      } catch {
        // The main thread closes its kill-on-close job after this worker exits.
      }
    }
    this.report(error);
  }

  deleteAttributes(win: any): void {
    if (this.attrsInitialized && this.attrs) win.DeleteProcThreadAttributeList(this.attrs);
    this.attrsInitialized = false;
    this.attrs = undefined;
    this.attributeValues = [];
  }

  report(value: unknown): void {
    const error = value instanceof Error ? value : new Error(String(value));
    this.sendError(error);
  }

  closeHandle(win: any, handle: bigint, operation: string): void {
    if (handle && !win.CloseHandle(handle)) throw lastError(operation);
  }

  async cleanup(): Promise<void> {
    const win = this.win;
    if (this.job && this.processHandle) {
      try {
        win.TerminateJobObject(this.job, 1);
      } catch (error) {
        this.report(error);
      }
    } else if (this.processHandle) {
      try {
        win.TerminateProcess(this.processHandle, 1);
      } catch (error) {
        this.report(error);
      }
    }
    if (this.processHandle) {
      const deadline = Date.now() + 500;
      while (Date.now() < deadline) {
        const status = win.WaitForSingleObject(this.processHandle, 0);
        if (status === WAIT_OBJECT_0) break;
        if (status !== WAIT_TIMEOUT) {
          this.report(lastError("WaitForSingleObject(cleanup)"));
          break;
        }
        await delay(10);
      }
    }
    if (this.attrsInitialized) this.deleteAttributes(win);
    for (const [handle, label] of [
      [this.threadHandle, "thread"],
      [this.processHandle, "process"],
      [this.input, "input pipe"],
      [this.output, "output pipe"],
    ] as const) {
      if (handle) {
        try {
          this.closeHandle(win, handle, `CloseHandle(${label} cleanup)`);
        } catch (error) {
          this.report(error);
        }
      }
    }
    this.threadHandle = this.processHandle = this.input = this.output = 0n;
    if (this.conpty) {
      try {
        win.ClosePseudoConsole(this.conpty);
      } catch (error) {
        this.report(error);
      }
      this.conpty = 0n;
    }
  }
}

const port = parentPort;
if (!port) throw new Error("Windows FFI lifecycle must run in a Worker");

try {
  const win = initializeWindowsBindings();
  const session = new FfiSession(
    workerData.jobHandle as bigint,
    win,
    (reply) => port.postMessage({ kind: "reply", reply } satisfies FfiWorkerEnvelope),
    (error) =>
      port.postMessage({ kind: "error", error: error.message } satisfies FfiWorkerEnvelope),
    workerData.preparedStart as WindowsStart | undefined,
  );
  port.postMessage({
    kind: "threadId",
    threadId: win.GetCurrentThreadId(),
  } satisfies FfiWorkerEnvelope);
  port.on("message", (request: BrokerRequest) => {
    void session.send(request).catch((error) => session.report(error));
  });
  void session.run().finally(() => port.close());
} catch (error) {
  port.postMessage({
    kind: "error",
    error: error instanceof Error ? error.message : String(error),
  } satisfies FfiWorkerEnvelope);
  port.postMessage({ kind: "reply", reply: { type: "brokerDone" } } satisfies FfiWorkerEnvelope);
  port.close();
}
