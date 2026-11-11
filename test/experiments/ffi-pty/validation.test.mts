import assert from "node:assert/strict";
import { test } from "node:test";
import { isAbsolute } from "node:path";
import {
  normalizeSpawnOptions,
  validateDimension,
  validateNativeString,
} from "../../../experiments/ffi-pty/validation.mts";

test("normalizes defaults and copies the requested arguments", () => {
  const args = ["-c", "echo ok"];
  const options = normalizeSpawnOptions("sh", args, { env: { PATH: "/bin" } });
  args.push("later");
  assert.deepEqual(options.args, ["-c", "echo ok"]);
  assert.equal(options.cols, 80);
  assert.equal(options.rows, 24);
  assert.equal(options.env.TERM, "xterm-256color");
  assert.equal(isAbsolute(options.cwd), true);
});

test("rejects unsupported options and invalid native strings before allocation", () => {
  assert.throws(() => normalizeSpawnOptions("sh", [], { uid: 10 }), /Unsupported/);
  assert.throws(() => normalizeSpawnOptions("sh", ["bad\0arg"]), /NUL/);
  assert.throws(() => normalizeSpawnOptions("sh", [], { cols: 32768 }), /32767/);
  assert.throws(() => normalizeSpawnOptions("sh", [], { encoding: "latin1" }), /UTF-8/);
  assert.throws(() => normalizeSpawnOptions("sh", [], { env: { "BAD=NAME": "x" } }), /Invalid/);
});

test("native string and dimension validators accept supported boundary values", () => {
  assert.equal(validateNativeString("ok", "value"), undefined);
  assert.equal(validateDimension(32767, "cols"), undefined);
  assert.throws(() => validateNativeString("bad\0value", "value"), /NUL/);
  assert.throws(() => validateDimension(0, "rows"), /1 to 32767/);
});
