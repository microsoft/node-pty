import { dlopen, getInt32 } from "node:ffi";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { constants as osConstants } from "node:os";
import { createUnixBackend } from "./unix-common.mts";
import type { SpawnOptions } from "./contract.mts";
import type { UnixBindings } from "./unix-common.mts";
import { makePointerVector, resolveExecutable } from "./unix-native.mts";
import { splitTargetEnvironment } from "./darwin-bootstrap.mts";

const execFileAsync = promisify(execFile);
const { functions: c } = dlopen("/usr/lib/libSystem.B.dylib", {
  openpty: { arguments: ["pointer", "pointer", "pointer", "pointer", "pointer"], return: "int32" },
  close: { arguments: ["int32"], return: "int32" },
  posix_spawnattr_init: { arguments: ["pointer"], return: "int32" },
  posix_spawnattr_setflags: { arguments: ["pointer", "int16"], return: "int32" },
  posix_spawnattr_setsigmask: { arguments: ["pointer", "pointer"], return: "int32" },
  posix_spawnattr_setsigdefault: { arguments: ["pointer", "pointer"], return: "int32" },
  posix_spawnattr_destroy: { arguments: ["pointer"], return: "int32" },
  posix_spawn_file_actions_init: { arguments: ["pointer"], return: "int32" },
  posix_spawn_file_actions_addopen: {
    arguments: ["pointer", "int32", "string", "int32", "uint16"],
    return: "int32",
  },
  posix_spawn_file_actions_adddup2: { arguments: ["pointer", "int32", "int32"], return: "int32" },
  posix_spawn_file_actions_addclose: { arguments: ["pointer", "int32"], return: "int32" },
  posix_spawn_file_actions_addchdir_np: { arguments: ["pointer", "string"], return: "int32" },
  posix_spawn_file_actions_destroy: { arguments: ["pointer"], return: "int32" },
  posix_spawn: {
    arguments: ["pointer", "string", "pointer", "pointer", "pointer", "pointer"],
    return: "int32",
  },
  waitpid: { arguments: ["int32", "pointer", "int32"], return: "int32" },
  kill: { arguments: ["int32", "int32"], return: "int32" },
  __error: { arguments: [], return: "pointer" },
});

const SIGNALS = osConstants.signals;

export function nativeErrno(): number {
  return getInt32(c.__error());
}

export function checked(result: number, operation: string): void {
  if (result !== 0) throw new Error(`${operation} failed with errno ${result}`);
}

export function spawn(options: SpawnOptions) {
  const executable = resolveExecutable(options.file, options.cwd, options.env);
  const bootstrapPath = fileURLToPath(new URL("./darwin-bootstrap.mts", import.meta.url));
  const childEnv = splitTargetEnvironment(options.env);
  const masterOut = Buffer.alloc(4);
  const slaveOut = Buffer.alloc(4);
  const nameOut = Buffer.alloc(1024);
  const size = Buffer.alloc(8);
  size.writeUInt16LE(options.rows, 0);
  size.writeUInt16LE(options.cols, 2);
  if (c.openpty(masterOut, slaveOut, nameOut, null, size) !== 0) {
    throw new Error(`openpty failed with errno ${nativeErrno()}`);
  }
  const masterFd = masterOut.readInt32LE();
  const slaveFd = slaveOut.readInt32LE();
  if (masterFd < 3 || slaveFd < 3) {
    c.close(masterFd);
    c.close(slaveFd);
    throw new Error("openpty returned a descriptor that conflicts with standard I/O");
  }
  const terminator = nameOut.indexOf(0);
  if (terminator < 0) {
    c.close(masterFd);
    c.close(slaveFd);
    throw new Error("openpty returned an unterminated slave name");
  }
  const slaveName = nameOut.toString("utf8", 0, terminator);
  const attr = Buffer.alloc(8);
  const actions = Buffer.alloc(8);
  const emptySignalSet = Buffer.alloc(4);
  const defaultSignalSet = Buffer.alloc(4);
  // Reset every catchable signal to its default disposition in the child. In
  // particular, Node may ignore SIGPIPE in the parent process.
  const defaultMask = 0xffffffff & ~(1 << (9 - 1)) & ~(1 << (17 - 1));
  defaultSignalSet.writeUInt32LE(defaultMask >>> 0);
  const pidOut = Buffer.alloc(4);
  let attrReady = false;
  let actionsReady = false;
  let spawned = false;
  try {
    checked(c.posix_spawnattr_init(attr), "posix_spawnattr_init");
    attrReady = true;
    checked(c.posix_spawnattr_setsigmask(attr, emptySignalSet), "posix_spawnattr_setsigmask");
    checked(
      c.posix_spawnattr_setsigdefault(attr, defaultSignalSet),
      "posix_spawnattr_setsigdefault",
    );
    // The bootstrap calls login_tty(), which creates a session and controlling TTY.
    // Darwin SDK: SETSIGDEF=0x04, SETSIGMASK=0x08, CLOEXEC_DEFAULT=0x4000.
    checked(c.posix_spawnattr_setflags(attr, 0x0004 | 0x0008 | 0x4000), "posix_spawnattr_setflags");
    checked(c.posix_spawn_file_actions_init(actions), "posix_spawn_file_actions_init");
    actionsReady = true;
    checked(
      c.posix_spawn_file_actions_addchdir_np(actions, options.cwd),
      "posix_spawn_file_actions_addchdir_np",
    );
    checked(
      c.posix_spawn_file_actions_addopen(actions, 0, slaveName, 2, 0),
      "attach controlling terminal",
    );
    checked(c.posix_spawn_file_actions_adddup2(actions, 0, 1), "dup stdin to stdout");
    checked(c.posix_spawn_file_actions_adddup2(actions, 0, 2), "dup stdin to stderr");
    checked(c.posix_spawn_file_actions_addclose(actions, masterFd), "close child master");
    checked(c.posix_spawn_file_actions_addclose(actions, slaveFd), "close child parent slave");
    const argv = makePointerVector([
      process.execPath,
      "--experimental-ffi",
      bootstrapPath,
      executable,
      options.file,
      ...options.args,
    ]);
    const env = makePointerVector(
      Object.entries(childEnv).map(([key, value]) => `${key}=${value}`),
    );
    const result = c.posix_spawn(
      pidOut,
      process.execPath,
      actions,
      attr,
      argv.pointers,
      env.pointers,
    );
    // Keep native C strings and pointer arrays live until the native call returns.
    void argv.buffers;
    void env.buffers;
    if (result !== 0) throw new Error(`posix_spawn failed with errno ${result}`);
    spawned = true;
  } finally {
    if (actionsReady) c.posix_spawn_file_actions_destroy(actions);
    if (attrReady) c.posix_spawnattr_destroy(attr);
    c.close(slaveFd);
    if (!spawned) c.close(masterFd);
  }
  return { pid: pidOut.readInt32LE(), masterFd, slaveName };
}

export function wait(pid: number) {
  const status = Buffer.alloc(4);
  const found = c.waitpid(pid, status, 1);
  if (found < 0) {
    const errno = nativeErrno();
    if (errno === 4) return null; // EINTR; the shared poll loop will retry.
    throw new Error(`waitpid failed with errno ${errno}`);
  }
  if (!found) return null;
  const raw = status.readInt32LE();
  return { exitCode: (raw & 0x7f) === 0 ? (raw >>> 8) & 0xff : null, signal: raw & 0x7f };
}

export function kill(pid: number, signal: string) {
  const number = SIGNALS[signal] ?? Number(signal);
  if (!Number.isInteger(number) || number < 0 || number > 31)
    throw new TypeError(`Unsupported signal: ${signal}`);
  if (c.kill(pid, number) !== 0) {
    const errno = nativeErrno();
    if (errno !== 3) throw new Error(`kill failed with errno ${errno}`);
  }
}

export async function resize(slaveName: string, cols: number, rows: number): Promise<void> {
  await execFileAsync("/bin/stty", ["-f", slaveName, "rows", String(rows), "cols", String(cols)], {
    timeout: 2000,
    maxBuffer: 1024,
  });
}

const bindings: UnixBindings = {
  spawn,
  wait,
  kill,
  resize,
  closeFd: (fd) => {
    c.close(fd);
  },
};

export async function createBackend(options: SpawnOptions) {
  return createUnixBackend(options, bindings);
}
