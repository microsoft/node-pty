import assert from "node:assert/strict";
import { test } from "node:test";
import {
  asError,
  createWindowsTransport,
  promiseWithTimeout,
} from "../../../experiments/ffi-pty/windows.mts";

test("asError preserves Error instances and wraps other failures", () => {
  const original = new Error("native failure");
  assert.equal(asError(original), original);
  assert.equal(asError("native failure").message, "native failure");
});

test("Windows transport selector rejects versions below the ConPTY minimum", async () => {
  await assert.rejects(
    createWindowsTransport({ major: 10, minor: 0, build: 17762 }),
    /does not support ConPTY/,
  );
});

test("promiseWithTimeout preserves rejection and clears its timer", async () => {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const scheduled = new Set<ReturnType<typeof setTimeout>>();
  const cleared = new Set<ReturnType<typeof setTimeout>>();
  const globals = globalThis as unknown as {
    setTimeout: typeof setTimeout;
    clearTimeout: typeof clearTimeout;
  };
  globals.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
    const timer = originalSetTimeout(...args);
    scheduled.add(timer);
    return timer;
  }) as typeof setTimeout;
  globals.clearTimeout = ((timer: ReturnType<typeof setTimeout>) => {
    if (scheduled.has(timer)) cleared.add(timer);
    originalClearTimeout(timer);
  }) as typeof clearTimeout;

  try {
    const original = new Error("startup failed");
    await assert.rejects(
      promiseWithTimeout(Promise.reject(original), 1000, "timeout"),
      (error) => error === original,
    );
    assert.equal(cleared.size, 1);
    assert.equal(await promiseWithTimeout(Promise.resolve(42), 1000, "timeout"), 42);
    assert.equal(cleared.size, 2);
  } finally {
    globals.setTimeout = originalSetTimeout;
    globals.clearTimeout = originalClearTimeout;
  }
});
