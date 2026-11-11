import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { test } from "node:test";
import { sendNodeBrokerMessage } from "../../../experiments/ffi-pty/windows-broker-ipc.mts";

test("broker IPC rejects sends after disconnect", async () => {
  const child = { connected: false } as ChildProcess;
  await assert.rejects(sendNodeBrokerMessage(child, { type: "connected" }), /IPC is disconnected/);
});

test("broker IPC propagates child send callback errors", async () => {
  const child = {
    connected: true,
    send(_message: unknown, callback: (error: Error | null) => void) {
      callback(new Error("IPC channel closed"));
      return false;
    },
  } as unknown as ChildProcess;
  await assert.rejects(sendNodeBrokerMessage(child, { type: "connected" }), /IPC channel closed/);
});
