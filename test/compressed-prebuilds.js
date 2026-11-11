// Copyright (c) Microsoft Corporation. Licensed under the MIT License.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const zlib = require('zlib');
const { compressPrebuild } = require('../scripts/compress-prebuilds');
const { MANIFEST, materializeNative, validateManifest } = require('../lib/compressedNative');

const target = `${process.platform}-${process.arch}`;
const source = process.env.NODE_PTY_TEST_SOURCE || path.resolve(__dirname, '../build/Release');
const names = process.platform === 'win32'
  ? ['conpty.node', 'conpty_console_list.node', 'conpty/conpty.dll', 'conpty/OpenConsole.exe']
  : process.platform === 'darwin' ? ['pty.node', 'spawn-helper'] : ['pty.node'];
// Use the home directory so POSIX ancestor checks also run under CI runners
// whose temporary directory may be shared or group-writable.
let work;
let input;
let manifest;
let suffix;
let previousCache;
function copyAssets(destination) {
  for (const name of names) {
    fs.mkdirSync(path.dirname(path.join(destination, name)), { recursive: true });
    fs.copyFileSync(path.join(source, name), path.join(destination, name));
  }
}
function child(script) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['-e', script], { env: process.env });
    let output = '';
    p.stdout.on('data', bytes => output += bytes);
    p.stderr.on('data', bytes => output += bytes);
    p.on('error', reject);
    p.on('exit', code => code === 0 ? resolve(output) : reject(new Error(output)));
  });
}

describe('compressed prebuilds', function () {
  this.timeout(60000);
  beforeEach(() => {
    work = fs.mkdtempSync(path.join(os.homedir(), '.node-pty-test-'));
    input = path.join(work, 'input');
    copyAssets(input);
    manifest = compressPrebuild(input, target);
    suffix = manifest.codec === 'brotli' ? '.br' : '.zst';
    previousCache = process.env.NODE_PTY_CACHE;
    process.env.NODE_PTY_CACHE = path.join(work, 'cache');
  });
  afterEach(() => {
    if (previousCache === undefined) { delete process.env.NODE_PTY_CACHE; }
    else { process.env.NODE_PTY_CACHE = previousCache; }
    fs.rmSync(work, { recursive: true, force: true });
  });
  it('round-trips every byte and preserves companion paths and helper permissions', () => {
    const dir = materializeNative(input, target);
    for (const name of names) {
      assert.deepStrictEqual(fs.readFileSync(path.join(dir, name)), fs.readFileSync(path.join(source, name)));
    }
    if (process.platform === 'darwin') { assert.ok(fs.statSync(path.join(dir, 'spawn-helper')).mode & 0o100); }
    assert.strictEqual(materializeNative(input, target), dir);
    assert.ok(!fs.existsSync(path.join(input, names[0])));
    assert.ok(!fs.readdirSync(process.env.NODE_PTY_CACHE).some(name => name.startsWith('.stage-')));
  });
  it('works with a read-only package directory', function () {
    if (process.platform === 'win32') { this.skip(); }
    fs.chmodSync(input, 0o555);
    try { assert.ok(materializeNative(input, target)); } finally { fs.chmodSync(input, 0o755); }
  });
  it('rejects wrong targets, paths, duplicates and oversized output declarations', () => {
    assert.throws(() => validateManifest(manifest, 'bad-target'));
    for (const change of [m => m.files[0].path = '../escape.node', m => m.files[0].size = 2 ** 32,
      m => m.files.push(m.files[0]), m => m.files[0].compressed = false, m => m.version++, m => m.codec = 'unsupported', m => m.codec = m.codec === 'brotli' ? 'zstd' : 'brotli']) {
      const copy = JSON.parse(JSON.stringify(manifest));
      change(copy);
      assert.throws(() => validateManifest(copy, target));
    }
  });
  it('rejects payload corruption before publishing any executable', () => {
    fs.writeFileSync(path.join(input, names[0] + suffix), Buffer.from('corrupt'));
    assert.throws(() => materializeNative(input, target));
    assert.deepStrictEqual(fs.readdirSync(process.env.NODE_PTY_CACHE), []);
  });
  it('rejects corrupt payloads before loading any decoder backend', async () => {
    fs.writeFileSync(path.join(input, names[0] + suffix), Buffer.from('corrupt'));
    await child(`
      const assert = require('assert');
      const Module = require('module');
      const load = Module._load;
      Module._load = function(name, ...args) {
        assert.ok(name !== 'zlib' && name !== 'node:zlib' && !name.includes('/compression/'), 'unverified payload must not load a decoder');
        return load.call(this, name, ...args);
      };
      const { materializeNative } = require(${JSON.stringify(path.resolve(__dirname, '../lib/compressedNative'))});
      assert.throws(() => materializeNative(${JSON.stringify(input)}, ${JSON.stringify(target)}), /compressed integrity check failed/);
    `);
  });
  it('enforces the output bound before hashing', () => {
    const file = manifest.files[0];
    file.size = 1;
    fs.writeFileSync(path.join(input, MANIFEST), JSON.stringify(manifest));
    assert.throws(() => materializeNative(input, target), /larger than|size|length/i);
  });
  it('rejects valid compression with the wrong bytes', () => {
    const file = manifest.files[0];
    fs.writeFileSync(path.join(input, file.path + suffix), (manifest.codec === 'brotli' ? zlib.brotliCompressSync : zlib.zstdCompressSync)(Buffer.alloc(file.size)));
    assert.throws(() => materializeNative(input, target), /integrity/);
  });
  it('rejects cache corruption instead of loading it', () => {
    const dir = materializeNative(input, target);
    fs.writeFileSync(path.join(dir, names[0]), Buffer.from('corrupt'));
    assert.throws(() => materializeNative(input, target), /Remove this cache entry/);
  });
  it('rejects cached files with unsafe permissions', function () {
    if (process.platform === 'win32') { this.skip(); }
    const dir = materializeNative(input, target);
    fs.chmodSync(path.join(dir, names[0]), 0o644);
    assert.throws(() => materializeNative(input, target), /Unsafe native prebuild cache file/);
  });
  it('rejects relative cache overrides', () => {
    process.env.NODE_PTY_CACHE = 'relative';
    assert.throws(() => materializeNative(input, target), /absolute/);
  });
  it('rejects symlinked or shared cache directories', function () {
    if (process.platform === 'win32') { this.skip(); }
    const cache = process.env.NODE_PTY_CACHE;
    fs.mkdirSync(cache, { mode: 0o700 });
    fs.chmodSync(cache, 0o777);
    assert.throws(() => materializeNative(input, target), /Unsafe/);
    fs.rmdirSync(cache);
    fs.symlinkSync(input, cache, 'dir');
    assert.throws(() => materializeNative(input, target), /Unsafe/);
  });
  it('coordinates simultaneous first loads without partial files', async () => {
    const script = `console.log(require(${JSON.stringify(path.resolve(__dirname, '../lib/compressedNative'))}).materializeNative(${JSON.stringify(input)}, ${JSON.stringify(target)}))`;
    const results = await Promise.all(Array.from({ length: 6 }, () => child(script)));
    assert.strictEqual(new Set(results).size, 1);
    assert.strictEqual(fs.readdirSync(process.env.NODE_PTY_CACHE).length, 1);
  });
  it('loads and spawns a real PTY from an isolated compressed-only package', async () => {
    const pkg = path.join(work, 'package');
    fs.cpSync(path.resolve(__dirname, '../lib'), path.join(pkg, 'lib'), { recursive: true });
    fs.cpSync(input, path.join(pkg, 'prebuilds', target), { recursive: true });
    const script = `
      const pty = require(${JSON.stringify(path.join(pkg, 'lib'))});
      const term = pty.spawn(process.platform === 'win32' ? 'cmd.exe' : '/bin/sh',
        process.platform === 'win32' ? ['/c', 'echo compressed-ok'] : ['-c', 'printf compressed-ok'],
        { env: process.env, cwd: process.cwd(), useConptyDll: true });
      let output = '';
      term.onData(data => output += data);
      term.onExit(({ exitCode }) => { if (exitCode !== 0 || !output.includes('compressed-ok')) process.exit(1); });
      setTimeout(() => process.exit(2), 10000).unref();
    `;
    // Cold loads may load only the selected platform backend.
    await child(`
      const assert = require('assert');
      const Module = require('module');
      const load = Module._load;
      const wrongBackend = ${JSON.stringify(manifest.codec === 'brotli' ? 'zstd' : 'brotli')};
      Module._load = function(name, ...args) {
        assert.ok(!name.endsWith('/compression/' + wrongBackend), 'must not load the other backend');
        return load.call(this, name, ...args);
      };
      ${script}
    `);
    // A fresh process with a populated cache must not initialize any compression backend.
    await child(`
      const assert = require('assert');
      const Module = require('module');
      const load = Module._load;
      Module._load = function(name, ...args) {
        assert.ok(name !== 'zlib' && name !== 'node:zlib' && !name.includes('/compression/'), 'cached loads must not load any decoder backend');
        return load.call(this, name, ...args);
      };
      ${script}
      const { loadNativeModule } = require(${JSON.stringify(path.join(pkg, 'lib/utils'))});
      const name = process.platform === 'win32' ? 'conpty' : 'pty';
      assert.strictEqual(loadNativeModule(name), loadNativeModule(name));
    `);
    // Process-local reuse must not allow a later process to trust changed files.
    const cached = materializeNative(input, target);
    fs.writeFileSync(path.join(cached, names[0]), Buffer.from('corrupt'));
    await assert.rejects(child(script), /integrity check failed/);
  });
});
