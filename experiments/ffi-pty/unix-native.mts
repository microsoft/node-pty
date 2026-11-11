import { getRawPointer } from "node:ffi";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, isAbsolute, resolve } from "node:path";

export function makePointerVector(values: string[]) {
  const buffers = values.map((value) => {
    if (value.includes("\0")) throw new TypeError("NUL in native string");
    return Buffer.from(`${value}\0`);
  });
  const pointers = Buffer.alloc((buffers.length + 1) * 8);
  buffers.forEach((buffer, index) => pointers.writeBigUInt64LE(getRawPointer(buffer), index * 8));
  return { buffers, pointers };
}

export function resolveExecutable(file: string, cwd: string, env: Record<string, string>): string {
  const candidates = file.includes("/")
    ? [isAbsolute(file) ? file : resolve(cwd, file)]
    : (env.PATH ?? "/usr/bin:/bin")
        .split(delimiter)
        .map((directory) => resolve(cwd, directory || ".", file));
  for (const candidate of candidates) {
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      /* skip missing, non-file, or non-executable candidates */
    }
  }
  throw new Error(`Executable not found or not executable: ${file}`);
}
