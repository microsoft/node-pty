import { dlopen } from "node:ffi";

interface LibuvFunctions {
  uv_loop_size(): bigint;
  uv_handle_size(type: number): bigint;
  uv_loop_init(loop: Buffer): number;
  uv_loop_close(loop: Buffer): number;
  uv_run(loop: Buffer, mode: number): number;
  uv_poll_init(loop: Buffer, handle: Buffer, fd: number): number;
  uv_close(handle: Buffer, callback: bigint): void;
}

let uv: LibuvFunctions | undefined;

export function loadLibuvFunctions(): LibuvFunctions {
  if (!uv) {
    uv = dlopen(null, {
      uv_loop_size: { arguments: [], return: "uint64" },
      uv_handle_size: { arguments: ["int32"], return: "uint64" },
      uv_loop_init: { arguments: ["pointer"], return: "int32" },
      uv_loop_close: { arguments: ["pointer"], return: "int32" },
      uv_run: { arguments: ["pointer", "int32"], return: "int32" },
      uv_poll_init: { arguments: ["pointer", "pointer", "int32"], return: "int32" },
      uv_close: { arguments: ["pointer", "pointer"], return: "void" },
    }).functions as unknown as LibuvFunctions;
  }
  return uv;
}

const UV_POLL = 8;
const UV_RUN_DEFAULT = 0;

export function initializeNonblockingPoll(fd: number): void {
  const uv = loadLibuvFunctions();
  const loop = Buffer.alloc(Number(uv.uv_loop_size()));
  const handle = Buffer.alloc(Number(uv.uv_handle_size(UV_POLL)));
  const loopResult = uv.uv_loop_init(loop);
  if (loopResult !== 0) throw new Error(`uv_loop_init failed with ${loopResult}`);
  const pollResult = uv.uv_poll_init(loop, handle, fd);
  if (pollResult !== 0) {
    const closeResult = uv.uv_loop_close(loop);
    if (closeResult !== 0)
      throw new Error(
        `uv_poll_init failed with ${pollResult}; uv_loop_close failed with ${closeResult}`,
      );
    throw new Error(`uv_poll_init failed with ${pollResult}`);
  }
  // uv_poll_init sets O_NONBLOCK. Close only the libuv handle; the PTY fd remains
  // owned by ReadStream. Pump the private loop so uv_close finishes synchronously.
  uv.uv_close(handle, 0n);
  uv.uv_run(loop, UV_RUN_DEFAULT);
  const closeResult = uv.uv_loop_close(loop);
  if (closeResult !== 0) throw new Error(`uv_loop_close failed with ${closeResult}`);
}
