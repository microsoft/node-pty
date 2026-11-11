import assert from "node:assert/strict";
import { fork, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import {
  helperExecutablePath,
  helperStartupEnv,
} from "../../../experiments/ffi-pty/windows-helper.mts";
import { prepareWindowsStart } from "../../../experiments/ffi-pty/windows-launch.mts";
import {
  decodeHelperFrames,
  decodeHelperReply,
  encodeHelperFrame,
  encodeHelperRequest,
} from "../../../experiments/ffi-pty/windows-helper-protocol.mts";
import type { BrokerReply } from "../../../experiments/ffi-pty/windows-protocol.mts";

const supported = process.platform === "win32" && ["x64", "arm64"].includes(process.arch);
const baseEnv = Object.fromEntries(
  Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
);
const targetOptions = (report: string, exitRoot = false) => {
  const script = `
    const { spawn } = require('node:child_process');
    const fs = require('node:fs');
    const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' });
    fs.writeFileSync(process.env.FFI_PTY_REPORT, JSON.stringify({ pid: process.pid, brokerPid: process.ppid, descendantPid: descendant.pid }));
    ${exitRoot ? "process.exit(0);" : "setInterval(() => {}, 1000);"}
  `;
  return {
    file: process.execPath,
    args: ["-e", script],
    cwd: process.cwd(),
    env: { ...baseEnv, FFI_PTY_REPORT: report },
    cols: 80,
    rows: 24,
  };
};

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out ${label}`)), ms);
    }),
  ]).finally(() => clearTimeout(timer!));
}

async function connectPipe(name: string, sockets: Socket[]): Promise<Socket> {
  return await new Promise((resolve, reject) => {
    const socket = createConnection(name);
    sockets.push(socket);
    socket.on("data", () => {});
    socket.on("error", () => {});
    const connected = () => {
      socket.off("error", failed);
      socket.off("close", closedBeforeConnect);
      resolve(socket);
    };
    const failed = (error: Error) => {
      socket.off("connect", connected);
      socket.off("close", closedBeforeConnect);
      reject(error);
    };
    const closedBeforeConnect = () => {
      socket.off("connect", connected);
      socket.off("error", failed);
      reject(new Error("helper named pipe closed before connection"));
    };
    socket.once("connect", connected);
    socket.once("error", failed);
    socket.once("close", closedBeforeConnect);
  });
}

function waitReply(
  replies: BrokerReply[],
  listeners: Set<(reply: BrokerReply) => void>,
  predicate: (reply: BrokerReply) => boolean,
  ms: number,
  label: string,
) {
  const found = replies.find(predicate);
  if (found) return Promise.resolve(found);
  return new Promise<BrokerReply>((resolve, reject) => {
    const timer = setTimeout(() => {
      listeners.delete(listener);
      reject(new Error(`Timed out ${label}`));
    }, ms);
    const listener = (reply: BrokerReply) => {
      if (!predicate(reply)) return;
      listeners.delete(listener);
      clearTimeout(timer);
      resolve(reply);
    };
    listeners.add(listener);
  });
}

async function startRawHelper(reportPath: string, exitRoot = false) {
  const child = spawn(helperExecutablePath(), [], {
    stdio: ["pipe", "pipe", "ignore"],
    windowsHide: true,
    env: helperStartupEnv(process.env),
  });
  const closed = once(child, "close");
  const sockets: Socket[] = [];
  const replies: BrokerReply[] = [];
  const listeners = new Set<(reply: BrokerReply) => void>();
  let startPrepared: ReturnType<typeof prepareWindowsStart> | undefined;
  let pending = Buffer.alloc(0);
  child.stdout.on("data", (chunk: Buffer) => {
    try {
      const decoded = decodeHelperFrames(Buffer.from(chunk), pending);
      pending = decoded.pending;
      for (const frame of decoded.frames) {
        const reply = decodeHelperReply(frame);
        replies.push(reply);
        for (const listener of listeners) listener(reply);
        if (reply.type === "pipes") {
          if (!startPrepared) throw new Error("PIPES arrived before helper start");
          void Promise.all([
            connectPipe(startPrepared.inputName, sockets),
            connectPipe(startPrepared.outputName, sockets),
          ])
            .then(() => write(child, encodeHelperRequest({ type: "connected" })))
            .catch((error) => child.kill());
        }
      }
    } catch {
      child.kill();
    }
  });
  child.once("error", () => {});
  try {
    await withTimeout(
      once(child, "spawn").then(() => undefined),
      10000,
      "helper startup",
    );
    const options = targetOptions(reportPath, exitRoot);
    const prepared = prepareWindowsStart(options);
    startPrepared = prepared;
    await write(child, encodeHelperRequest({ type: "start", options }, prepared));
    const reply = await waitReply(
      replies,
      listeners,
      (value) => value.type === "spawned" || value.type === "error",
      15000,
      "target startup",
    );
    if (reply.type === "error") throw new Error(reply.error);
    return { child, sockets, pid: reply.pid, replies, listeners, closed };
  } catch (error) {
    await destroySockets(sockets);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await withTimeout(closed, 5000, "failed helper cleanup").catch(() => {});
    }
    throw error;
  }
}

function write(child: ChildProcess, data: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!child.stdin || child.stdin.destroyed) return reject(new Error("helper stdin is closed"));
    child.stdin.write(data, (error) => (error ? reject(error) : resolve()));
  });
}

async function waitReport(path: string) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      const report = JSON.parse(readFileSync(path, "utf8")) as Record<string, number>;
      for (const key of ["pid", "brokerPid", "descendantPid"] as const) {
        assert.ok(
          Number.isSafeInteger(report[key]) && report[key] > 0,
          `invalid ${key}: ${report[key]}`,
        );
      }
      return report as { pid: number; brokerPid: number; descendantPid: number };
    } catch {
      await delay(25);
    }
  }
  throw new Error("target did not write its process report");
}

async function waitDead(pid: number, label: string) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await delay(50);
  }
  assert.fail(`${label} process ${pid} is still alive`);
}

async function waitAlive(pid: number, label: string) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
      return;
    } catch {
      await delay(50);
    }
  }
  assert.fail(`${label} process ${pid} did not become alive`);
}

async function destroySockets(sockets: Socket[]) {
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
}

test(
  "native helper rejects malformed startup framing",
  { skip: !supported, timeout: 10000 },
  async () => {
    const child = spawn(helperExecutablePath(), [], {
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
      env: helperStartupEnv(process.env),
    });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    child.once("error", () => {});
    const closed = once(child, "close");
    await withTimeout(
      once(child, "spawn").then(() => undefined),
      5000,
      "helper startup",
    );
    const invalid = Buffer.alloc(16);
    invalid.writeUInt32LE(0, 0);
    child.stdin.end(invalid);
    const [code] = await withTimeout(closed, 5000, "invalid frame rejection");
    assert.equal(code, 1);
    const decoded = decodeHelperFrames(Buffer.concat(chunks));
    assert.equal(decodeHelperReply(decoded.frames[0]).type, "error");
  },
);

test(
  "helper exits cleanly when the parent disconnects between PIPES and CONNECTED",
  { skip: !supported, timeout: 15000 },
  async () => {
    const child = spawn(helperExecutablePath(), [], {
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
      env: helperStartupEnv(process.env),
    });
    let pending = Buffer.alloc(0);
    let resolvePipes!: () => void;
    const pipes = new Promise<void>((resolve) => {
      resolvePipes = resolve;
    });
    child.stdout.on("data", (chunk: Buffer) => {
      try {
        const decoded = decodeHelperFrames(Buffer.from(chunk), pending);
        pending = decoded.pending;
        if (decoded.frames.some((frame) => decodeHelperReply(frame).type === "pipes"))
          resolvePipes();
      } catch {
        child.kill();
      }
    });
    child.once("error", () => {});
    const closed = once(child, "close");
    await withTimeout(
      once(child, "spawn").then(() => undefined),
      5000,
      "helper startup",
    );
    const options = targetOptions(join(tmpdir(), `ffi-pty-no-connect-${process.pid}.json`));
    try {
      await write(
        child,
        encodeHelperRequest({ type: "start", options }, prepareWindowsStart(options)),
      );
      await withTimeout(pipes, 5000, "helper PIPES reply");
      child.stdin.end();
      const [code] = await withTimeout(closed, 5000, "helper startup abort");
      assert.notEqual(code, null);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await withTimeout(closed, 5000, "helper startup test cleanup").catch(() => {});
    }
  },
);

test(
  "native helper natural target exit kills descendants holding the console",
  { skip: !supported, timeout: 30000 },
  async () => {
    const directory = mkdtempSync(join(tmpdir(), "ffi-pty-helper-natural-"));
    const reportPath = join(directory, "processes.json");
    const { child, sockets, replies, listeners, closed } = await startRawHelper(reportPath, true);
    try {
      const report = await waitReport(reportPath);
      const exited = await waitReply(
        replies,
        listeners,
        (reply) => reply.type === "exited",
        15000,
        "target exit",
      );
      assert.equal(exited.type, "exited");
      await withTimeout(closed, 5000, "natural helper close");
      await waitDead(report.descendantPid, "console descendant");
    } finally {
      await destroySockets(sockets);
      if (child.exitCode === null && child.signalCode === null) child.kill();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test(
  "native helper aborts the job on malformed control while a target is live",
  { skip: !supported, timeout: 30000 },
  async () => {
    const directory = mkdtempSync(join(tmpdir(), "ffi-pty-helper-invalid-control-"));
    const reportPath = join(directory, "processes.json");
    const { child, sockets, closed } = await startRawHelper(reportPath);
    try {
      const report = await waitReport(reportPath);
      await waitAlive(report.pid, "target before malformed control");
      await waitAlive(report.descendantPid, "descendant before malformed control");
      await write(child, encodeHelperFrame(999, 55));
      const [code] = await withTimeout(closed, 10000, "helper abort after malformed control");
      assert.notEqual(code, null);
      await waitDead(report.pid, "target after malformed control");
      await waitDead(report.descendantPid, "descendant after malformed control");
    } finally {
      await destroySockets(sockets);
      if (child.exitCode === null && child.signalCode === null) child.kill();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test(
  "hard helper death closes its job and terminates the target tree",
  { skip: !supported, timeout: 30000 },
  async () => {
    const directory = mkdtempSync(join(tmpdir(), "ffi-pty-helper-death-"));
    const reportPath = join(directory, "processes.json");
    const { child, sockets, pid, replies, listeners, closed } = await startRawHelper(reportPath);
    try {
      const report = await waitReport(reportPath);
      assert.equal(report.pid, pid);
      await waitAlive(report.pid, "target before helper death");
      await waitAlive(report.descendantPid, "descendant before helper death");
      await write(
        child,
        encodeHelperRequest({
          type: "command",
          id: 9,
          command: "resize",
          cols: 92,
          rows: 31,
        }),
      );
      const resizeAck = await waitReply(
        replies,
        listeners,
        (reply) => reply.type === "ack" && reply.id === 9,
        5000,
        "resize acknowledgment",
      );
      assert.deepEqual(resizeAck, { type: "ack", id: 9 });
      child.kill();
      await withTimeout(closed, 10000, "helper process exit");
      await waitDead(report.pid, "target");
      await waitDead(report.descendantPid, "target descendant");
    } finally {
      await destroySockets(sockets);
      if (child.exitCode === null && child.signalCode === null) child.kill();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test(
  "hard parent death cleans up the selected Windows transport",
  { skip: !supported, timeout: 30000 },
  async () => {
    const directory = mkdtempSync(join(tmpdir(), "ffi-pty-parent-death-"));
    const reportPath = join(directory, "processes.json");
    const fixture = fork(
      fileURLToPath(new URL("./windows-parent-death-fixture.mts", import.meta.url)),
      [reportPath],
      { execArgv: ["--experimental-ffi"], stdio: ["ignore", "ignore", "ignore", "ipc"] },
    );
    try {
      await withTimeout(
        new Promise<void>((resolve, reject) => {
          fixture.once("message", (message: any) =>
            message?.type === "started" ? resolve() : reject(new Error("fixture did not start")),
          );
          fixture.once("error", reject);
        }),
        15000,
        "parent fixture startup",
      );
      const report = await waitReport(reportPath);
      await waitAlive(report.pid, "target before parent death");
      await waitAlive(report.descendantPid, "descendant before parent death");
      const parentExit = once(fixture, "close");
      fixture.kill();
      await withTimeout(parentExit, 10000, "fixture process exit");
      await waitDead(report.pid, "target after parent death");
      await waitDead(report.descendantPid, "descendant after parent death");
      await waitDead(report.brokerPid, "transport process after parent death");
    } finally {
      if (fixture.exitCode === null && fixture.signalCode === null) fixture.kill();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
