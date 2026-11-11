import assert from "node:assert/strict";
import { PassThrough, Readable } from "node:stream";
import { test } from "node:test";
import type { Backend } from "../../../experiments/ffi-pty/contract.mts";
import { createPtyFromBackend } from "../../../experiments/ffi-pty/events.mts";

function fake(chunks: Buffer[] = [], exitCode = 0, readable: PassThrough | undefined = undefined) {
  let finish!: (value: { exitCode: number | null; signal: number }) => void;
  let fail!: (error: Error) => void;
  const exited = new Promise<{ exitCode: number | null; signal: number }>((resolve, reject) => {
    finish = resolve;
    fail = reject;
  });
  const writes: Buffer[] = [];
  let closeCalls = 0;
  let killCalls = 0;
  let resizeError: Error | undefined;
  const backend: Backend = {
    pid: 42,
    readable: readable ?? Readable.from(chunks),
    write: async (data) => {
      writes.push(data);
    },
    resize: async () => {
      if (resizeError) throw resizeError;
    },
    kill: async () => {
      killCalls++;
    },
    close: async () => {
      closeCalls++;
    },
    exited,
  };
  return {
    backend,
    writes,
    finish: () => finish({ exitCode, signal: 0 }),
    fail,
    get closeCalls() {
      return closeCalls;
    },
    get killCalls() {
      return killCalls;
    },
    set resizeError(error: Error | undefined) {
      resizeError = error;
    },
  };
}

test("preserves split UTF-8 sequences and resolves exit after output drains", async () => {
  const encoded = Buffer.from("héllo 🐸");
  const cut = encoded.indexOf(0xc3) + 1;
  const fakeBackend = fake([encoded.subarray(0, cut), encoded.subarray(cut)]);
  const pty = createPtyFromBackend(fakeBackend.backend, 80, 24);
  let data = "";
  const events: string[] = [];
  pty.onData((chunk) => {
    data += chunk;
    events.push("data");
  });
  pty.onExit(() => events.push("exit"));
  fakeBackend.finish();
  assert.deepEqual(await pty.exited, { exitCode: 0, signal: 0 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(data, "héllo 🐸");
  assert.equal(events.at(-1), "exit");
});

test("pause buffers bounded output until resume; writes preserve buffer bytes", async () => {
  const fakeBackend = fake([Buffer.from("first"), Buffer.from("second")]);
  const pty = createPtyFromBackend(fakeBackend.backend, 80, 24);
  let data = "";
  pty.onData((chunk) => {
    data += chunk;
  });
  pty.pause();
  await pty.write(Buffer.from([0, 255]));
  assert.deepEqual(fakeBackend.writes[0], Buffer.from([0, 255]));
  pty.resume();
  fakeBackend.finish();
  assert.deepEqual(await pty.exited, { exitCode: 0, signal: 0 });
  assert.equal(data, "firstsecond");
});

test("waits for readable EOF after backend exit before resolving exited", async () => {
  const readable = new PassThrough();
  const fakeBackend = fake([], 0, readable);
  const pty = createPtyFromBackend(fakeBackend.backend, 80, 24);
  const output: string[] = [];
  pty.onData((chunk) => output.push(chunk));
  fakeBackend.finish();
  await new Promise((resolve) => setImmediate(resolve));
  let resolved = false;
  void pty.exited.then(() => {
    resolved = true;
  });
  readable.end("last chunk");
  assert.deepEqual(await pty.exited, { exitCode: 0, signal: 0 });
  assert.equal(resolved, true);
  assert.equal(output.join(""), "last chunk");
});

test("waits for backend exit after readable EOF", async () => {
  const readable = new PassThrough();
  const fakeBackend = fake([], 0, readable);
  const pty = createPtyFromBackend(fakeBackend.backend, 80, 24);
  readable.end("eof first");
  await new Promise((resolve) => setImmediate(resolve));
  let resolved = false;
  void pty.exited.then(() => {
    resolved = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(resolved, false);
  await pty.kill("SIGTERM");
  assert.equal(fakeBackend.killCalls, 1, "EOF alone does not prevent terminating a live child");
  fakeBackend.finish();
  assert.deepEqual(await pty.exited, { exitCode: 0, signal: 0 });
});

test("stream errors reject exited and close the backend exactly once", async () => {
  const readable = new PassThrough();
  const fakeBackend = fake([], 0, readable);
  const pty = createPtyFromBackend(fakeBackend.backend, 80, 24);
  readable.destroy(new Error("read failed"));
  await assert.rejects(pty.exited, /read failed/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fakeBackend.closeCalls, 1);
});

test("backend exit rejection rejects exited and closes the backend", async () => {
  const fakeBackend = fake();
  const pty = createPtyFromBackend(fakeBackend.backend, 80, 24);
  fakeBackend.fail(new Error("wait failed"));
  await assert.rejects(pty.exited, /wait failed/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fakeBackend.closeCalls, 1);
});

test("a stream error cannot later emit a successful exit event", async () => {
  const readable = new PassThrough();
  const fakeBackend = fake([], 0, readable);
  const pty = createPtyFromBackend(fakeBackend.backend, 80, 24);
  readable.destroy(new Error("read failed"));
  await assert.rejects(pty.exited, /read failed/);
  fakeBackend.finish();
  let called = false;
  pty.onExit(() => {
    called = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(called, false);
});

test("disposed late exit listeners do not run from the queued callback", async () => {
  const fakeBackend = fake();
  const pty = createPtyFromBackend(fakeBackend.backend, 80, 24);
  fakeBackend.finish();
  // Let the readable end and backend status settle before subscribing.
  await new Promise((resolve) => setImmediate(resolve));
  await pty.exited;
  let called = false;
  const subscription = pty.onExit(() => {
    called = true;
  });
  subscription.dispose();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(called, false);
});

test("close is idempotent and operations reject after natural exit", async () => {
  const fakeBackend = fake();
  const pty = createPtyFromBackend(fakeBackend.backend, 80, 24);
  fakeBackend.finish();
  await pty.exited;
  await assert.rejects(pty.write("late"), /exited/);
  await assert.rejects(pty.resize(90, 30), /exited/);
  await pty.kill("SIGTERM");
  assert.equal(fakeBackend.killCalls, 0);
  await Promise.all([pty.close(), pty.close()]);
  assert.equal(fakeBackend.closeCalls, 1);
  await assert.rejects(pty.write("after close"), /closed/);
});

test("resize updates reported dimensions only when backend resize succeeds", async () => {
  const fakeBackend = fake();
  const pty = createPtyFromBackend(fakeBackend.backend, 80, 24);
  fakeBackend.resizeError = new Error("resize failed");
  await assert.rejects(pty.resize(100, 40), /resize failed/);
  assert.deepEqual([pty.cols, pty.rows], [80, 24]);
  fakeBackend.resizeError = undefined;
  await pty.resize(100, 40);
  assert.deepEqual([pty.cols, pty.rows], [100, 40]);
  fakeBackend.finish();
  await pty.exited;
});
