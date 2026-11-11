import assert from "node:assert/strict";
import { closeSync, fstatSync } from "node:fs";
import { test } from "node:test";
import { dlopen } from "node:ffi";
import { initializeNonblockingPoll } from "../../../experiments/ffi-pty/unix-poll.mts";

test(
  "libuv poll initialization leaves the descriptor open and handles invalid fds",
  {
    timeout: 5000,
    skip: process.platform !== "darwin",
  },
  () => {
    const { functions: c } = dlopen(null, {
      pipe: { arguments: ["pointer"], return: "int32" },
    });
    assert.throws(() => initializeNonblockingPoll(-1), /uv_poll_init/);
    const pipeOut = Buffer.alloc(8);
    assert.equal(c.pipe(pipeOut), 0);
    const readFd = pipeOut.readInt32LE(),
      writeFd = pipeOut.readInt32LE(4);
    try {
      initializeNonblockingPoll(writeFd);
      assert.doesNotThrow(() => fstatSync(writeFd));
      assert.throws(() => initializeNonblockingPoll(-1), /uv_poll_init/);
      assert.doesNotThrow(() => fstatSync(writeFd));
    } finally {
      closeSync(writeFd);
      closeSync(readFd);
    }
  },
);
