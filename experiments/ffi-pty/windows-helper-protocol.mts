import type { SpawnOptions } from "./contract.mts";
import type { WindowsStart } from "./windows-launch.mts";
import type { BrokerReply, BrokerRequest } from "./windows-protocol.mts";

export const HELPER_MAGIC = 0x31595450;
export const HELPER_MAX_PAYLOAD = 8 * 1024 * 1024;
export const HELPER_OPCODE = {
  start: 1,
  connected: 2,
  resize: 3,
  kill: 4,
  close: 5,
  abort: 6,
  pipes: 101,
  spawned: 102,
  ack: 103,
  exited: 104,
  error: 105,
  done: 106,
} as const;

export type PreparedWindowsStart = WindowsStart;

export type HelperRequest =
  | { type: "start"; options: SpawnOptions }
  | Exclude<BrokerRequest, { type: "start" }>;

export interface HelperFrame {
  opcode: number;
  id: number;
  payload: Buffer;
}

const OPCODE_BY_REQUEST: Record<string, number> = {
  connected: HELPER_OPCODE.connected,
  abort: HELPER_OPCODE.abort,
  resize: HELPER_OPCODE.resize,
  kill: HELPER_OPCODE.kill,
  close: HELPER_OPCODE.close,
};

function u32(value: number, label: string): Buffer {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new RangeError(`${label} must be a uint32`);
  }
  const result = Buffer.allocUnsafe(4);
  result.writeUInt32LE(value);
  return result;
}

function stringField(value: string): Buffer {
  if (value.includes("\0")) throw new Error("helper string contains NUL");
  const content = Buffer.from(`${value}\0`, "utf16le");
  return Buffer.concat([u32(content.length, "string byte length"), content]);
}

function utf16BufferField(value: Buffer, doubleNul = false): Buffer {
  if (value.length < 2 || value.length % 2 !== 0 || value.readUInt16LE(value.length - 2) !== 0) {
    throw new Error("prepared UTF-16 buffer must end with NUL");
  }
  if (doubleNul && (value.length < 4 || value.readUInt16LE(value.length - 4) !== 0)) {
    throw new Error("prepared environment block must end with two NULs");
  }
  if (!doubleNul) {
    for (let offset = 0; offset < value.length - 2; offset += 2) {
      if (value.readUInt16LE(offset) === 0)
        throw new Error("prepared UTF-16 string contains an interior NUL");
    }
  }
  return Buffer.concat([u32(value.length, "string byte length"), value]);
}

export function encodeHelperFrame(opcode: number, id: number, payload = Buffer.alloc(0)): Buffer {
  if (payload.length > HELPER_MAX_PAYLOAD)
    throw new RangeError("helper frame payload exceeds 8 MiB");
  const header = Buffer.allocUnsafe(16);
  header.writeUInt32LE(HELPER_MAGIC, 0);
  header.writeUInt32LE(opcode, 4);
  header.writeUInt32LE(id, 8);
  header.writeUInt32LE(payload.length, 12);
  return Buffer.concat([header, payload]);
}

export function encodeHelperRequest(
  request: HelperRequest,
  prepared?: PreparedWindowsStart,
): Buffer {
  if (request.type === "start") {
    if (!prepared) throw new Error("prepared Windows start data is required");
    const payload = Buffer.concat([
      u32(prepared.cols, "columns"),
      u32(prepared.rows, "rows"),
      utf16BufferField(prepared.application),
      utf16BufferField(prepared.commandLine),
      utf16BufferField(prepared.cwd),
      utf16BufferField(prepared.environment, true),
      stringField(prepared.inputName),
      stringField(prepared.outputName),
    ]);
    return encodeHelperFrame(HELPER_OPCODE.start, 0, payload);
  }

  const operation = request.type === "command" ? request.command : request.type;
  const opcode = OPCODE_BY_REQUEST[operation];
  if (opcode === undefined) throw new Error(`unsupported helper request: ${operation}`);
  let payload = Buffer.alloc(0);
  if (operation === "resize" && request.type === "command")
    payload = Buffer.concat([u32(request.cols, "columns"), u32(request.rows, "rows")]);
  if (operation === "kill" && request.type === "command") payload = u32(request.signal, "signal");
  return encodeHelperFrame(opcode, "id" in request ? request.id : 0, payload);
}

export function encodeHelperReply(reply: BrokerReply): Buffer {
  let payload = Buffer.alloc(0);
  let id = 0;
  let opcode: number;
  switch (reply.type) {
    case "pipes":
      opcode = HELPER_OPCODE.pipes;
      break;
    case "spawned":
      opcode = HELPER_OPCODE.spawned;
      payload = u32(reply.pid, "pid");
      break;
    case "ack":
      opcode = HELPER_OPCODE.ack;
      id = reply.id;
      payload = Buffer.from(reply.error ?? "", "utf8");
      break;
    case "exited":
      opcode = HELPER_OPCODE.exited;
      payload = Buffer.concat([u32(reply.exitCode, "exit code"), u32(reply.signal, "signal")]);
      break;
    case "error":
      opcode = HELPER_OPCODE.error;
      payload = Buffer.from(reply.error, "utf8");
      break;
    case "brokerDone":
      opcode = HELPER_OPCODE.done;
      break;
  }
  return encodeHelperFrame(opcode, id, payload);
}

export function decodeHelperReply(frame: HelperFrame): BrokerReply {
  const { payload, opcode, id } = frame;
  const read = (offset: number) => {
    if (payload.length < offset + 4) throw new Error("truncated helper reply");
    return payload.readUInt32LE(offset);
  };
  switch (opcode) {
    case HELPER_OPCODE.pipes:
      if (payload.length) throw new Error("PIPES reply must be empty");
      return { type: "pipes", input: "", output: "" };
    case HELPER_OPCODE.spawned:
      if (payload.length !== 4) throw new Error("SPAWNED reply must contain a pid");
      return { type: "spawned", pid: read(0) };
    case HELPER_OPCODE.ack: {
      const error = payload.toString("utf8");
      return error ? { type: "ack", id, error } : { type: "ack", id };
    }
    case HELPER_OPCODE.exited:
      if (payload.length !== 8) throw new Error("EXITED reply must contain exit code and signal");
      return { type: "exited", exitCode: read(0), signal: read(4) };
    case HELPER_OPCODE.error:
      return { type: "error", error: payload.toString("utf8") };
    case HELPER_OPCODE.done:
      if (payload.length) throw new Error("DONE reply must be empty");
      return { type: "brokerDone" };
    default:
      throw new Error(`unknown helper reply opcode: ${opcode}`);
  }
}

export function decodeHelperFrames(
  chunk: Buffer,
  pending = Buffer.alloc(0),
): { frames: HelperFrame[]; pending: Buffer } {
  const data = pending.length ? Buffer.concat([pending, chunk]) : chunk;
  const frames: HelperFrame[] = [];
  let offset = 0;
  while (data.length - offset >= 16) {
    if (data.readUInt32LE(offset) !== HELPER_MAGIC) throw new Error("invalid helper frame magic");
    const size = data.readUInt32LE(offset + 12);
    if (size > HELPER_MAX_PAYLOAD) throw new Error("helper frame payload exceeds 8 MiB");
    if (data.length - offset < 16 + size) break;
    frames.push({
      opcode: data.readUInt32LE(offset + 4),
      id: data.readUInt32LE(offset + 8),
      payload: Buffer.from(data.subarray(offset + 16, offset + 16 + size)),
    });
    offset += 16 + size;
  }
  return { frames, pending: Buffer.from(data.subarray(offset)) };
}
