import assert from "node:assert/strict";
import { test } from "node:test";
import { Worker } from "node:worker_threads";
import {
  asError,
  forwardBrokerRequest,
  isBrokerEntry,
  runBroker,
  terminateWorkerBounded,
} from "../../../experiments/ffi-pty/windows-broker.mts";

test("broker implementation can be imported without starting a lifecycle", () => {
  assert.equal(typeof runBroker, "function");
  assert.equal(isBrokerEntry(), false);
  assert.equal(asError("failure").message, "failure");
  const forwarded: string[] = [];
  const transport = {
    send: async (request: { type: string }) => {
      forwarded.push(request.type);
    },
  } as any;
  return forwardBrokerRequest(transport, { type: "connected" }).then(() => {
    assert.deepEqual(forwarded, ["connected"]);
  });
});

test("broker termination waits only for its bounded worker grace", async () => {
  const transport = { terminate: () => new Promise<void>(() => {}) } as any;
  const started = Date.now();
  await terminateWorkerBounded(transport, 20);
  assert.ok(Date.now() - started < 1000);
});

test("broker module import in an idle worker exits without a lifecycle", async () => {
  const worker = new Worker(
    new URL("../../../experiments/ffi-pty/windows-broker.mts", import.meta.url),
    { workerData: null },
  );
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      void worker.terminate();
      reject(new Error("idle worker did not exit after broker import"));
    }, 3000);
    worker.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    worker.once("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`idle Windows worker exited with code ${code}`));
    });
  });
});
