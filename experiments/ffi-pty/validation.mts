import { isAbsolute, resolve } from "node:path";
import type { SpawnOptions, SpawnOptionsInput } from "./contract.mts";

const supported = new Set(["cols", "rows", "cwd", "env", "encoding"]);

export function validateNativeString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.includes("\0")) {
    throw new TypeError(`${label} must be a string without NUL bytes`);
  }
}

export function validateDimension(value: unknown, label: string): asserts value is number {
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 32767) {
    throw new RangeError(`${label} must be an integer from 1 to 32767`);
  }
}

export function normalizeSpawnOptions(
  file: string,
  args: string[],
  input: SpawnOptionsInput = {},
): SpawnOptions {
  validateNativeString(file, "file");
  if (!file) throw new TypeError("file must not be empty");
  if (!Array.isArray(args)) throw new TypeError("args must be an array of strings");
  args.forEach((arg, index) => validateNativeString(arg, `args[${index}]`));
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("options must be an object");
  }
  for (const key of Object.keys(input)) {
    if (!supported.has(key)) throw new TypeError(`Unsupported PTY option: ${key}`);
  }
  if (input.encoding !== undefined && input.encoding !== "utf8") {
    throw new TypeError("Only UTF-8 encoding is supported");
  }
  const cols = input.cols ?? 80;
  const rows = input.rows ?? 24;
  validateDimension(cols, "cols");
  validateDimension(rows, "rows");
  const cwd = input.cwd ?? process.cwd();
  validateNativeString(cwd, "cwd");
  const absoluteCwd = isAbsolute(cwd) ? cwd : resolve(cwd);
  const envInput = input.env ?? process.env;
  if (!envInput || typeof envInput !== "object" || Array.isArray(envInput)) {
    throw new TypeError("env must be a string map");
  }
  const env = Object.create(null) as Record<string, string>;
  for (const [key, value] of Object.entries(envInput)) {
    validateNativeString(key, "environment variable name");
    validateNativeString(value, `environment variable ${key}`);
    if (!key || key.includes("=")) throw new TypeError(`Invalid environment variable name: ${key}`);
    env[key] = value;
  }
  if (!Object.hasOwn(env, "TERM")) env.TERM = "xterm-256color";
  return { file, args: [...args], cols, rows, cwd: absoluteCwd, env };
}
