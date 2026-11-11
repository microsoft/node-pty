import type { ChildProcess } from "node:child_process";
import type { WindowsStart } from "./windows-launch.mts";
import type { BrokerReply, BrokerRequest } from "./windows-protocol.mts";

export type BrokerProcessRequest =
  | { type: "preparedStart"; start: WindowsStart }
  | Exclude<BrokerRequest, { type: "start" }>;

export interface NodeBrokerChannel {
  connected: boolean;
  send(message: BrokerReply, callback?: (error: Error | null) => void): boolean;
  on(event: "message", listener: (message: BrokerProcessRequest) => void): this;
  off(event: "message", listener: (message: BrokerProcessRequest) => void): this;
  on(event: "disconnect", listener: () => void): this;
  off(event: "disconnect", listener: () => void): this;
  disconnect(): void;
}

export function sendPreparedStart(child: ChildProcess, start: WindowsStart): Promise<void> {
  return sendNodeBrokerMessage(child, { type: "preparedStart", start });
}

export function sendNodeBrokerMessage(
  child: ChildProcess,
  message: BrokerProcessRequest,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (!child.connected) return reject(new Error("Windows PTY subprocess IPC is disconnected"));
    child.send(message, (error) => (error ? reject(error) : resolve()));
  });
}
