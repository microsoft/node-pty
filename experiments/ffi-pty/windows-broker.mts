import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createFfiWorkerTransport } from "./windows-ffi.mts";
import type { WindowsTransport } from "./windows-transport.mts";
import type { WindowsStart } from "./windows-launch.mts";
import type { BrokerReply } from "./windows-protocol.mts";
import type { BrokerProcessRequest, NodeBrokerChannel } from "./windows-broker-ipc.mts";

const PARENT_DISCONNECT_GRACE_MS = 300;
let brokerStarted = false;

export function sendBrokerReply(channel: NodeBrokerChannel, message: BrokerReply): Promise<void> {
  return new Promise<void>((resolveReply, rejectReply) => {
    if (!channel.connected)
      return rejectReply(new Error("Windows PTY subprocess IPC is disconnected"));
    channel.send(message, (error) => (error ? rejectReply(error) : resolveReply()));
  });
}

export function forwardBrokerRequest(
  transport: WindowsTransport,
  message: BrokerProcessRequest,
): Promise<void> {
  if (message.type === "preparedStart") {
    return Promise.reject(new Error("Windows PTY subprocess received a duplicate START"));
  }
  return transport.send(message);
}

export async function terminateWorkerBounded(
  transport: WindowsTransport,
  timeoutMs = PARENT_DISCONNECT_GRACE_MS,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      transport.terminate(),
      new Promise<void>((resolveStop) => {
        timer = setTimeout(resolveStop, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function runBroker(start: WindowsStart, channel: NodeBrokerChannel): Promise<void> {
  if (brokerStarted) throw new Error("Windows PTY subprocess can run only one session");
  brokerStarted = true;
  let transport: WindowsTransport;
  try {
    transport = createFfiWorkerTransport({ requireModernOs: false, preparedStart: start });
  } catch (error) {
    if (channel.connected) {
      try {
        await sendBrokerReply(channel, { type: "error", error: String(error) });
        await sendBrokerReply(channel, { type: "brokerDone" });
      } catch {
        // The parent may have disconnected during startup.
      } finally {
        if (channel.connected) channel.disconnect();
      }
    }
    return;
  }
  let doneReply = false;
  let ending = false;
  let disconnectTask: Promise<void> | undefined;
  let replyTail = Promise.resolve();

  const exitForDisconnect = () => {
    if (disconnectTask) return disconnectTask;
    disconnectTask = (async () => {
      await terminateWorkerBounded(transport).catch(() => {});
      process.exit(1);
    })();
    return disconnectTask;
  };
  const sendReply = (reply: BrokerReply) => {
    if (reply.type === "brokerDone") doneReply = true;
    const operation = replyTail.then(() => sendBrokerReply(channel, reply));
    replyTail = operation.catch(() => {
      void exitForDisconnect();
    });
    return operation;
  };
  const onReply = (reply: BrokerReply) => {
    void sendReply(reply).catch(() => {});
  };
  const onError = (error: Error) => onReply({ type: "error", error: String(error) });
  const onRequest = (message: BrokerProcessRequest) => {
    if (message.type === "preparedStart") {
      onError(new Error("Windows PTY subprocess received a duplicate START"));
      void exitForDisconnect();
      return;
    }
    void forwardBrokerRequest(transport, message).catch((error) => onError(asError(error)));
  };
  const onDisconnect = () => {
    if (!ending) void exitForDisconnect();
  };

  const removeMessage = transport.onMessage(onReply);
  const removeError = transport.onError(onError);
  channel.on("message", onRequest);
  channel.on("disconnect", onDisconnect);
  try {
    await transport.ready;
    await transport.closed;
    await replyTail;
    if (!doneReply && channel.connected) await sendReply({ type: "brokerDone" });
  } catch (error) {
    if (channel.connected) {
      try {
        await sendReply({ type: "error", error: String(error) });
        if (!doneReply) await sendReply({ type: "brokerDone" });
      } catch {
        await exitForDisconnect();
      }
    }
  } finally {
    ending = true;
    removeMessage();
    removeError();
    channel.off("message", onRequest);
    channel.off("disconnect", onDisconnect);
    if (channel.connected) channel.disconnect();
  }
}

export function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

export function isBrokerEntry(
  entry = process.argv[1],
  modulePath = fileURLToPath(import.meta.url),
): boolean {
  return Boolean(process.send && entry && resolve(entry) === resolve(modulePath));
}

if (isBrokerEntry()) {
  const processChannel = process as unknown as NodeBrokerChannel;
  const onStart = (message: BrokerProcessRequest) => {
    if (message.type !== "preparedStart") return;
    processChannel.off("message", onStart);
    void runBroker(message.start, processChannel);
  };
  processChannel.on("message", onStart);
}
