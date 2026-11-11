import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { spawnPty } from "../../../experiments/ffi-pty/pty.mts";
import { normalizeSpawnOptions } from "../../../experiments/ffi-pty/validation.mts";
import { waitForOutputDrain } from "../../../experiments/ffi-pty/unix-common.mts";

const require = createRequire(import.meta.url);

test(
  "closing a PTY cancels a large write when the child is not reading",
  { timeout: 10_000, skip: process.platform === "win32" },
  async () => {
    const code =
      "setInterval(() => {}, 1000); process.stdin.setRawMode(true); process.stdin.pause(); console.log('STALL_READY');";
    const pty = await spawnPty(process.execPath, ["-e", code]);
    let ready!: () => void;
    const readySeen = new Promise<void>((resolve) => (ready = resolve));
    const data = pty.onData((chunk) => {
      if (chunk.includes("STALL_READY")) ready();
    });
    let writeDone = false;
    let writeError: unknown;
    try {
      await readySeen;
      const write = pty.write(Buffer.alloc(7 * 1024 * 1024, 120)).then(
        () => {
          writeDone = true;
        },
        (error: unknown) => {
          writeDone = true;
          writeError = error;
        },
      );
      await delay(50);
      assert.equal(writeDone, false, "the child's input queue should be full");
      let timerRan = false;
      setTimeout(() => (timerRan = true), 0);
      await pty.close();
      const status = await pty.exited;
      await write;
      assert.equal(timerRan, true, "the event loop stays responsive while writing");
      assert.ok(writeError instanceof Error, "close rejects the pending write");
      assert.notEqual(status.signal, 0, "close terminates the stalled child");
    } finally {
      data.dispose();
      await pty.close();
    }
  },
);

test("paused output does not consume the post-exit drain timeout", async () => {
  const readable = new PassThrough();
  let received = "";
  let settled = false;
  readable.on("data", (chunk: Buffer) => (received += chunk.toString()));
  readable.pause();
  const drained = waitForOutputDrain(readable, 25).then((result) => {
    settled = true;
    return result;
  });
  await delay(60);
  assert.equal(settled, false, "the paused interval does not expire the budget");
  readable.resume();
  readable.end(Buffer.from("pending"));
  assert.equal(await drained, true);
  assert.equal(received, "pending");
  for (const event of ["resume", "pause", "end", "close"]) {
    assert.equal(readable.listenerCount(event), 0, `${event} listener is removed`);
  }
});

test("resuming restarts the remaining drain budget", async () => {
  const readable = new PassThrough();
  readable.on("data", () => {});
  let settled = false;
  const startedAt = Date.now();
  const drained = waitForOutputDrain(readable, 80).then((result) => {
    settled = true;
    return result;
  });
  await delay(25);
  readable.pause();
  await delay(100);
  assert.equal(settled, false, "the paused interval does not expire the budget");
  const resumedAt = Date.now();
  readable.resume();
  assert.equal(await drained, false, "a flowing stream expires after its remaining budget");
  const activeDuration = Date.now() - resumedAt;
  assert.ok(activeDuration >= 30, `remaining budget lasted ${activeDuration}ms`);
  assert.ok(Date.now() - startedAt >= 100);
  for (const event of ["resume", "pause", "end", "close"]) {
    assert.equal(readable.listenerCount(event), 0, `${event} listener is removed`);
  }
  readable.destroy();
});

test("unconsumed output still has a bounded drain deadline", async () => {
  const readable = new PassThrough();
  assert.equal(await waitForOutputDrain(readable, 25), false);
  readable.destroy();
});

test(
  "backend close resumes output while paused and remains bounded",
  { timeout: 5000, skip: process.platform === "win32" },
  async () => {
    const code = "process.stdout.write('READY\\n'); setInterval(() => {}, 1000);";
    const input = normalizeSpawnOptions(process.execPath, ["-e", code]);
    const backendFile = process.platform === "darwin" ? "darwin.mts" : "linux.mts";
    const backendModule = require(`../../../experiments/ffi-pty/${backendFile}`) as {
      createBackend(options: typeof input): Promise<{
        pid: number;
        readable: PassThrough;
        close(): Promise<void>;
        exited: Promise<{ exitCode: number | null; signal: number }>;
      }>;
    };
    const backend = await backendModule.createBackend(input);
    let ready!: () => void;
    const readySeen = new Promise<void>((resolve) => (ready = resolve));
    backend.readable.on("data", (chunk: Buffer) => {
      if (chunk.includes("READY")) {
        backend.readable.pause();
        ready();
      }
    });
    try {
      await readySeen;
      await Promise.race([
        backend.close(),
        delay(3000).then(() => {
          throw new Error("close did not finish while output was paused");
        }),
      ]);
      assert.notEqual((await backend.exited).signal, 0);
    } finally {
      await backend.close();
    }
  },
);
