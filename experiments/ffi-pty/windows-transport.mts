import type { BrokerReply, BrokerRequest } from "./windows-protocol.mts";

export interface WindowsTransport {
  readonly ready: Promise<void>;
  readonly closed: Promise<void>;
  send(request: BrokerRequest): Promise<void>;
  onMessage(listener: (reply: BrokerReply) => void): () => void;
  onError(listener: (error: Error) => void): () => void;
  terminate(): Promise<void>;
}
