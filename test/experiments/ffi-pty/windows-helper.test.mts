import assert from "node:assert/strict";
import test from "node:test";
import {
  helperExecutablePath,
  helperStartupEnv,
} from "../../../experiments/ffi-pty/windows-helper.mts";

test("helper process receives only startup environment variables", () => {
  assert.deepEqual(
    helperStartupEnv({
      SystemRoot: "C:\\Windows",
      TEMP: "C:\\Temp",
      PATH: "secret-path",
      NODE_OPTIONS: "--inspect",
    }),
    { SystemRoot: "C:\\Windows", TEMP: "C:\\Temp" },
  );
});

test("helper path is architecture-specific and rejects unsupported targets", () => {
  assert.match(helperExecutablePath("x64"), /win32-x64[\\/]helper\.exe$/);
  assert.match(helperExecutablePath("arm64"), /win32-arm64[\\/]helper\.exe$/);
  assert.throws(() => helperExecutablePath("ia32"), /No Windows helper/);
});
