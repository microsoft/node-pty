import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnPty } from "../../../experiments/ffi-pty/pty.mts";

test(
  "Darwin backend starts a controlling-terminal session and drains output before exit",
  { skip: process.platform !== "darwin" },
  async () => {
    const pty = await spawnPty(
      "sh",
      [
        "-c",
        'test -t 0 && test -t 1 && test -t 2 && echo TTY_OK; printf \'PWD:%s TERM:%s\\n\' "$PWD" "$TERM"; exit 7',
      ],
      { cwd: "/tmp", env: { PATH: "/bin" } },
    );
    let output = "";
    const data = pty.onData((chunk) => {
      output += chunk;
    });
    try {
      assert.deepEqual(await pty.exited, { exitCode: 7, signal: 0 });
      assert.match(output, /TTY_OK/);
      assert.match(output, /PWD:(?:\/private)?\/tmp TERM:xterm-256color/);
    } finally {
      data.dispose();
      await pty.close();
    }
  },
);

test(
  "Darwin bootstrap gives a direct Node child access to /dev/tty and restores NODE_* env",
  { skip: process.platform !== "darwin" },
  async () => {
    const source = [
      "const fs = require('node:fs');",
      "const fd = fs.openSync('/dev/tty', 'r'); fs.closeSync(fd);",
      "console.log('CONTROLLING_TTY:' + process.env.FIXTURE_NODE_ENV + ' SPECIAL_ENV:' + process.env['__proto__']);",
    ].join(" ");
    const pty = await spawnPty(process.execPath, ["-e", source], {
      env: {
        PATH: "/bin",
        NODE_OPTIONS: "--no-warnings",
        PTY_FFI_TARGET_NODE_ENV: "original",
        FIXTURE_NODE_ENV: "restored",
        ["__proto__"]: "restored special key",
      },
    });
    let output = "";
    const data = pty.onData((chunk) => {
      output += chunk;
    });
    try {
      assert.deepEqual(await pty.exited, { exitCode: 0, signal: 0 });
      assert.match(output, /CONTROLLING_TTY:restored/);
      assert.match(output, /SPECIAL_ENV:restored special key/);
    } finally {
      data.dispose();
      await pty.close();
    }
  },
);

test(
  "Darwin backend validates executable before allocating a PTY",
  { skip: process.platform !== "darwin" },
  async () => {
    await assert.rejects(() => spawnPty("/definitely/not/a/command", []), /Executable not found/);
  },
);

test(
  "Darwin resize updates the kernel terminal dimensions",
  { skip: process.platform !== "darwin" },
  async () => {
    const pty = await spawnPty("/bin/sh", ["-c", "stty -echo; echo READY; read line; stty size"]);
    let output = "";
    let ready!: () => void;
    const readySeen = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const data = pty.onData((chunk) => {
      output += chunk;
      if (output.includes("READY")) ready();
    });
    try {
      await readySeen;
      await pty.resize(117, 43);
      await pty.write("\n");
      assert.deepEqual(await pty.exited, { exitCode: 0, signal: 0 });
      assert.match(output, /43 117/);
    } finally {
      data.dispose();
      await pty.close();
    }
  },
);
