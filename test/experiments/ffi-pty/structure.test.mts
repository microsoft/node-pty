import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

test("FFI PTY source modules stay at or below 500 lines", () => {
  const root = fileURLToPath(new URL("../../../experiments/ffi-pty/", import.meta.url));
  const extensions = new Set([".mts", ".cc", ".cpp", ".h", ".hpp"]);
  const sources: string[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (extensions.has(entry.name.slice(entry.name.lastIndexOf(".")))) sources.push(path);
    }
  };
  visit(root);
  const oversized = sources
    .map((path) => {
      const source = readFileSync(path, "utf8");
      const lines = source.split(/\r?\n/).length - (source.endsWith("\n") ? 1 : 0);
      return { path: path.slice(root.length), lines };
    })
    .filter(({ lines }) => lines > 500);
  assert.deepEqual(oversized, [], "split large modules into focused files");
});

test("FFI PTY MTS modules use Node's supported type-erasure syntax", () => {
  const root = fileURLToPath(new URL("../../../experiments/ffi-pty/", import.meta.url));
  const sources: string[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.name.endsWith(".mts")) sources.push(path);
    }
  };
  visit(root);
  for (const path of sources) {
    assert.doesNotThrow(
      () => stripTypeScriptTypes(readFileSync(path, "utf8"), { mode: "strip" }),
      undefined,
      path.slice(root.length),
    );
  }
});
