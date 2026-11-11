import { createRequire } from "node:module";
import type { Backend, FfiPty } from "./contract.mts";
import { createPtyFromBackend } from "./events.mts";
import { normalizeSpawnOptions } from "./validation.mts";

const require = createRequire(import.meta.url);
const supportedPlatforms = new Set(["darwin", "linux", "win32"]);
const supportedArchitectures = new Set(["x64", "arm64"]);

export async function spawnPty(file: string, args: string[], options = {}): Promise<FfiPty> {
  const normalized = normalizeSpawnOptions(file, args, options);
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 26 || (major === 26 && minor < 12)) {
    throw new Error("The FFI PTY experiment requires Node.js 26.12 or newer");
  }
  if (!supportedPlatforms.has(process.platform) || !supportedArchitectures.has(process.arch)) {
    throw new Error(`Unsupported FFI PTY platform: ${process.platform}-${process.arch}`);
  }
  const backendFiles = { darwin: "./darwin.mts", linux: "./linux.mts", win32: "./windows.mts" };
  const moduleName = backendFiles[process.platform as keyof typeof backendFiles];
  let platform: { createBackend(options: typeof normalized): Promise<Backend> };
  try {
    platform = require(moduleName) as typeof platform;
  } catch (error) {
    throw new Error(`FFI PTY backend unavailable for ${process.platform}`, { cause: error });
  }
  const backend = await platform.createBackend(normalized);
  return createPtyFromBackend(backend, normalized.cols, normalized.rows);
}

export { createPtyFromBackend } from "./events.mts";
export { normalizeSpawnOptions, validateDimension, validateNativeString } from "./validation.mts";
export type { Backend, ExitStatus, FfiPty, SpawnOptions, SpawnOptionsInput } from "./contract.mts";
