import assert from "node:assert/strict";
import { test } from "node:test";
import {
  recoverTargetEnvironment,
  splitTargetEnvironment,
} from "../../../experiments/ffi-pty/darwin-bootstrap.mts";

test("bootstrap restores target NODE_* values and private-key collisions without mutating input", () => {
  const original = {
    PATH: "/bin",
    PTY_FFI_TARGET_NODE_ENV: JSON.stringify({
      NODE_OPTIONS: "--no-warnings",
      NODE_PATH: "/target/modules",
      PTY_FFI_TARGET_NODE_ENV: "target-value",
    }),
  };
  const target = recoverTargetEnvironment(original);
  assert.deepEqual(target, {
    PATH: "/bin",
    NODE_OPTIONS: "--no-warnings",
    NODE_PATH: "/target/modules",
    PTY_FFI_TARGET_NODE_ENV: "target-value",
  });
  assert.equal(typeof original.PTY_FFI_TARGET_NODE_ENV, "string");
});

test("bootstrap preserves special environment keys through its target payload", () => {
  const original = Object.create(null) as Record<string, string>;
  original.PATH = "/bin";
  original.NODE_OPTIONS = "--no-warnings";
  original.PTY_FFI_TARGET_NODE_ENV = "target-private-key";
  original.__proto__ = "target-prototype-key";

  const bootstrapEnv = splitTargetEnvironment(original);
  assert.equal(Object.getPrototypeOf(bootstrapEnv), null);
  assert.equal(Object.hasOwn(bootstrapEnv, "__proto__"), true);
  assert.equal(bootstrapEnv.__proto__, "target-prototype-key");
  const restored = recoverTargetEnvironment(bootstrapEnv);
  assert.equal(restored.__proto__, "target-prototype-key");
  assert.equal(Object.hasOwn(restored, "__proto__"), true);
  assert.equal(restored.PTY_FFI_TARGET_NODE_ENV, "target-private-key");
  assert.equal(restored.NODE_OPTIONS, "--no-warnings");
  assert.equal(original.__proto__, "target-prototype-key");
});
