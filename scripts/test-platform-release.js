// Install the exact packed wrapper + matching native tarball with lifecycle
// scripts disabled, then exercise native loading and actual PTY I/O.
const fs = require('fs');
const path = require('path');
const os = require('os');
const cp = require('child_process');
const { readRelease } = require('./publish-platform-packages');
const root = path.resolve(process.argv[2]);
const release = readRelease(root, process.argv[3]);
const target = `@node-pty/${process.platform}-${process.arch}`;
const native = release.packages.find(pkg => pkg.name === target);
const wrapper = release.packages.find(pkg => pkg.name === 'node-pty');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'node-pty-packed-'));
try {
  if (!process.env.npm_execpath) { throw new Error('Run through npm run'); }
  const result = cp.spawnSync(process.execPath, [process.env.npm_execpath, 'install', '--ignore-scripts',
    '--no-audit', '--no-fund', '--package-lock=false', path.join(root, wrapper.filename), path.join(root, native.filename)],
  { cwd: work, encoding: 'utf8' });
  if (result.status !== 0) { throw new Error(result.stderr || result.error || 'Install failed'); }
  const installed = path.join(work, 'node_modules/node-pty');
  if (fs.existsSync(path.join(installed, 'build')) || fs.existsSync(path.join(installed, 'prebuilds'))) {
    throw new Error('Packed smoke must use only the optional native package');
  }
  const smoke = cp.spawnSync(process.execPath, [path.resolve(__dirname, '../test/pty-smoke.js'), installed], { stdio: 'inherit' });
  if (smoke.status !== 0) { throw new Error('Packed PTY smoke failed'); }
} finally { fs.rmSync(work, { recursive: true, force: true }); }
