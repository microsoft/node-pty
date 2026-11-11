import assert from "node:assert/strict";
import { createConnection, type Socket } from "node:net";
import { test } from "node:test";
import { createNodeTransport } from "../../../experiments/ffi-pty/windows-broker-client.mts";
import type { BrokerReply } from "../../../experiments/ffi-pty/windows-protocol.mts";

const supported = process.platform === "win32" && ["x64", "arm64"].includes(process.arch);
const environment = Object.fromEntries(
  Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
);

function waitReply(
  replies: BrokerReply[],
  listeners: Set<(reply: BrokerReply) => void>,
  predicate: (reply: BrokerReply) => boolean,
  label: string,
): Promise<BrokerReply> {
  const existing = replies.find(predicate);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      listeners.delete(listener);
      reject(new Error(`Timed out waiting for ${label}`));
    }, 15000);
    const listener = (reply: BrokerReply) => {
      if (!predicate(reply)) return;
      clearTimeout(timer);
      listeners.delete(listener);
      resolve(reply);
    };
    listeners.add(listener);
  });
}

function connectPipe(name: string, sockets: Socket[]): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(name);
    sockets.push(socket);
    socket.on("data", () => {});
    socket.on("error", () => {});
    const onConnect = () => {
      socket.off("error", onError);
      socket.off("close", onClose);
      resolve(socket);
    };
    const onError = (error: Error) => {
      socket.off("connect", onConnect);
      socket.off("close", onClose);
      reject(error);
    };
    const onClose = () => {
      socket.off("connect", onConnect);
      socket.off("error", onError);
      reject(new Error("broker pipe closed before connect"));
    };
    socket.once("connect", onConnect);
    socket.once("error", onError);
    socket.once("close", onClose);
  });
}

async function destroySockets(sockets: Socket[]) {
  await Promise.all(
    sockets.map(
      (socket) =>
        new Promise<void>((resolve) => {
          if (socket.closed) return resolve();
          socket.once("close", resolve);
          socket.destroy();
        }),
    ),
  );
}

test(
  "Node fallback sends prepared Windows launch data and handles resize and close",
  { skip: !supported, timeout: 30000 },
  async () => {
    const transport = createNodeTransport();
    const replies: BrokerReply[] = [];
    const listeners = new Set<(reply: BrokerReply) => void>();
    const sockets: Socket[] = [];
    const errors: Error[] = [];
    const removeMessage = transport.onMessage((reply) => {
      replies.push(reply);
      for (const listener of listeners) listener(reply);
    });
    const removeError = transport.onError((error) => errors.push(error));
    let closed = false;
    try {
      await transport.ready;
      const options = {
        file: process.execPath,
        args: ["-e", "setInterval(() => {}, 1000)"],
        cwd: process.cwd(),
        env: environment,
        cols: 80,
        rows: 24,
      };
      await transport.send({ type: "start", options });
      const pipes = await waitReply(
        replies,
        listeners,
        (reply) => reply.type === "pipes",
        "pipe setup",
      );
      assert.equal(pipes.type, "pipes");
      await Promise.all([connectPipe(pipes.input, sockets), connectPipe(pipes.output, sockets)]);
      await transport.send({ type: "connected" });
      const spawned = await waitReply(
        replies,
        listeners,
        (reply) => reply.type === "spawned",
        "target startup",
      );
      assert.equal(spawned.type, "spawned");
      assert.ok(Number.isSafeInteger(spawned.pid) && spawned.pid > 0);

      await transport.send({ type: "command", id: 1, command: "resize", cols: 91, rows: 32 });
      const resized = await waitReply(
        replies,
        listeners,
        (reply) => reply.type === "ack" && reply.id === 1,
        "resize ACK",
      );
      assert.deepEqual(resized, { type: "ack", id: 1 });

      await transport.send({ type: "command", id: 2, command: "close" });
      const closedAck = await waitReply(
        replies,
        listeners,
        (reply) => reply.type === "ack" && reply.id === 2,
        "close ACK",
      );
      assert.deepEqual(closedAck, { type: "ack", id: 2 });
      const exited = await waitReply(
        replies,
        listeners,
        (reply) => reply.type === "exited",
        "target exit",
      );
      assert.equal(exited.type, "exited");
      assert.equal(exited.signal, 1);
      await waitReply(replies, listeners, (reply) => reply.type === "brokerDone", "broker cleanup");
      await transport.closed;
      closed = true;
      assert.deepEqual(errors, []);
    } finally {
      removeMessage();
      removeError();
      await destroySockets(sockets);
      if (!closed) await transport.terminate();
    }
  },
);
