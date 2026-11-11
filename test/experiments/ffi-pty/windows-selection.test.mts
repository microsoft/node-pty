import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createWindowsTransport,
  type WindowsSelectionDependencies,
} from "../../../experiments/ffi-pty/windows-selection.mts";
import type { WindowsTransport } from "../../../experiments/ffi-pty/windows-transport.mts";

function transport(ready: Promise<void> = Promise.resolve()) {
  let terminated = 0;
  const value: WindowsTransport = {
    ready,
    closed: Promise.resolve(),
    async send() {},
    onMessage() {
      return () => {};
    },
    onError() {
      return () => {};
    },
    async terminate() {
      terminated++;
    },
  };
  return {
    value,
    get terminated() {
      return terminated;
    },
  };
}

function dependencies(overrides: Partial<WindowsSelectionDependencies> = {}) {
  const node = transport();
  const helper = transport();
  const ffi = transport();
  const selected: string[] = [];
  const deps: WindowsSelectionDependencies = {
    async verifyHelper() {
      return { kind: "node", reason: "unsigned" };
    },
    createNodeTransport() {
      selected.push("node");
      return node.value;
    },
    createHelperTransport() {
      selected.push("helper");
      return helper.value;
    },
    createFfiTransport() {
      selected.push("ffi");
      return ffi.value;
    },
    ...overrides,
  };
  return { deps, node, helper, ffi, selected };
}

test("modern Windows selects direct FFI without checking helper trust", async () => {
  const state = dependencies({
    async verifyHelper() {
      throw new Error("should not inspect helper");
    },
  });
  assert.equal(
    await createWindowsTransport({ major: 10, minor: 0, build: 26100 }, state.deps),
    state.ffi.value,
  );
  assert.deepEqual(state.selected, ["ffi"]);
});

test("affected Windows falls back to Node when no trusted helper is available", async () => {
  const state = dependencies();
  assert.equal(
    await createWindowsTransport({ major: 10, minor: 0, build: 22631 }, state.deps),
    state.node.value,
  );
  assert.deepEqual(state.selected, ["node"]);
});

test("affected Windows starts a verified helper at its locked path", async () => {
  const state = dependencies({
    async verifyHelper() {
      return { kind: "native", path: "locked.exe", subject: "CN=PTY" };
    },
  });
  assert.equal(
    await createWindowsTransport({ major: 10, minor: 0, build: 22631 }, state.deps),
    state.helper.value,
  );
  assert.deepEqual(state.selected, ["helper"]);
});

test("helper startup failure terminates helper and falls back to Node", async () => {
  const state = dependencies({
    async verifyHelper() {
      return { kind: "native", path: "locked.exe", subject: "CN=PTY" };
    },
    createHelperTransport() {
      return transport(Promise.reject(new Error("cannot start"))).value;
    },
  });
  assert.equal(
    await createWindowsTransport({ major: 10, minor: 0, build: 22631 }, state.deps),
    state.node.value,
  );
  assert.deepEqual(state.selected, ["node"]);
});
