// Copyright (c) Microsoft Corporation. Licensed under the MIT License.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const cp = require('child_process');
const crypto = require('crypto');
const { TARGETS, SCOPE, buildPlatform, buildWrapper, validateVersion, verifyPlatforms, runtimeFiles } = require('../scripts/platform-packages');
const { readRelease, publish } = require('../scripts/publish-platform-packages');
const target = `${process.platform}-${process.arch}`;
let work;
function child(script, env = process.env) {
  return new Promise((resolve, reject) => {
    const p = cp.spawn(process.execPath, ['-e', script], { env });
    let output = '';
    p.stdout.on('data', chunk => output += chunk);
    p.stderr.on('data', chunk => output += chunk);
    p.on('error', reject);
    p.on('exit', code => code === 0 ? resolve(output) : reject(new Error(`Exit ${code}: ${output}`)));
  });
}
function fakeRelease() {
  const root = path.join(work, 'release');
  fs.mkdirSync(root);
  for (const name of TARGETS) {
    const source = path.join(work, name);
    for (const file of runtimeFiles(name)) {
      fs.mkdirSync(path.dirname(path.join(source, file)), { recursive: true });
      const bytes = Buffer.alloc(128);
      const [platform, arch] = name.split('-');
      if (platform === 'darwin') { bytes.writeUInt32LE(0xfeedfacf, 0); bytes.writeUInt32LE(arch === 'arm64' ? 0x100000c : 0x1000007, 4); }
      if (platform === 'linux') { Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1]).copy(bytes); bytes.writeUInt16LE(arch === 'arm64' ? 183 : 62, 18); }
      if (platform === 'win32') { bytes.write('MZ'); bytes.writeUInt32LE(64, 60); bytes.writeUInt32LE(0x4550, 64); bytes.writeUInt16LE(arch === 'arm64' ? 0xaa64 : 0x8664, 68); }
      fs.writeFileSync(path.join(source, file), bytes);
    }
    buildPlatform(source, path.join(root, name), name, '1.2.0-beta.19');
  }
  return root;
}
describe('platform packages', function () {
  this.timeout(30000);
  beforeEach(() => { work = fs.mkdtempSync(path.join(os.tmpdir(), 'node-pty-platform-test-')); });
  afterEach(() => fs.rmSync(work, { recursive: true, force: true }));
  it('validates release version and target before staging', () => {
    for (const version of ['../../bad', '--tag=latest', '1.2', '', '01.2.3', '1.2.3;echo hi']) {
      assert.throws(() => validateVersion(version));
    }
    assert.throws(() => buildPlatform(work, path.join(work, 'out'), '../bad', '1.2.3'));
  });
  it('builds all package metadata with exact optional versions and no debug symbols', () => {
    const root = fakeRelease();
    verifyPlatforms(root, '1.2.0-beta.19');
    buildWrapper(root, '1.2.0-beta.19');
    const wrapper = JSON.parse(fs.readFileSync(path.join(root, 'node-pty/package.json')));
    assert.deepStrictEqual(wrapper.optionalDependencies, Object.fromEntries(TARGETS.map(name => [`${SCOPE}/${name}`, wrapper.version])));
    assert.ok(!wrapper.files.includes('prebuilds/'));
    assert.ok(wrapper.files.includes('third_party/'));
    assert.ok(!wrapper.scripts.prepare && !wrapper.scripts.prepublishOnly);
    for (const name of TARGETS) {
      const pkg = JSON.parse(fs.readFileSync(path.join(root, name, 'package.json')));
      assert.deepStrictEqual(pkg.os, [name.split('-')[0]]);
      assert.deepStrictEqual(pkg.cpu, [name.split('-')[1]]);
      assert.ok(!pkg.scripts);
      assert.ok(!pkg.files.some(file => file.endsWith('.pdb')));
      if (name.startsWith('linux-')) { assert.deepStrictEqual(pkg.libc, ['glibc']); }
    }
  });
  it('refuses incomplete or mismatched releases before creating the wrapper', () => {
    const root = fakeRelease();
    fs.unlinkSync(path.join(root, 'darwin-x64/pty.node'));
    assert.throws(() => buildWrapper(root, '1.2.0-beta.19'));
    assert.ok(!fs.existsSync(path.join(root, 'node-pty')));
  });
  it('checks every tarball and publish order before publishing anything', () => {
    const packages = [...TARGETS.map(name => `${SCOPE}/${name}`), 'node-pty'].map((name, i) => {
      const filename = `${i}.tgz`;
      const bytes = Buffer.from(name);
      fs.writeFileSync(path.join(work, filename), bytes);
      return { name, version: '1.2.0-beta.19', filename, integrity: 'sha512-' + crypto.createHash('sha512').update(bytes).digest('base64') };
    });
    const release = { version: '1.2.0-beta.19', packages };
    fs.writeFileSync(path.join(work, 'release.json'), JSON.stringify(release));
    assert.strictEqual(readRelease(work, 'beta').packages.length, 7);
    assert.throws(() => readRelease(work, 'latest'));
    publish(work, 'beta'); // Dry run must not contact npm.
    const calls = [];
    publish(work, 'beta', true, args => {
      calls.push(args);
      return args[0] === 'view' ? { status: 1, stderr: 'E404' } : { status: 0, stdout: 'published' };
    });
    assert.deepStrictEqual(calls.filter(args => args[0] === 'publish').map(args => path.basename(args[1])), packages.map(pkg => pkg.filename));
    let attempts = 0;
    assert.throws(() => publish(work, 'beta', true, args => {
      if (args[0] === 'view') { return { status: 1, stderr: 'E404' }; }
      attempts++;
      return { status: 1, stderr: 'registry unavailable' };
    }), /registry unavailable/);
    assert.strictEqual(attempts, 1);
    let views = 0;
    publish(work, 'beta', true, args => {
      assert.strictEqual(args[0], 'view');
      return { status: 0, stdout: JSON.stringify(packages[views++].integrity) };
    });
    assert.strictEqual(views, 7);
    assert.throws(() => publish(work, 'beta', true, () => ({ status: 0, stdout: JSON.stringify('sha512-other') })), /Published bytes differ/);
    fs.appendFileSync(path.join(work, '0.tgz'), 'corrupt');
    assert.throws(() => publish(work, 'beta', true), /Changed release artifact/);
    release.packages.reverse();
    fs.writeFileSync(path.join(work, 'release.json'), JSON.stringify(release));
    assert.throws(() => readRelease(work, 'beta'), /publish order/);
  });
  it('loads a real PTY with only the matching optional package and no install scripts', async () => {
    const pkg = path.join(work, 'node-pty');
    fs.cpSync(path.resolve(__dirname, '../lib'), path.join(pkg, 'lib'), { recursive: true });
    fs.cpSync(path.resolve(__dirname, '../scripts'), path.join(pkg, 'scripts'), { recursive: true });
    const native = path.join(pkg, 'node_modules', SCOPE, target);
    buildPlatform(process.env.NODE_PTY_TEST_SOURCE || path.resolve(__dirname, '../build/Release'), native, target, '1.2.0-beta.19');
    const result = cp.spawnSync(process.execPath, [path.join(pkg, 'scripts/prebuild.js')], { encoding: 'utf8' });
    assert.strictEqual(result.status, 0, result.stderr);
    assert.match(result.stdout, /Using platform package/);
    const forced = cp.spawnSync(process.execPath, [path.join(pkg, 'scripts/prebuild.js')], {
      env: { ...process.env, npm_config_build_from_source: 'true' }, encoding: 'utf8'
    });
    assert.strictEqual(forced.status, 1);
    assert.ok(fs.existsSync(path.join(native, runtimeFiles(target)[0])));
    await child(`
      const pty = require(${JSON.stringify(path.join(pkg, 'lib'))});
      const term = pty.spawn(process.platform === 'win32' ? 'cmd.exe' : '/bin/sh',
        process.platform === 'win32' ? ['/c', 'echo optional-ok'] : ['-c', 'printf optional-ok'],
        { env: process.env, cwd: process.cwd(), useConptyDll: true });
      let output = '';
      term.onData(data => output += data);
      term.onExit(({ exitCode }) => { if (exitCode !== 0 || !output.includes('optional-ok')) process.exit(1); });
      setTimeout(() => process.exit(2), 10000).unref();
    `);
  });
  it('falls back to source builds when optional dependencies are omitted', () => {
    const pkg = path.join(work, 'missing');
    fs.cpSync(path.resolve(__dirname, '../scripts'), path.join(pkg, 'scripts'), { recursive: true });
    const result = cp.spawnSync(process.execPath, [path.join(pkg, 'scripts/prebuild.js')], { encoding: 'utf8' });
    assert.strictEqual(result.status, 1);
  });
});
