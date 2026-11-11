import assert from "node:assert/strict";
import test from "node:test";
import {
  quoteResponsePath,
  targetArchitecture,
} from "../../../experiments/ffi-pty/build-windows-helper.mts";

test("helper build target honors explicit and npm architecture selection", () => {
  assert.equal(targetArchitecture(["--arch=arm64"], {}), "arm64");
  assert.equal(targetArchitecture([], { npm_config_arch: "x64" }), "x64");
  assert.equal(targetArchitecture([], { ARCH: "arm64" }), "arm64");
  assert.throws(() => targetArchitecture(["--arch=ia32"], {}), /supports x64 and arm64/);
});

test("MSVC response paths stay quoted without trailing slash escapes", () => {
  assert.equal(
    quoteResponsePath("C:\\Program Files\\VS\\cl.exe"),
    '"C:\\Program Files\\VS\\cl.exe"',
  );
  assert.equal(quoteResponsePath("C:\\build\\out/"), '"C:\\build\\out/"');
  assert.throws(() => quoteResponsePath('C:\\bad"path'), /may not contain quotes/);
});
