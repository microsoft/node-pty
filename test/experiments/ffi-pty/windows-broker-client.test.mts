import assert from "node:assert/strict";
import { test } from "node:test";
import {
  brokerStartupEnv,
  createNodeTransport,
} from "../../../experiments/ffi-pty/windows-broker-client.mts";

test("broker startup environment excludes target and Node injection variables", () => {
  assert.deepEqual(
    brokerStartupEnv({
      SystemRoot: "C:\\Windows",
      WINDIR: "C:\\Windows",
      TEMP: "C:\\Temp",
      TMP: "C:\\Temp",
      PATH: "target-path",
      NODE_OPTIONS: "--require injected.js",
      NODE_PATH: "target-modules",
    }),
    {
      SystemRoot: "C:\\Windows",
      WINDIR: "C:\\Windows",
      TEMP: "C:\\Temp",
      TMP: "C:\\Temp",
    },
  );
});

test("Node fallback transport starts and terminates its subprocess", async () => {
  const transport = createNodeTransport();
  let timer: NodeJS.Timeout;
  try {
    await Promise.race([
      transport.ready,
      new Promise<void>((_, reject) => {
        timer = setTimeout(() => reject(new Error("broker subprocess did not become ready")), 5000);
      }),
    ]);
  } finally {
    clearTimeout(timer!);
    await transport.terminate();
  }
  await transport.closed;
});
