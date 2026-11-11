import { dlopen } from "node:ffi";
import { lstatSync, realpathSync } from "node:fs";
import { dirname } from "node:path";
import { win32 as windowsPath } from "node:path";
import { encodeWindowsString } from "./windows-launch.mts";

const INVALID_HANDLE_VALUE = 0xffff_ffff_ffff_ffffn;
const GENERIC_READ = 0x8000_0000;
const FILE_READ_ATTRIBUTES = 0x0000_0080;
const FILE_SHARE_READ = 0x0000_0001;
const FILE_SHARE_WRITE = 0x0000_0002;
const OPEN_EXISTING = 3;
const FILE_FLAG_OPEN_REPARSE_POINT = 0x0020_0000;
const FILE_FLAG_BACKUP_SEMANTICS = 0x0200_0000;
const FILE_ATTRIBUTE_DIRECTORY = 0x0010;
const FILE_ATTRIBUTE_REPARSE_POINT = 0x0400;

export interface LockBindings {
  CreateFileW(
    path: Buffer,
    access: number,
    share: number,
    security: bigint,
    disposition: number,
    flags: number,
    template: bigint,
  ): bigint;
  GetFileInformationByHandle(handle: bigint, info: Buffer): number;
  CloseHandle(handle: bigint): number;
  GetLastError(): number;
}

export interface WindowsHelperLock {
  readonly path: string;
  release(): void;
}

let bindings: LockBindings | undefined;

export function loadWindowsHelperLockBindings(): LockBindings {
  if (!bindings) {
    bindings = dlopen("kernel32.dll", {
      CreateFileW: {
        arguments: ["pointer", "uint32", "uint32", "pointer", "uint32", "uint32", "pointer"],
        return: "pointer",
      },
      GetFileInformationByHandle: { arguments: ["pointer", "pointer"], return: "int32" },
      CloseHandle: { arguments: ["pointer"], return: "int32" },
      GetLastError: { arguments: [], return: "uint32" },
    }).functions as unknown as LockBindings;
  }
  return bindings;
}

export function rejectReparsePath(path: string): void {
  if (!windowsPath.isAbsolute(path)) throw new TypeError("helper path must be absolute");
  const parsed = windowsPath.parse(path);
  const parts = path
    .slice(parsed.root.length)
    .split(/[\\/]+/)
    .filter(Boolean);
  let current = parsed.root;
  for (const part of parts) {
    current = windowsPath.resolve(current, part);
    if (lstatSync(current).isSymbolicLink())
      throw new Error(`helper path contains a reparse point: ${current}`);
  }
}

export function canonicalHelperPath(path: string): string {
  if (process.platform !== "win32") throw new Error("Windows helper locks require Windows");
  if (!windowsPath.isAbsolute(path)) throw new TypeError("helper path must be absolute");
  rejectReparsePath(path);
  const canonical = realpathSync.native(path);
  if (!windowsPath.isAbsolute(canonical))
    throw new Error("helper path did not resolve to an absolute path");
  return canonical;
}

export function openHelperLockHandle(
  native: LockBindings,
  path: string,
  access: number,
  share: number,
  flags: number,
): bigint {
  const handle = native.CreateFileW(
    encodeWindowsString(path),
    access,
    share,
    0n,
    OPEN_EXISTING,
    flags | FILE_FLAG_OPEN_REPARSE_POINT,
    0n,
  );
  if (handle === 0n || handle === INVALID_HANDLE_VALUE) {
    throw new Error(`CreateFileW failed for helper lock with Win32 error ${native.GetLastError()}`);
  }
  return handle;
}

export function helperHandleAttributes(native: LockBindings, handle: bigint): number {
  const info = Buffer.alloc(52);
  if (!native.GetFileInformationByHandle(handle, info)) {
    throw new Error(`GetFileInformationByHandle failed with Win32 error ${native.GetLastError()}`);
  }
  return info.readUInt32LE(0);
}

export function assertNotReparsePoint(attributes: number, path: string): void {
  if (attributes & FILE_ATTRIBUTE_REPARSE_POINT)
    throw new Error(`helper path is a reparse point: ${path}`);
}

export function closeWindowsHandlePair(
  native: LockBindings,
  fileHandle: bigint,
  directoryHandle: bigint,
): void {
  let failure: Error | undefined;
  for (const handle of [fileHandle, directoryHandle]) {
    if (!handle) continue;
    try {
      if (!native.CloseHandle(handle)) failure ??= new Error("CloseHandle failed for helper lock");
    } catch (error) {
      failure ??= error instanceof Error ? error : new Error(String(error));
    }
  }
  if (failure) throw failure;
}

export function lockWindowsHelper(path: string, injected?: LockBindings): WindowsHelperLock {
  if (process.platform !== "win32") throw new Error("Windows helper locks require Windows");
  const canonical = canonicalHelperPath(path);
  const native = injected ?? loadWindowsHelperLockBindings();
  let directoryHandle = 0n;
  let fileHandle = 0n;
  try {
    const directory = dirname(canonical);
    directoryHandle = openHelperLockHandle(
      native,
      directory,
      FILE_READ_ATTRIBUTES,
      FILE_SHARE_READ | FILE_SHARE_WRITE,
      FILE_FLAG_BACKUP_SEMANTICS,
    );
    const directoryAttributes = helperHandleAttributes(native, directoryHandle);
    if (!(directoryAttributes & FILE_ATTRIBUTE_DIRECTORY))
      throw new Error("helper parent is not a directory");
    assertNotReparsePoint(directoryAttributes, directory);

    fileHandle = openHelperLockHandle(native, canonical, GENERIC_READ, FILE_SHARE_READ, 0);
    const fileAttributes = helperHandleAttributes(native, fileHandle);
    if (fileAttributes & FILE_ATTRIBUTE_DIRECTORY) throw new Error("helper path is a directory");
    assertNotReparsePoint(fileAttributes, canonical);
  } catch (error) {
    try {
      closeWindowsHandlePair(native, fileHandle, directoryHandle);
    } catch {
      // Preserve the lock acquisition error after attempting both closes.
    }
    throw error;
  }

  let released = false;
  return {
    path: canonical,
    release() {
      if (released) return;
      released = true;
      closeWindowsHandlePair(native, fileHandle, directoryHandle);
    },
  };
}
