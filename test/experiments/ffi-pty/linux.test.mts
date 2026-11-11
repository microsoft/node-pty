import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { test } from "node:test";

const supportedRuntime =
  process.platform === "linux" &&
  (() => {
    const version = process.report?.getReport().header.glibcVersionRuntime;
    const match = version?.match(/^(\d+)\.(\d+)/);
    return !!match && (Number(match[1]) > 2 || (Number(match[1]) === 2 && Number(match[2]) >= 34));
  })();
const load = createRequire(import.meta.url);
const linux =
  process.platform === "linux"
    ? (load(resolve(import.meta.dirname, "../../../experiments/ffi-pty/linux.mts")) as {
        assertSupportedGlibc(version?: string): void;
        getLibcFunctions(): Record<string, unknown>;
        isLinuxNativeLoaded(): boolean;
      })
    : undefined;

test(
  "Linux glibc version guard accepts 2.34+ and rejects older or unknown libc",
  {
    skip: process.platform !== "linux",
  },
  () => {
    assert.doesNotThrow(() => linux!.assertSupportedGlibc("2.34"));
    assert.doesNotThrow(() => linux!.assertSupportedGlibc("2.40"));
    assert.doesNotThrow(() => linux!.assertSupportedGlibc("3.0"));
    assert.throws(() => linux!.assertSupportedGlibc("2.33"), /glibc 2.34 or newer/);
    assert.throws(() => linux!.assertSupportedGlibc("musl"), /glibc 2.34 or newer/);
    assert.throws(() => linux!.assertSupportedGlibc(""), /glibc 2.34 or newer/);
  },
);

test(
  "Linux libc symbols load only when requested",
  {
    skip: !supportedRuntime,
  },
  () => {
    assert.equal(linux!.isLinuxNativeLoaded(), false);
    const symbols = linux!.getLibcFunctions();
    assert.equal(typeof symbols.openpty, "function");
    assert.equal(typeof symbols.posix_spawn, "function");
    assert.equal(typeof symbols.waitpid, "function");
    assert.equal(linux!.isLinuxNativeLoaded(), true);
  },
);
