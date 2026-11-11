import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBackend } from "../../../experiments/ffi-pty/windows.mts";
import {
  getProcessHandleCount,
  initializeWindowsBindings,
} from "../../../experiments/ffi-pty/windows-native.mts";

const supported =
  process.platform === "win32" && (process.arch === "x64" || process.arch === "arm64");
const options = (script: string) => ({
  file: process.execPath,
  args: ["-e", script],
  cwd: process.cwd(),
  env: Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  ),
  cols: 80,
  rows: 24,
});
async function stableHandleCount() {
  let previous = -1;
  let repeated = 0;
  const deadline = Date.now() + 3000;
  const samples: number[] = [];
  while (Date.now() < deadline) {
    const count = getProcessHandleCount();
    samples.push(count);
    repeated = count === previous ? repeated + 1 : 1;
    if (repeated === 3) return count;
    previous = count;
    await delay(50);
  }
  assert.fail(`process handle count did not stabilize within 3s: ${samples}`);
}
async function waitForHandleCount(expected: number, phase: string) {
  const deadline = Date.now() + 5000;
  const samples: number[] = [];
  let consecutive = 0;
  while (Date.now() < deadline) {
    const count = getProcessHandleCount();
    samples.push(count);
    consecutive = count === expected ? consecutive + 1 : 0;
    if (consecutive === 5) return;
    await delay(100);
  }
  assert.fail(
    `process handle count did not return to ${expected} after ${phase}: ${samples.join(",")}`,
  );
}
test(
  "Windows backend releases process handles after normal, forced, and failed sessions",
  { skip: !supported, timeout: 30000 },
  async () => {
    initializeWindowsBindings();
    const warmup = await createBackend(options("process.exit(0)"));
    warmup.readable.resume();
    await warmup.exited;
    await warmup.close();

    const baseline = await stableHandleCount();
    for (let index = 0; index < 3; index++) {
      const natural = await createBackend(options("process.exit(0)"));
      natural.readable.resume();
      await natural.exited;
      await natural.close();
      await waitForHandleCount(baseline, `natural exit ${index}`);

      const forced = await createBackend(options("setInterval(() => {}, 1000)"));
      forced.readable.resume();
      await forced.close();
      await waitForHandleCount(baseline, `forced close ${index}`);

      const missing = join(tmpdir(), `ffi-pty-missing-${process.pid}-${index}`);
      await assert.rejects(createBackend({ ...options(""), cwd: missing }));
      await waitForHandleCount(baseline, `failed startup ${index}`);
    }
    await waitForHandleCount(baseline, "all sessions");
  },
);
