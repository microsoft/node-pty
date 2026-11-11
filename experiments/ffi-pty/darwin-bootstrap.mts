import { dlopen, getInt32 } from "node:ffi";
import { fileURLToPath } from "node:url";

export function loginControllingTerminal(): void {
  const { functions } = dlopen("/usr/lib/libSystem.B.dylib", {
    login_tty: { arguments: ["int32"], return: "int32" },
    __error: { arguments: [], return: "pointer" },
  });
  if (functions.login_tty(0) !== 0) {
    throw new Error(`login_tty failed with errno ${getInt32(functions.__error())}`);
  }
}

export function resetIgnoredSignals(): void {
  const { functions } = dlopen("/usr/lib/libSystem.B.dylib", {
    signal: { arguments: ["int32", "pointer"], return: "pointer" },
  });
  // Node ignores SIGPIPE and SIGXFSZ. Exec preserves ignored dispositions.
  functions.signal(13, 0n);
  functions.signal(25, 0n);
}

export function recoverTargetEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const privateKey = "PTY_FFI_TARGET_NODE_ENV";
  const payload = env[privateKey];
  const base = { ...env };
  delete base[privateKey];
  return { ...base, ...(payload ? JSON.parse(payload) : {}) };
}

export function splitTargetEnvironment(env: Record<string, string>): Record<string, string> {
  const bootstrapEnv = Object.create(null) as Record<string, string>;
  const nodeEnv = Object.create(null) as Record<string, string>;
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith("NODE_") || key === "PTY_FFI_TARGET_NODE_ENV") nodeEnv[key] = value;
    else bootstrapEnv[key] = value;
  }
  bootstrapEnv.PTY_FFI_TARGET_NODE_ENV = JSON.stringify(nodeEnv);
  return bootstrapEnv;
}

export function execTarget(argv: string[], env: NodeJS.ProcessEnv): never {
  const [executable, argv0, ...args] = argv;
  if (!executable || !argv0) throw new Error("Invalid Darwin PTY bootstrap arguments");
  resetIgnoredSignals();
  const targetEnv = recoverTargetEnvironment(env);
  process.execve(executable, [argv0, ...args], targetEnv);
  throw new Error("process.execve unexpectedly returned");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    loginControllingTerminal();
    execTarget(process.argv.slice(2), process.env);
  } catch (error) {
    process.stderr.write(
      `PTY child bootstrap failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 127;
  }
}
