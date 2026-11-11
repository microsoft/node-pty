import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { helperStartupEnv } from "./windows-helper.mts";
import { prepareWindowsStart } from "./windows-launch.mts";
import type { WindowsTransport } from "./windows-transport.mts";
import type { BrokerReply, BrokerRequest } from "./windows-protocol.mts";
import {
  type BrokerProcessRequest,
  sendNodeBrokerMessage,
  sendPreparedStart,
} from "./windows-broker-ipc.mts";

const BROKER_URL = new URL("./windows-broker.mts", import.meta.url);

export function brokerStartupEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return helperStartupEnv(source);
}

export function forkBroker(source: NodeJS.ProcessEnv = process.env): ChildProcess {
  return fork(fileURLToPath(BROKER_URL), [], {
    execPath: process.execPath,
    execArgv: ["--experimental-ffi"],
    env: brokerStartupEnv(source),
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    serialization: "advanced",
    windowsHide: true,
  });
}

export function sendBrokerMessage(
  child: ChildProcess,
  message: BrokerProcessRequest,
): Promise<void> {
  return sendNodeBrokerMessage(child, message);
}

export function notify(listeners: Set<(error: Error) => void>, cause: unknown) {
  const error = cause instanceof Error ? cause : new Error(String(cause));
  for (const listener of listeners) {
    try {
      listener(error);
    } catch {
      // Transport observers cannot interfere with child cleanup.
    }
  }
}

export function createNodeTransport(): WindowsTransport {
  const child = forkBroker();
  const messages = new Set<(reply: BrokerReply) => void>();
  const errors = new Set<(error: Error) => void>();
  let doneReply = false;
  let expectedTermination = false;
  let startSent = false;
  let sendTail = Promise.resolve();

  const ready = new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  void ready.catch((error) => notify(errors, error));
  void closed.then(() => {
    if (!expectedTermination && child.exitCode !== 0) {
      notify(
        errors,
        new Error(
          `Windows PTY subprocess exited with code ${child.exitCode ?? child.signalCode ?? "unknown"}`,
        ),
      );
    }
  });
  child.on("error", (error) => notify(errors, error));
  child.on("disconnect", () => {
    if (!doneReply && !expectedTermination)
      notify(errors, new Error("Windows PTY subprocess IPC disconnected"));
  });
  child.on("message", (message: BrokerReply) => {
    if (!message || typeof message !== "object" || typeof message.type !== "string") {
      notify(errors, new Error("Invalid Windows PTY subprocess reply"));
      return;
    }
    if (message.type === "brokerDone") doneReply = true;
    for (const listener of messages) {
      try {
        listener(message);
      } catch (error) {
        notify(errors, error);
      }
    }
  });

  return {
    ready,
    closed,
    send(request: BrokerRequest): Promise<void> {
      const operation = sendTail.then(async () => {
        await ready;
        if (request.type === "start") {
          if (startSent) throw new Error("Windows PTY subprocess START was already sent");
          const start = prepareWindowsStart(request.options);
          startSent = true;
          await sendPreparedStart(child, start);
        } else {
          await sendBrokerMessage(child, request);
        }
      });
      sendTail = operation.catch(() => {});
      return operation;
    },
    onMessage(listener): () => void {
      messages.add(listener);
      return () => messages.delete(listener);
    },
    onError(listener): () => void {
      errors.add(listener);
      return () => errors.delete(listener);
    },
    async terminate(): Promise<void> {
      expectedTermination = true;
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await closed;
    },
  };
}
