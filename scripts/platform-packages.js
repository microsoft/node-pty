// Copyright (c) Microsoft Corporation. Licensed under the MIT License.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cp = require('child_process');
const { verifyNativeTarget } = require('./native-target');

const TARGETS = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-arm64', 'win32-x64'];
const ROOT = path.resolve(__dirname, '..');
const SCOPE = '@node-pty';

function validateVersion(version) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/.test(version)) {
    throw new Error(`Invalid release version: ${version}`);
  }
}
function runtimeFiles(target) {
  if (!TARGETS.includes(target)) { throw new Error(`Unknown target: ${target}`); }
  return target.startsWith('win32-')
    ? ['conpty.node', 'conpty_console_list.node', 'conpty/conpty.dll', 'conpty/OpenConsole.exe']
    : target.startsWith('darwin-') ? ['pty.node', 'spawn-helper'] : ['pty.node'];
}
function copyFile(source, destination) {
  if (!fs.lstatSync(source).isFile()) { throw new Error(`Not a regular file: ${source}`); }
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
}
function writeJson(filename, value) { fs.writeFileSync(filename, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' }); }

function buildPlatform(source, output, target, version) {
  validateVersion(version);
  const files = runtimeFiles(target);
  fs.mkdirSync(output, { recursive: true });
  const [os, cpu] = target.split('-');
  for (const file of files) {
    const input = path.join(source, file);
    if (file.endsWith('.node')) { verifyNativeTarget(fs.readFileSync(input), target); }
    copyFile(input, path.join(output, file));
  }
  if (target.startsWith('darwin-')) { fs.chmodSync(path.join(output, 'spawn-helper'), 0o755); }
  copyFile(path.join(ROOT, 'LICENSE'), path.join(output, 'LICENSE'));
  writeJson(path.join(output, 'package.json'), {
    name: `${SCOPE}/${target}`, version, description: `Native binaries for node-pty on ${target}`,
    license: 'MIT', repository: require('../package.json').repository, os: [os], cpu: [cpu],
    // Match the glibc 2.28 sysroot used by the existing prebuild pipeline.
    ...(os === 'linux' ? { libc: ['glibc'] } : {}),
    files: [...files, 'LICENSE', 'README.md']
  });
  fs.writeFileSync(path.join(output, 'README.md'), `# ${SCOPE}/${target}\n\nNative binaries for node-pty. Installed automatically as an optional dependency.\n`);
}

function verifyPlatforms(root, version) {
  for (const target of TARGETS) {
    const dir = path.join(root, target);
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    const [os, cpu] = target.split('-');
    if (pkg.name !== `${SCOPE}/${target}` || pkg.version !== version ||
        JSON.stringify(pkg.os) !== JSON.stringify([os]) || JSON.stringify(pkg.cpu) !== JSON.stringify([cpu]) ||
        (os === 'linux' && JSON.stringify(pkg.libc) !== '["glibc"]')) {
      throw new Error(`Mismatched platform package: ${target}`);
    }
    for (const file of runtimeFiles(target)) {
      const stat = fs.lstatSync(path.join(dir, file));
      if (!stat.isFile() || !stat.size) { throw new Error(`Missing runtime file: ${target}/${file}`); }
      if (file.endsWith('.node')) { verifyNativeTarget(fs.readFileSync(path.join(dir, file)), target); }
    }
  }
}

function buildWrapper(root, version) {
  validateVersion(version);
  verifyPlatforms(root, version);
  const output = path.join(root, 'node-pty');
  fs.mkdirSync(output);
  // npm's file list selects public JS, typings, and source-build inputs. Source
  // builds keep third_party conpty assets, including unsupported architectures.
  const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  for (const name of ['lib', 'src', 'scripts', 'typings', 'third_party']) {
    fs.cpSync(path.join(ROOT, name), path.join(output, name), { recursive: true });
  }
  for (const name of ['binding.gyp', 'LICENSE', 'README.md']) { copyFile(path.join(ROOT, name), path.join(output, name)); }
  packageJson.version = version;
  packageJson.files = packageJson.files.filter(file => file !== 'prebuilds/');
  packageJson.optionalDependencies = Object.fromEntries(TARGETS.map(target => [`${SCOPE}/${target}`, version]));
  // Publishing a staged package must not compile or change release inputs.
  delete packageJson.scripts.prepare;
  delete packageJson.scripts.prepublishOnly;
  writeJson(path.join(output, 'package.json'), packageJson);
}

function npm(args, options = {}) {
  // npm_execpath avoids shell quoting and npm.cmd behavior on Windows.
  const npmPath = process.env.npm_execpath;
  if (!npmPath) { throw new Error('Run this script through npm run'); }
  const result = cp.spawnSync(process.execPath, [npmPath, ...args], { encoding: 'utf8', ...options });
  if (result.status !== 0) { throw new Error(result.stderr || result.error || `npm ${args[0]} failed`); }
  return result.stdout;
}
function packRelease(root, version) {
  verifyPlatforms(root, version);
  const artifacts = path.join(root, 'tarballs');
  fs.mkdirSync(artifacts);
  const packages = [];
  for (const target of [...TARGETS, 'node-pty']) {
    const dir = path.join(root, target);
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    const report = JSON.parse(npm(['pack', '--ignore-scripts', '--json', '--pack-destination', artifacts], { cwd: dir }));
    const packed = Array.isArray(report) ? report[0] : Object.values(report)[0];
    const bytes = fs.readFileSync(path.join(artifacts, packed.filename));
    packages.push({ name: pkg.name, version: pkg.version, filename: packed.filename,
      integrity: `sha512-${crypto.createHash('sha512').update(bytes).digest('base64')}` });
  }
  writeJson(path.join(artifacts, 'release.json'), { version, packages });
}

if (require.main === module) {
  const [command, root, version, target] = process.argv.slice(2);
  if (command === 'platform') {
    buildPlatform(path.join(ROOT, 'build/Release'), path.join(path.resolve(root), target), target, version);
  } else if (command === 'release') {
    buildWrapper(path.resolve(root), version);
    packRelease(path.resolve(root), version);
  } else { throw new Error('Usage: npm run package:platforms -- platform|release OUTPUT VERSION [TARGET]'); }
}
module.exports = { TARGETS, SCOPE, runtimeFiles, validateVersion, buildPlatform, buildWrapper, verifyPlatforms };
