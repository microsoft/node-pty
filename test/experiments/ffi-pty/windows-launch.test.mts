import assert from "node:assert/strict";
import { test } from "node:test";
import {
  encodeWindowsString,
  prepareWindowsStart,
} from "../../../experiments/ffi-pty/windows-launch.mts";
import type { SpawnOptions } from "../../../experiments/ffi-pty/contract.mts";

test("Windows strings are UTF-16LE terminated and reject embedded NUL", () => {
  const encoded = encodeWindowsString("frog 🐸");
  assert.equal(encoded.toString("utf16le"), "frog 🐸\0");
  assert.equal(encoded.readUInt16LE(encoded.length - 2), 0);
  assert.throws(() => encodeWindowsString("bad\0value"), /NUL/);
});

test("launch preparation validates dimensions before executable lookup", () => {
  const options = {
    file: "missing.exe",
    args: [],
    cols: 0,
    rows: 24,
    cwd: "C:\\work",
    env: {},
  };
  assert.throws(() => prepareWindowsStart(options), /cols must be an integer/);
});

test(
  "Windows launch data contains resolved executable, arguments, environment, and fresh pipes",
  { skip: process.platform !== "win32" },
  () => {
    const options: SpawnOptions = {
      file: process.execPath,
      args: ["-e", "console.log('ok')"],
      cols: 101,
      rows: 37,
      cwd: process.cwd(),
      env: Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      ),
    };
    const first = prepareWindowsStart(options);
    const second = prepareWindowsStart(options);
    assert.equal(first.cols, options.cols);
    assert.equal(first.rows, options.rows);
    assert.match(first.application.toString("utf16le"), /\.exe\0$/i);
    assert.match(first.commandLine.toString("utf16le"), /console\.log\('ok'\)\0$/);
    assert.equal(first.cwd.toString("utf16le"), `${options.cwd}\0`);
    assert.ok(first.environment.toString("utf16le").endsWith("\0\0"));
    assert.notEqual(first.inputName, second.inputName);
    assert.notEqual(first.outputName, second.outputName);
  },
);
