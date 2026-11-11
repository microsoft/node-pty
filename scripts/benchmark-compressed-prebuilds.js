// npm run benchmark:compressed -- /path/to/unpacked/published/package [provenance.json]
// Uses the original release's native inputs; never changes that directory.
const fs = require('fs');
const path = require('path');
const os = require('os');
const cp = require('child_process');
const assert = require('assert');
const crypto = require('crypto');
const { compressPrebuild } = require('./compress-prebuilds');
const original = path.resolve(process.argv[2]);
const provenance = process.argv[3] ? JSON.parse(fs.readFileSync(process.argv[3], 'utf8')) : undefined;
const work = fs.mkdtempSync(path.join(os.homedir(), '.node-pty-bench-'));
function run(command, args, options = {}) {
  const result = cp.spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.status !== 0) { throw new Error(result.stderr || result.error || `Exit ${result.status}`); }
  return result.stdout;
}
function pack(dir, destination) {
  fs.mkdirSync(destination);
  const report = JSON.parse(run(process.execPath, [process.env.npm_execpath, 'pack', dir,
    '--ignore-scripts', '--json', '--pack-destination', destination]));
  const item = Array.isArray(report) ? report[0] : Object.values(report)[0];
  const files = item.files.map(file => ({ path: file.path, bytes: file.size,
    sha512: crypto.createHash('sha512').update(fs.readFileSync(path.join(dir, file.path))).digest('hex') }));
  assert.strictEqual(files.reduce((sum, file) => sum + file.bytes, 0), item.unpackedSize);
  return { tarballBytes: item.size, unpackedBytes: item.unpackedSize, integrity: item.integrity, files };
}
try {
  const raw = path.join(work, 'raw');
  const compressed = path.join(work, 'compressed');
  fs.cpSync(original, raw, { recursive: true });
  fs.cpSync(original, compressed, { recursive: true });
  for (const file of ['utils.js', 'compressedNative.js']) {
    fs.copyFileSync(path.join(__dirname, '../lib', file), path.join(compressed, 'lib', file));
  }
  fs.cpSync(path.join(__dirname, '../lib/compression'), path.join(compressed, 'lib/compression'), { recursive: true });
  const inputs = [];
  for (const target of fs.readdirSync(path.join(compressed, 'prebuilds')).sort()) {
    const dir = path.join(compressed, 'prebuilds', target);
    const manifest = compressPrebuild(dir, target);
    for (const file of manifest.files.filter(file => file.compressed)) {
      inputs.push({ target, codec: manifest.codec, file: file.path, rawBytes: file.size, compressedBytes: file.encodedSize, sha512: file.sha512 });
    }
  }
  const sizes = { baseline: pack(raw, path.join(work, 'pack-raw')), compressed: pack(compressed, path.join(work, 'pack-compressed')) };
  if (provenance) {
    assert.strictEqual(sizes.baseline.integrity, provenance.integrity, 'Repacked baseline must match the verified registry archive');
    assert.strictEqual(sizes.baseline.tarballBytes, provenance.downloadBytes);
    assert.strictEqual(sizes.baseline.unpackedBytes, provenance.unpackedBytes);
  }
  const changed = new Set(['lib/utils.js', ...sizes.compressed.files.filter(file =>
    file.path === 'lib/compressedNative.js' || file.path.startsWith('lib/compression/') ||
    /\.(node|br|zst)$/.test(file.path) || file.path.endsWith('/native-manifest.json')).map(file => file.path),
  ...sizes.baseline.files.filter(file => file.path.endsWith('.node')).map(file => file.path)]);
  for (const file of sizes.baseline.files.filter(file => !changed.has(file.path))) {
    assert.deepStrictEqual(sizes.compressed.files.find(other => other.path === file.path), file);
  }
  const breakdown = {};
  for (const file of sizes.baseline.files) {
    const category = file.path.endsWith('.node') ? 'nativeAddons' :
      /\.(dll|exe|pdb)$/.test(file.path) ? 'windowsCompanionsAndSymbols' : 'otherFiles';
    breakdown[category] = (breakdown[category] || 0) + file.bytes;
  }
  const timings = [];
  for (let round = 0; round < 21; round++) {
    const cache = path.join(work, `cache-${round}`);
    const load = (kind, dir) => {
      const output = run(process.execPath, [path.join(__dirname, '../test/pty-smoke.js'), dir], {
        env: { ...process.env, NODE_PTY_CACHE: cache }
      });
      timings.push({ round, kind, ...JSON.parse(output) });
    };
    if (round % 2 === 0) { load('raw', raw); }
    load('first', compressed);
    load('cached', compressed);
    if (round % 2 !== 0) { load('raw', raw); }
  }
  const medians = Object.fromEntries(['raw', 'first', 'cached'].map(kind => {
    const values = timings.filter(row => row.kind === kind).map(row => row.requireMs).sort((a, b) => a - b);
    return [kind, values[Math.floor(values.length / 2)]];
  }));
  const cacheFiles = fs.readdirSync(path.join(work, 'cache-0'), { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile()).map(entry => ({ path: path.relative(path.join(work, 'cache-0'), path.join(entry.parentPath, entry.name)),
      bytes: fs.statSync(path.join(entry.parentPath, entry.name)).size }));
  console.log(JSON.stringify({ measuredAt: new Date().toISOString(), node: process.version, npm: run(process.execPath, [process.env.npm_execpath, '--version']).trim(), platform: process.platform, arch: process.arch,
    packageVersion: JSON.parse(fs.readFileSync(path.join(raw, 'package.json'))).version,
    method: 'Twenty-one fresh processes per mode; alternating raw ordering, unique first-load cache each round; no page-cache eviction. Each process spawns and verifies a real PTY.',
    provenance, inputs, sizes, baselineBreakdown: breakdown,
    currentPlatformCache: { files: cacheFiles, bytes: cacheFiles.reduce((sum, file) => sum + file.bytes, 0) },
    medianRequireMs: medians, timings }, null, 2));
} finally { fs.rmSync(work, { recursive: true, force: true }); }
