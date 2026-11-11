import { dlopen } from "node:ffi";

const RTL_OSVERSIONINFOW_SIZE = 276;
const CONPTY_MINIMUM: WindowsVersion = { major: 10, minor: 0, build: 17763 };
const DIRECT_FFI_MINIMUM: WindowsVersion = { major: 10, minor: 0, build: 26100 };

export interface WindowsVersion {
  major: number;
  minor: number;
  build: number;
}

export type WindowsVersionMode = "unsupported" | "helper" | "ffi";

export interface WindowsVersionBindings {
  RtlGetVersion(info: Buffer): number;
}

let cachedBindings: WindowsVersionBindings | undefined;

export function loadWindowsVersionBindings(): WindowsVersionBindings {
  if (!cachedBindings) {
    cachedBindings = dlopen("ntdll.dll", {
      RtlGetVersion: { arguments: ["pointer"], return: "int32" },
    }).functions as unknown as WindowsVersionBindings;
  }
  return cachedBindings;
}

export function isValidWindowsVersion(value: unknown): value is WindowsVersion {
  if (!value || typeof value !== "object") return false;
  const version = value as WindowsVersion;
  return [version.major, version.minor, version.build].every(
    (part) => Number.isInteger(part) && part >= 0 && part <= 0xffff_ffff,
  );
}

export function parseWindowsVersion(value: string): WindowsVersion {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:\.\d+)?$/.exec(value);
  if (!match) throw new TypeError(`Invalid Windows version: ${value}`);
  const version = { major: Number(match[1]), minor: Number(match[2]), build: Number(match[3]) };
  if (!isValidWindowsVersion(version)) throw new TypeError(`Invalid Windows version: ${value}`);
  return version;
}

export function classifyWindowsVersion(version: WindowsVersion): WindowsVersionMode {
  if (!isValidWindowsVersion(version)) throw new TypeError("Invalid Windows version fields");
  if (compareWindowsVersions(version, CONPTY_MINIMUM) < 0) return "unsupported";
  if (compareWindowsVersions(version, DIRECT_FFI_MINIMUM) < 0) return "helper";
  return "ffi";
}

export function compareWindowsVersions(left: WindowsVersion, right: WindowsVersion): number {
  for (const field of ["major", "minor", "build"] as const) {
    if (left[field] !== right[field]) return left[field] < right[field] ? -1 : 1;
  }
  return 0;
}

export function detectWindowsVersion(platform: NodeJS.Platform = process.platform): WindowsVersion {
  if (platform !== "win32") throw new Error("Windows version detection requires Windows");
  const bindings = loadWindowsVersionBindings();
  // RTL_OSVERSIONINFOW contains five DWORDs and 128 UTF-16 WCHARs (276 bytes).
  const info = Buffer.alloc(RTL_OSVERSIONINFOW_SIZE);
  info.writeUInt32LE(RTL_OSVERSIONINFOW_SIZE, 0);
  const status = bindings.RtlGetVersion(info);
  if (status !== 0) throw new Error(`RtlGetVersion failed with NTSTATUS ${status}`);
  const version = {
    major: info.readUInt32LE(4),
    minor: info.readUInt32LE(8),
    build: info.readUInt32LE(12),
  };
  if (!isValidWindowsVersion(version)) throw new Error("RtlGetVersion returned invalid fields");
  return version;
}
