import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildWindowsCommandLine,
  buildWindowsEnvironmentBlock,
  quoteWindowsArgument,
  resolveWindowsExecutable,
  windowsPipeNames,
} from "../../../experiments/ffi-pty/windows-commandline.mts";

test("Windows argument quoting preserves whitespace, quotes, and trailing backslashes", () => {
  assert.equal(quoteWindowsArgument("plain"), "plain");
  assert.equal(quoteWindowsArgument("two words"), '"two words"');
  assert.equal(quoteWindowsArgument('a\\"b'), '"a\\\\\\"b"');
  assert.equal(quoteWindowsArgument("path with space\\"), '"path with space\\\\"');
  assert.equal(
    buildWindowsCommandLine("C:\\Program Files\\shell.exe", ["-c", "echo 🐸"]),
    '"C:\\Program Files\\shell.exe" -c "echo 🐸"',
  );
});
test("Windows command lines reject NULs and empty executable paths", () => {
  assert.throws(() => quoteWindowsArgument("bad\0arg"), /NUL/);
  assert.throws(() => buildWindowsCommandLine("shell.exe", ["bad\0arg"]), /NUL/);
  assert.throws(() => buildWindowsCommandLine("", []), /empty/);
});

test("named pipe paths use the exact local Win32 pipe namespace", () => {
  const names = windowsPipeNames("fixed-id");
  assert.equal(names.input, "\\\\.\\pipe\\node-pty-ffi-fixed-id-in");
  assert.equal(names.output, "\\\\.\\pipe\\node-pty-ffi-fixed-id-out");
  assert.throws(() => windowsPipeNames("bad/name"), /identifier/);
});

test("executable lookup uses case-insensitive child PATH and PATHEXT", () => {
  const resolved = resolveWindowsExecutable(
    "node",
    { pAtH: "C:\\runtime", pathext: ".EXE;.CMD" },
    "C:\\work",
    (candidate) => candidate === "C:\\runtime\\node.EXE",
  );
  assert.equal(resolved, "C:\\runtime\\node.EXE");
  assert.equal(
    resolveWindowsExecutable(
      "node",
      { PATH: "bin", PATHEXT: ".EXE" },
      "C:\\child",
      (candidate) => candidate === "C:\\child\\bin\\node.EXE",
    ),
    "C:\\child\\bin\\node.EXE",
  );
  assert.throws(
    () => resolveWindowsExecutable("missing", { PATH: "C:\\empty" }, "C:\\work", () => false),
    /child PATH/,
  );
  assert.throws(
    () => resolveWindowsExecutable("npm.cmd", {}, "C:\\work", () => true),
    /batch scripts/,
  );
});

test("environment block is UTF-16LE, case-insensitively sorted, and double NUL terminated", () => {
  const block = buildWindowsEnvironmentBlock({
    ZED: "last",
    Path: "C:\\bin",
    A: "🐸",
    "=C:": "C:\\work",
  });
  assert.equal(block.toString("utf16le"), "=C:=C:\\work\0A=🐸\0Path=C:\\bin\0ZED=last\0\0");
});

test("environment entries reject names or values that cannot appear in a block", () => {
  assert.throws(() => buildWindowsEnvironmentBlock({ "bad=name": "x" }), /Invalid/);
  assert.throws(() => buildWindowsEnvironmentBlock({ A: "bad\0value" }), /Invalid/);
  assert.throws(() => buildWindowsEnvironmentBlock({ Path: "a", PATH: "b" }), /Duplicate/);
});
