import { rmSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { createFfiTransport } from "../../../experiments/ffi-pty/windows-ffi.mts";
import {
  getWindowsBindings,
  INVALID_HANDLE_VALUE,
  utf16,
} from "../../../experiments/ffi-pty/windows-native.mts";
import type { SpawnOptions } from "../../../experiments/ffi-pty/contract.mts";
import type { BrokerReply } from "../../../experiments/ffi-pty/windows-protocol.mts";

const report = process.argv[2];
if (!report) throw new Error("Probe needs a backpressure report path");
const options: SpawnOptions = {
  file: process.execPath,
  args: [
    "-e",
    "const chunk=Buffer.alloc(16384,120); setInterval(()=>process.stdout.write(chunk),0);",
  ],
  cwd: process.cwd(),
  env: Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  ),
  cols: 80,
  rows: 24,
};

const transport = createFfiTransport();
const native = getWindowsBindings();
let inputPipe = 0n;
let outputPipe = 0n;
let heartbeatTimer: NodeJS.Timeout | undefined;
let cancelTimer: NodeJS.Timeout | undefined;
let ackMonitor: NodeJS.Timeout | undefined;
let resizeAcks = 0;
let resizeCount = 0;
let cancellationStarted = false;
let lastAckAt = Date.now();
const ACK_STALL_MS = 1500;

function signalPipeBufferSize(): number {
  const native = getWindowsBindings();
  const read = Buffer.alloc(8);
  const write = Buffer.alloc(8);
  if (!native.CreatePipe(read, write, 0n, 0)) {
    throw new Error(`CreatePipe failed with Win32 error ${native.GetLastError()}`);
  }
  const readHandle = read.readBigUInt64LE();
  const writeHandle = write.readBigUInt64LE();
  try {
    const outSize = Buffer.alloc(4);
    const inSize = Buffer.alloc(4);
    if (!native.GetNamedPipeInfo(readHandle, 0n, outSize, inSize, 0n)) {
      throw new Error(`GetNamedPipeInfo failed with Win32 error ${native.GetLastError()}`);
    }
    return Math.max(outSize.readUInt32LE(), inSize.readUInt32LE());
  } finally {
    native.CloseHandle(readHandle);
    native.CloseHandle(writeHandle);
  }
}

const signalBufferBytes = signalPipeBufferSize();
resizeCount = Math.max(1500, Math.ceil(signalBufferBytes / 6) + 64);

function openPipe(path: string, access: number): bigint {
  const handle = native.CreateFileW(utf16(path), access, 0, 0n, 3, 0, 0n) as bigint;
  if (!handle || handle === INVALID_HANDLE_VALUE) {
    throw new Error(`CreateFileW(${path}) failed with Win32 error ${native.GetLastError()}`);
  }
  return handle;
}

function peekOutput(): number {
  const available = Buffer.alloc(4);
  if (!native.PeekNamedPipe(outputPipe, 0n, 0, 0n, available, 0n)) {
    throw new Error(`PeekNamedPipe failed with Win32 error ${native.GetLastError()}`);
  }
  return available.readUInt32LE();
}

function outputPipeCapacity(): number {
  const size = Buffer.alloc(4);
  if (!native.GetNamedPipeInfo(outputPipe, 0n, size, 0n, 0n)) {
    throw new Error(`GetNamedPipeInfo(output) failed with Win32 error ${native.GetLastError()}`);
  }
  const capacity = size.readUInt32LE();
  if (capacity === 0) throw new Error("ConPTY output pipe reported a zero buffer capacity");
  return capacity;
}

function closePipeHandles(): void {
  if (outputPipe) native.CloseHandle(outputPipe);
  if (inputPipe) native.CloseHandle(inputPipe);
  outputPipe = inputPipe = 0n;
}

function requestCancellation(): void {
  if (cancellationStarted) return;
  cancellationStarted = true;
  if (ackMonitor) clearInterval(ackMonitor);
  if (cancelTimer) clearTimeout(cancelTimer);
  process.stdout.write("CANCELLING\n");
  const stopping = transport.terminate();
  closePipeHandles();
  void stopping.then(() => {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    process.stdout.write("CANCELLED\n");
  });
}

async function waitForSaturation(capacity: number): Promise<number> {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const available = peekOutput();
    if (available >= capacity) return available;
    await delay(20);
  }
  throw new Error(`ConPTY output pipe did not fill to its ${capacity} byte quota`);
}

transport.onError((error) => {
  if (cancellationStarted && error.message === "PTY transport terminated") return;
  process.stderr.write(`ERROR ${error.message}\n`);
});
transport.onMessage((reply: BrokerReply) => {
  if (reply.type === "pipes") {
    try {
      inputPipe = openPipe(reply.input, 0x40000000);
      outputPipe = openPipe(reply.output, 0x80000000);
      void transport.send({ type: "connected" });
    } catch (error) {
      process.stderr.write(`ERROR ${String(error)}\n`);
      void transport.send({ type: "abort", error: String(error) });
    }
  } else if (reply.type === "spawned") {
    void (async () => {
      const capacity = outputPipeCapacity();
      const outputBytes = await waitForSaturation(capacity);
      process.stdout.write(
        `BURST ${resizeCount} ${signalBufferBytes} ${capacity} ${outputBytes}\n`,
      );
      heartbeatTimer = setInterval(() => process.stdout.write("HEARTBEAT\n"), 50);
      for (let id = 1; id <= resizeCount; id++) {
        void transport.send({
          type: "command",
          id,
          command: "resize",
          cols: 80 + (id % 40),
          rows: 24 + (id % 20),
        });
      }
      const minAcks = Math.min(
        resizeCount - 1,
        Math.max(100, Math.ceil(signalBufferBytes / 6) - 64),
      );
      ackMonitor = setInterval(() => {
        if (resizeAcks >= minAcks && Date.now() - lastAckAt >= ACK_STALL_MS) {
          process.stdout.write(`ACKSTALL ${resizeAcks}\n`);
          requestCancellation();
        }
      }, 100);
      cancelTimer = setTimeout(
        () => {
          process.stderr.write(`RESIZE_ACKS_DID_NOT_STALL ${resizeAcks}\n`);
          requestCancellation();
        },
        resizeCount * 10 + 5000,
      );
    })().catch((error) => {
      process.stderr.write(`ERROR ${String(error)}\n`);
      void transport.send({ type: "abort", error: String(error) });
    });
  } else if (reply.type === "ack") {
    if (!reply.error) {
      resizeAcks++;
      lastAckAt = Date.now();
      return;
    }
    if (reply.error) {
      const match = /HRESULT (-?\d+)/.exec(reply.error);
      const hresult = match ? Number(match[1]) >>> 0 : 0;
      const expectedCancel =
        cancellationStarted && (hresult & 0x8000_0000) !== 0 && (hresult & 0xffff) === 995;
      if (!expectedCancel) process.stderr.write(`ACK_ERROR ${reply.error}\n`);
    }
  }
});

try {
  await transport.ready;
  await transport.send({ type: "start", options });
  await transport.closed;
  process.stdout.write("DONE\n");
} finally {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  if (cancelTimer) clearTimeout(cancelTimer);
  if (ackMonitor) clearInterval(ackMonitor);
  await transport.terminate();
  closePipeHandles();
  rmSync(report, { force: true });
}
