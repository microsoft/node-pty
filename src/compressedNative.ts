/** Copyright (c) Microsoft Corporation. Licensed under the MIT License. */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export const MANIFEST = 'native-manifest.json';
export const MAX_FILE_SIZE = 64 * 1024 * 1024;
const MAX_MANIFEST_SIZE = 16384;

export interface INativeFile {
  path: string;
  size: number;
  sha512: string;
  compressed: boolean;
  encodedSize?: number;
  encodedSha512?: string;
}
export type NativeCodec = 'brotli' | 'zstd';

// Release packing and runtime validation share the platform policy. macOS keeps
// the compact built-in codec; a native LZFSE bridge would add another loader.
export function nativeCodecForTarget(target: string): NativeCodec {
  allowedFiles(target);
  return target.startsWith('darwin-') ? 'brotli' : 'zstd';
}

export interface INativeManifest {
  version: number;
  codec: NativeCodec;
  target: string;
  files: INativeFile[];
}

// Node 20.12+ avoids allocating a streaming hash for these bounded buffers.
const hash = (crypto as typeof crypto & {
  hash?: (algorithm: string, data: Buffer, encoding: 'hex') => string
}).hash;

export function digest(bytes: Buffer): string {
  if (hash) { return hash('sha512', bytes, 'hex'); }
  return crypto.createHash('sha512').update(bytes).digest('hex');
}

// These are runtime assets, not arbitrary archive paths. Keep Windows DLLs next
// to the addon: conpty resolves its DLL relative to its own loaded image.
function allowedFiles(target: string): string[] {
  if (/^win32-(x64|arm64)$/.test(target)) {
    return ['conpty.node', 'conpty_console_list.node', 'conpty/conpty.dll', 'conpty/OpenConsole.exe'];
  }
  if (/^darwin-(x64|arm64)$/.test(target)) {
    return ['pty.node', 'spawn-helper'];
  }
  if (/^linux-(x64|arm64)$/.test(target)) {
    return ['pty.node'];
  }
  throw new Error(`Unsupported native prebuild target: ${target}`);
}

export function validateManifest(value: INativeManifest, target: string): void {
  const expected = allowedFiles(target);
  if (!value || value.version !== 2 || value.target !== target || value.codec !== nativeCodecForTarget(target) || !Array.isArray(value.files) || value.files.length !== expected.length) {
    throw new Error('Invalid native prebuild manifest or target');
  }
  const seen = new Set<string>();
  for (const file of value.files) {
    if (!file || !expected.includes(file.path) || seen.has(file.path) ||
        !Number.isSafeInteger(file.size) || file.size <= 0 || file.size > MAX_FILE_SIZE ||
        typeof file.sha512 !== 'string' || !/^[a-f0-9]{128}$/.test(file.sha512) ||
        file.compressed !== file.path.endsWith('.node') ||
        (file.compressed && (!Number.isSafeInteger(file.encodedSize) || file.encodedSize! <= 0 || file.encodedSize! > MAX_FILE_SIZE ||
         typeof file.encodedSha512 !== 'string' || !/^[a-f0-9]{128}$/.test(file.encodedSha512)))) {
      throw new Error('Invalid native prebuild file');
    }
    seen.add(file.path);
  }
}

export function readManifest(dir: string, target: string): { manifest: INativeManifest; key: string } {
  const bytes = readRegularFile(path.join(dir, MANIFEST), MAX_MANIFEST_SIZE);
  const manifest: INativeManifest = JSON.parse(bytes.toString('utf8'));
  validateManifest(manifest, target);
  return { manifest, key: digest(bytes) };
}

function readRegularFile(filename: string, maxSize: number, privateFile: boolean = false): Buffer {
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.size > maxSize || stat.size === 0) {
    throw new Error(`Invalid native prebuild file: ${filename}`);
  }
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size > maxSize) {
      throw new Error(`Native prebuild changed while opening: ${filename}`);
    }
    // Check permissions on the opened file rather than statting the path again.
    if (privateFile && process.platform !== 'win32' &&
        (opened.uid !== process.getuid!() || (opened.mode & 0o077) !== 0 ||
         (path.basename(filename) === 'spawn-helper' && (opened.mode & 0o100) === 0))) {
      throw new Error(`Unsafe native prebuild cache file: ${filename}`);
    }
    // Read at most the promised bound even if another process grows the file.
    const bytes = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!count) { throw new Error(`Truncated native prebuild: ${filename}`); }
      offset += count;
    }
    return bytes;
  } finally {
    fs.closeSync(fd);
  }
}

export function verifyBytes(bytes: Buffer, file: INativeFile): void {
  if (bytes.length !== file.size || digest(bytes) !== file.sha512) {
    throw new Error(`Native prebuild integrity check failed: ${file.path}`);
  }
}

function checkDirectory(dir: string, privateDirectory: boolean): void {
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || (process.platform !== 'win32' &&
      ((privateDirectory ? stat.uid !== process.getuid!() : stat.uid !== 0 && stat.uid !== process.getuid!()) ||
       (stat.mode & (privateDirectory ? 0o077 : 0o022)) !== 0))) {
    throw new Error(`Unsafe native prebuild cache directory: ${dir}`);
  }
}

function cacheRoot(): string {
  const configured = process.env.NODE_PTY_CACHE;
  if (configured && !path.isAbsolute(configured)) {
    throw new Error('NODE_PTY_CACHE must be an absolute path');
  }
  // Resolve system aliases such as macOS /var before checking ancestors. Do not
  // resolve the private directory: a symlink there must be rejected.
  const parent = fs.realpathSync(configured ? path.dirname(configured) : os.homedir());
  let ancestor = parent;
  for (;;) {
    checkDirectory(ancestor, false);
    const next = path.dirname(ancestor);
    if (next === ancestor) { break; }
    ancestor = next;
  }
  const root = path.join(parent, configured ? path.basename(configured) : '.node-pty');
  try { fs.mkdirSync(root, { mode: 0o700 }); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') { throw error; }
  }
  checkDirectory(root, true);
  return root;
}

function verifyDirectory(dir: string, manifest: INativeManifest): void {
  checkDirectory(dir, true);
  if (manifest.target.startsWith('win32-')) { checkDirectory(path.join(dir, 'conpty'), true); }
  for (const file of manifest.files) {
    const filename = path.join(dir, file.path);
    verifyBytes(readRegularFile(filename, file.size, true), file);
  }
}

/** Decode into a private staging directory, verify, then publish it atomically.
 * The installed package is never modified; read-only installs and disabled
 * install scripts work. A cache hit is verified before any executable is loaded.
 */
export function materializeNative(dir: string, target: string): string {
  const { manifest, key } = readManifest(dir, target);
  const root = cacheRoot();
  const destination = path.join(root, `v1-${key}`);
  try {
    verifyDirectory(destination, manifest);
    return destination;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error(`Cannot use native cache ${destination}: ${error}. Remove this cache entry and retry.`);
    }
  }
  // Select a backend only when verified compressed bytes actually need decoding.
  let decode: ((encoded: Buffer, size: number) => Buffer) | undefined;
  const stage = fs.mkdtempSync(path.join(root, '.stage-'));
  try {
    for (const file of manifest.files) {
      const source = path.join(dir, file.path + (file.compressed ? (manifest.codec === 'brotli' ? '.br' : '.zst') : ''));
      const encoded = readRegularFile(source, MAX_FILE_SIZE);
      if (file.compressed && (encoded.length !== file.encodedSize || digest(encoded) !== file.encodedSha512)) {
        throw new Error(`Native prebuild compressed integrity check failed: ${file.path}`);
      }
      let bytes = encoded;
      if (file.compressed) {
        if (!decode) {
          // The codec was validated against the platform before reaching here.
          // Never eagerly import both backends or import either on a cache hit.
          decode = manifest.codec === 'brotli'
            ? (require('./compression/brotli') as typeof import('./compression/brotli')).decode
            : (require('./compression/zstd') as typeof import('./compression/zstd')).decode;
        }
        bytes = decode(encoded, file.size);
      }
      verifyBytes(bytes, file);
      const filename = path.join(stage, file.path);
      fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
      fs.writeFileSync(filename, bytes, { flag: 'wx', mode: file.path === 'spawn-helper' ? 0o700 : 0o600 });
    }
    verifyDirectory(stage, manifest);
    try { fs.renameSync(stage, destination); } catch (error) {
      // Another process may have won publication. Never overwrite its files,
      // particularly DLLs that may already be mapped on Windows.
      if (!['EEXIST', 'ENOTEMPTY', 'EPERM'].includes((error as NodeJS.ErrnoException).code || '')) { throw error; }
      verifyDirectory(destination, manifest);
    }
    return destination;
  } finally {
    (fs as typeof fs & { rmSync(p: string, options: { recursive: boolean; force: boolean }): void }).rmSync(stage, { recursive: true, force: true });
  }
}
