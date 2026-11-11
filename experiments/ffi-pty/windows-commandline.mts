import { statSync } from "node:fs";
import { win32 as path } from "node:path";

/** Quote one argument using the parsing rules used by CommandLineToArgvW/CRT. */
export function quoteWindowsArgument(value: string): string {
  if (value.includes("\0")) throw new Error("NUL in Windows argument");
  if (value.length > 0 && !/[\s"]/.test(value)) return value;

  let result = '"';
  let backslashes = 0;
  for (const character of value) {
    if (character === "\\") {
      backslashes++;
      continue;
    }
    if (character === '"') {
      result += "\\".repeat(backslashes * 2 + 1) + '"';
    } else {
      result += "\\".repeat(backslashes) + character;
    }
    backslashes = 0;
  }
  return result + "\\".repeat(backslashes * 2) + '"';
}
export function buildWindowsCommandLine(file: string, args: string[]): string {
  if (!file) throw new Error("Executable path must not be empty");
  return [file, ...args].map(quoteWindowsArgument).join(" ");
}

export function windowsPipeNames(id: string): { input: string; output: string } {
  if (!id || /[\\/\0]/.test(id)) throw new Error("Invalid named pipe identifier");
  return {
    input: String.raw`\\.\pipe\node-pty-ffi-${id}-in`,
    output: String.raw`\\.\pipe\node-pty-ffi-${id}-out`,
  };
}

export function resolveWindowsExecutable(
  file: string,
  env: Record<string, string>,
  cwd: string,
  isFile: (candidate: string) => boolean = (candidate) => {
    try {
      return statSync(candidate).isFile();
    } catch {
      return false;
    }
  },
): string {
  if (!file || file.includes("\0")) throw new Error("Invalid executable path");
  if (/\.(?:bat|cmd)$/i.test(file))
    throw new Error("Windows batch scripts are not supported by the direct CreateProcess backend");
  const direct = path.isAbsolute(file) || /[\\/]/.test(file) || /^[A-Za-z]:/.test(file);
  const extensions = path.extname(file)
    ? [""]
    : (findEnvironmentValue(env, "PATHEXT") ?? ".COM;.EXE")
        .split(";")
        .map((extension) => extension.trim())
        .filter((extension) => extension && !/^\.(?:bat|cmd)$/i.test(extension));
  const roots = direct ? [cwd] : [...(findEnvironmentValue(env, "PATH") ?? "").split(";"), cwd];
  for (const root of roots) {
    const base = path.resolve(cwd, root.replace(/^"|"$/g, "") || cwd, file);
    for (const extension of extensions) {
      const candidate =
        extension && !file.toLowerCase().endsWith(extension.toLowerCase())
          ? base + extension
          : base;
      if (isFile(candidate)) return candidate;
    }
  }
  throw new Error(`Executable not found in child PATH: ${file}`);
}

export function findEnvironmentValue(
  env: Record<string, string>,
  name: string,
): string | undefined {
  const key = Object.keys(env).find((candidate) => candidate.toUpperCase() === name);
  return key === undefined ? undefined : env[key];
}

/** Build the double-NUL-terminated UTF-16 environment block required by CreateProcessW. */
export function buildWindowsEnvironmentBlock(env: Record<string, string>): Buffer {
  const entries = Object.entries(env);
  const seenNames = new Set<string>();
  for (const [name, value] of entries) {
    const driveDirectory = /^=[A-Za-z]:$/.test(name);
    if (
      name.includes("\0") ||
      value.includes("\0") ||
      (!driveDirectory && (!name || name.includes("=")))
    ) {
      throw new Error(`Invalid Windows environment entry: ${JSON.stringify(name)}`);
    }
    const folded = name.toUpperCase();
    if (seenNames.has(folded)) throw new Error(`Duplicate Windows environment name: ${name}`);
    seenNames.add(folded);
  }
  entries.sort(([left], [right]) => {
    const leftDrive = left.startsWith("=");
    const rightDrive = right.startsWith("=");
    if (leftDrive !== rightDrive) return leftDrive ? -1 : 1;
    const upperLeft = left.toUpperCase();
    const upperRight = right.toUpperCase();
    return upperLeft < upperRight ? -1 : upperLeft > upperRight ? 1 : 0;
  });
  const text = entries.map(([name, value]) => `${name}=${value}`).join("\0") + "\0\0";
  return Buffer.from(text, "utf16le");
}
