import assert from "node:assert/strict";
import { test } from "node:test";
import {
  classifyWindowsVersion,
  detectWindowsVersion,
  isValidWindowsVersion,
  parseWindowsVersion,
} from "../../../experiments/ffi-pty/windows-version.mts";

test("parses Windows version strings and optional revision numbers", () => {
  assert.deepEqual(parseWindowsVersion("10.0.22631"), { major: 10, minor: 0, build: 22631 });
  assert.deepEqual(parseWindowsVersion("10.0.26100.1"), { major: 10, minor: 0, build: 26100 });
  for (const invalid of ["", "Windows 11", "10.0", "10.x.26100", "10.0.4294967296"]) {
    assert.throws(() => parseWindowsVersion(invalid), /Invalid Windows version/);
  }
});

test("classifies Windows build boundaries for ConPTY and direct FFI", () => {
  const cases = [
    [[10, 0, 17762], "unsupported"],
    [[10, 0, 17763], "helper"],
    [[10, 0, 22000], "helper"],
    [[10, 0, 22621], "helper"],
    [[10, 0, 22631], "helper"],
    [[10, 0, 26099], "helper"],
    [[10, 0, 26100], "ffi"],
    [[10, 0, 26200], "ffi"],
    [[10, 0, 20348], "helper"],
  ] as const;
  for (const [[major, minor, build], expected] of cases) {
    assert.equal(classifyWindowsVersion({ major, minor, build }), expected, `build ${build}`);
  }
  assert.equal(classifyWindowsVersion({ major: 6, minor: 3, build: 9600 }), "unsupported");
});

test("validates parsed Windows version fields", () => {
  assert.equal(isValidWindowsVersion({ major: 10, minor: 0, build: 26100 }), true);
  assert.equal(isValidWindowsVersion({ major: 10, minor: -1, build: 26100 }), false);
  assert.equal(isValidWindowsVersion({ major: 10, minor: 0, build: Number.NaN }), false);
  assert.throws(
    () => classifyWindowsVersion({ major: 10, minor: 0, build: -1 }),
    /Invalid Windows version fields/,
  );
});

test("version detection rejects calls away from Windows", () => {
  assert.throws(() => detectWindowsVersion("linux"), /requires Windows/);
});
