import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  assertNotReparsePoint,
  closeWindowsHandlePair,
  lockWindowsHelper,
  type LockBindings,
} from "../../../experiments/ffi-pty/windows-helper-lock.mts";

function fakeBindings(attributes: number[], failInfoAt = 0) {
  let infoCalls = 0;
  let next = 1n;
  const closed: bigint[] = [];
  const native: LockBindings = {
    CreateFileW() {
      return next++;
    },
    GetFileInformationByHandle(handle, info) {
      infoCalls++;
      if (infoCalls === failInfoAt) return 0;
      info.writeUInt32LE(attributes[Number(handle) - 1] ?? 0, 0);
      return 1;
    },
    CloseHandle(handle) {
      closed.push(handle);
      return 1;
    },
    GetLastError() {
      return 5;
    },
  };
  return { native, closed };
}

test(
  "helper lock releases file and directory handles exactly once",
  { skip: process.platform !== "win32" },
  () => {
    const directory = mkdtempSync(join(tmpdir(), "pty-lock-"));
    const helper = join(directory, "helper.exe");
    writeFileSync(helper, "placeholder");
    try {
      const { native, closed } = fakeBindings([0x10, 0]);
      const lock = lockWindowsHelper(helper, native);
      lock.release();
      lock.release();
      assert.deepEqual(closed, [2n, 1n]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test(
  "helper lock closes both handles if file inspection fails",
  { skip: process.platform !== "win32" },
  () => {
    const directory = mkdtempSync(join(tmpdir(), "pty-lock-"));
    const helper = join(directory, "helper.exe");
    writeFileSync(helper, "placeholder");
    try {
      const { native, closed } = fakeBindings([0x10, 0], 2);
      assert.throws(() => lockWindowsHelper(helper, native), /GetFileInformationByHandle/);
      assert.deepEqual(closed, [2n, 1n]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test(
  "helper lock rejects a reparse parent and closes its handle",
  { skip: process.platform !== "win32" },
  () => {
    const directory = mkdtempSync(join(tmpdir(), "pty-lock-"));
    const helper = join(directory, "helper.exe");
    writeFileSync(helper, "placeholder");
    try {
      const { native, closed } = fakeBindings([0x10 | 0x400]);
      assert.throws(() => lockWindowsHelper(helper, native), /reparse point/);
      assert.deepEqual(closed, [1n]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test("reparse attributes are rejected", () => {
  assert.throws(() => assertNotReparsePoint(0x400, "helper.exe"), /reparse point/);
  assert.doesNotThrow(() => assertNotReparsePoint(0, "helper.exe"));
});

test("both handles are closed even when closing the first fails", () => {
  const closed: bigint[] = [];
  const native = fakeBindings([0, 0]).native;
  native.CloseHandle = (handle) => {
    closed.push(handle);
    if (handle === 1n) throw new Error("simulated close failure");
    return 1;
  };
  assert.throws(() => closeWindowsHandlePair(native, 1n, 2n), /simulated close failure/);
  assert.deepEqual(closed, [1n, 2n]);
});
