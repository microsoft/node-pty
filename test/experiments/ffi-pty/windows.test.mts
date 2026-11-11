import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { linkSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  createBackend,
  dimensions,
  windowsSignalNumber,
} from "../../../experiments/ffi-pty/windows.mts";

const supported =
  process.platform === "win32" && (process.arch === "x64" || process.arch === "arm64");
const options = (script: string, extra: Partial<{ cols: number; rows: number }> = {}) => ({
  file: process.execPath,
  args: ["-e", script],
  cwd: process.cwd(),
  env: Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  ),
  cols: extra.cols ?? 80,
  rows: extra.rows ?? 24,
});

async function collect(backend: Awaited<ReturnType<typeof createBackend>>, timeoutMs = 10000) {
  let text = "";
  const done = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timed out; output was ${JSON.stringify(text.slice(-500))}`)),
      timeoutMs,
    );
    backend.readable.setEncoding("utf8");
    backend.readable.on("data", (part: string) => {
      text += part;
    });
    backend.exited.then(() => {
      clearTimeout(timer);
      resolve(text);
    }, reject);
  });
  return done;
}
async function until(
  backend: Awaited<ReturnType<typeof createBackend>>,
  pattern: RegExp,
  timeoutMs = 5000,
) {
  let text = "";
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ${pattern}: ${text.slice(-300)}`));
    }, timeoutMs);
    const onData = (part: Buffer) => {
      text += part.toString();
      if (pattern.test(text)) {
        cleanup();
        resolve(text);
      }
    };
    const onExit = () => {
      cleanup();
      reject(new Error(`Process exited before ${pattern}: ${text.slice(-300)}`));
    };
    const cleanup = () => {
      clearTimeout(timer);
      backend.readable.off("data", onData);
    };
    backend.readable.on("data", onData);
    backend.exited.then(onExit, onExit);
  });
}

async function waitForSize(file: string, expected: [number, number], timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (JSON.stringify(JSON.parse(readFileSync(file, "utf8"))) === JSON.stringify(expected))
        return;
    } catch {
      // The child may be midway through replacing the result file.
    }
    await delay(20);
  }
  throw new Error(`Timed out waiting for native console size ${expected}`);
}

test(
  "Windows ConPTY starts a Unicode executable, cwd, argument, and environment",
  { skip: !supported, timeout: 30000 },
  async () => {
    const directory = mkdtempSync(join(tmpdir(), "ffi-pty-🐸-"));
    const executable = join(directory, "node 🐸.exe");
    linkSync(process.execPath, executable);
    const env = { ...options("").env, FFI_MARK: "héllo" };
    let backend: Awaited<ReturnType<typeof createBackend>> | undefined;
    try {
      backend = await createBackend({
        file: executable,
        args: [
          "-e",
          "console.log(JSON.stringify([process.cwd(), process.argv[1], process.env.FFI_MARK]))",
          "café 🐸",
        ],
        cwd: directory,
        env,
        cols: 80,
        rows: 24,
      });
      const text = await collect(backend);
      assert.match(text, /héllo/);
      assert.match(text, /café 🐸/);
      assert.ok(text.includes(JSON.stringify(directory)));
    } finally {
      await backend?.close();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test(
  "Windows ConPTY resolves bare commands from the child PATH",
  { skip: !supported, timeout: 30000 },
  async () => {
    const env = Object.fromEntries(
      Object.entries(options("").env).filter(([key]) => key.toUpperCase() !== "PATH"),
    );
    env.Path = dirname(process.execPath);
    const backend = await createBackend({
      ...options("console.log('PATH_OK')"),
      file: "node",
      env,
    });
    try {
      assert.match(await collect(backend), /PATH_OK/);
    } finally {
      await backend.close();
    }
  },
);

test("resize updates the console dimensions", { skip: !supported, timeout: 30000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "ffi-pty-resize-"));
  const sizeFile = join(directory, "size.json");
  const script = `const {dlopen}=require('node:ffi'); const {functions:k}=dlopen('kernel32.dll',{GetStdHandle:{arguments:['uint32'],return:'pointer'},GetConsoleScreenBufferInfo:{arguments:['pointer','pointer'],return:'int32'}}); const h=k.GetStdHandle(0xfffffff5); const b=Buffer.alloc(22); setInterval(()=>{if(k.GetConsoleScreenBufferInfo(h,b)){const s=[b.readInt16LE(14)-b.readInt16LE(10)+1,b.readInt16LE(16)-b.readInt16LE(12)+1];require('node:fs').writeFileSync(process.env.FFI_SIZE_FILE,JSON.stringify(s))}},30)`;
  const child = options(script);
  child.args = ["--experimental-ffi", "-e", script];
  child.env.FFI_SIZE_FILE = sizeFile;
  let backend: Awaited<ReturnType<typeof createBackend>> | undefined;
  try {
    backend = await createBackend(child);
    await waitForSize(sizeFile, [80, 24]);
    await backend.resize(107, 39);
    await waitForSize(sizeFile, [107, 39]);
  } finally {
    await backend?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test(
  "large output and input flow through asynchronous pipe sockets",
  { skip: !supported, timeout: 30000 },
  async () => {
    const backend = await createBackend(
      options(
        "process.stdin.once('data', () => process.stdout.write('x'.repeat(12 * 1024 * 1024), () => process.exit(0)))",
      ),
    );
    try {
      backend.readable.pause();
      await backend.write(Buffer.from("go\r"));
      await delay(100);
      backend.readable.resume();
      const textPromise = collect(backend, 20000);
      const text = await textPromise;
      assert.ok(Buffer.byteLength(text) >= 12 * 1024 * 1024);
    } finally {
      await backend.close();
    }
  },
);

test(
  "close drains ConPTY output while the readable stream is paused",
  { skip: !supported, timeout: 30000 },
  async () => {
    const backend = await createBackend(
      options(
        "process.stdin.once('data', () => process.stdout.write('x'.repeat(12 * 1024 * 1024), () => process.exit(0)))",
      ),
    );
    backend.readable.pause();
    await backend.write(Buffer.from("go\r"));
    await delay(100);
    try {
      await backend.close();
      await backend.exited;
    } finally {
      await backend.close();
    }
  },
);

test(
  "raw UTF-8 input reaches a Windows console child unchanged",
  { skip: !supported, timeout: 30000 },
  async () => {
    const script =
      "if (typeof process.stdin.setRawMode !== 'function') { process.stdout.write('RAW_UNSUPPORTED'); process.exit(31); } process.stdin.setRawMode(true); process.stdin.setEncoding('utf8'); process.stdin.once('data', (text) => process.stdout.write('RAW_TEXT:' + text, () => process.exit(0))); process.stdout.write('RAW_READY:function\\r\\n')";
    const backend = await createBackend(options(script));
    try {
      assert.match(await until(backend, /RAW_READY:/), /RAW_READY:function/);
      await backend.write(Buffer.from("🐸"));
      assert.match(await collect(backend), /RAW_TEXT:🐸/);
    } finally {
      await backend.close();
    }
  },
);

test(
  "termination reports the requested Windows signal and rejects unsupported signals",
  { skip: !supported, timeout: 30000 },
  async () => {
    const backend = await createBackend(options("setInterval(() => {}, 1000)"));
    try {
      backend.readable.resume();
      await assert.rejects(backend.kill("SIGINT"), /Unsupported Windows termination signal/);
      await backend.kill("SIGTERM");
      assert.deepEqual(await backend.exited, { exitCode: null, signal: 15 });
    } finally {
      await backend.close();
    }
  },
);

test("dimensions and Windows signal names validate consistently", () => {
  assert.doesNotThrow(() => dimensions(80, 24));
  assert.throws(() => dimensions(0, 24), /cols must be an integer/);
  assert.equal(windowsSignalNumber("sigterm"), 15);
  assert.equal(windowsSignalNumber("SIGKILL"), 9);
  assert.throws(() => windowsSignalNumber("SIGINT"), /Unsupported/);
});

test(
  "two sessions run independently and report natural exit codes",
  { skip: !supported, timeout: 30000 },
  async () => {
    const [first, second] = await Promise.all([
      createBackend(options("console.log('FIRST'); process.exit(7)")),
      createBackend(options("console.log('SECOND'); process.exit(9)")),
    ]);
    try {
      const [a, b] = await Promise.all([collect(first), collect(second)]);
      assert.match(a, /FIRST/);
      assert.match(b, /SECOND/);
      assert.equal((await first.exited).exitCode, 7);
      assert.equal((await second.exited).exitCode, 9);
    } finally {
      await Promise.all([first.close(), second.close()]);
    }
  },
);

test(
  "invalid executable and arguments reject without hanging",
  { skip: !supported, timeout: 30000 },
  async () => {
    await assert.rejects(createBackend({ ...options(""), file: "Z:\\missing\\program.exe" }));
    await assert.rejects(createBackend(options("", { cols: 0 })), /cols must be an integer/);
    await assert.rejects(createBackend({ ...options(""), args: ["bad\0arg"] }), /NUL/);
  },
);
