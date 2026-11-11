import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { createConnection, type Socket } from "node:net";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  createKillOnCloseJob,
  createFfiTransport,
  rehydrateWindowsStart,
} from "../../../experiments/ffi-pty/windows-ffi.mts";
import type { WindowsStart } from "../../../experiments/ffi-pty/windows-launch.mts";
import type { SpawnOptions } from "../../../experiments/ffi-pty/contract.mts";
import type { BrokerReply } from "../../../experiments/ffi-pty/windows-protocol.mts";
import {
  classifyWindowsVersion,
  detectWindowsVersion,
} from "../../../experiments/ffi-pty/windows-version.mts";

const modern =
  process.platform === "win32" && classifyWindowsVersion(detectWindowsVersion()) === "ffi";

test("direct transport factory refuses non-Windows systems before loading kernel32", () => {
  if (process.platform === "win32") return;
  assert.throws(() => createFfiTransport(), /requires Windows/);
});

test("rehydrates structured-cloned launch bytes into Buffers before Win32 FFI", () => {
  const start = {
    cols: 80,
    rows: 24,
    application: Uint8Array.from([65, 0]),
    commandLine: Uint8Array.from([66, 0]),
    cwd: Uint8Array.from([67, 0]),
    environment: Uint8Array.from([0, 0]),
    inputName: "in",
    outputName: "out",
  } as unknown as WindowsStart;
  const result = rehydrateWindowsStart(start);
  for (const field of ["application", "commandLine", "cwd", "environment"] as const) {
    assert.ok(Buffer.isBuffer(result[field]));
    assert.deepEqual([...result[field]], [...start[field]]);
  }
});

test("main thread creates and configures its kill-on-close job", () => {
  let configured: Buffer | undefined;
  let closed = false;
  const native = {
    CreateJobObjectW: () => 42n,
    SetInformationJobObject: (_job: bigint, _class: number, info: Buffer) => {
      configured = info;
      return 1;
    },
    CloseHandle: () => {
      closed = true;
      return 1;
    },
  };
  assert.equal(createKillOnCloseJob(native as never), 42n);
  assert.equal(configured?.length, 144);
  assert.equal(configured?.readUInt32LE(16), 0x00002000);
  assert.equal(closed, false);
});

test(
  "direct FFI starts in this process and keeps the event loop responsive",
  { skip: !modern, timeout: 30000 },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "ffi-pty-direct-"));
    const report = join(dir, "child.json");
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    );
    const options: SpawnOptions = {
      file: process.execPath,
      args: [
        "-e",
        `require('node:fs').writeFileSync(${JSON.stringify(report)}, JSON.stringify({pid:process.pid,ppid:process.ppid})); setInterval(()=>{},1000)`,
      ],
      cwd: process.cwd(),
      env,
      cols: 80,
      rows: 24,
    };
    const transport = createFfiTransport();
    const sockets: Socket[] = [];
    let serial = 0;
    const replies: BrokerReply[] = [];
    transport.onMessage((reply) => {
      replies.push(reply);
      if (reply.type === "pipes") {
        for (const path of [reply.input, reply.output]) {
          const socket = createConnection(path);
          sockets.push(socket);
        }
        void Promise.all(
          sockets.map(
            (socket) =>
              new Promise<void>((resolve, reject) => {
                socket.once("connect", resolve);
                socket.once("error", reject);
              }),
          ),
        ).then(() => transport.send({ type: "connected" }));
      }
    });
    try {
      await transport.ready;
      await transport.send({ type: "start", options });
      const deadline = Date.now() + 5000;
      let child: { pid: number; ppid: number } | undefined;
      while (Date.now() < deadline) {
        try {
          child = JSON.parse(readFileSync(report, "utf8")) as { pid: number; ppid: number };
          break;
        } catch {
          await delay(10);
        }
      }
      assert.ok(child, "target did not write its process report");
      assert.equal(
        child.ppid,
        process.pid,
        "CreateProcess should spawn directly from this process",
      );
      let heartbeat = 0;
      const timer = setInterval(() => heartbeat++, 10);
      await delay(100);
      clearInterval(timer);
      assert.ok(heartbeat >= 5, `event loop heartbeat only advanced ${heartbeat} times`);
      await transport.send({ type: "command", id: ++serial, command: "close" });
      await transport.closed;
      assert.ok(replies.some((reply) => reply.type === "exited"));
    } finally {
      await transport.terminate();
      await Promise.all(
        sockets.map(
          (socket) =>
            new Promise<void>((resolve) => {
              if (socket.closed) return resolve();
              socket.once("close", resolve);
              socket.destroy();
            }),
        ),
      );
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
