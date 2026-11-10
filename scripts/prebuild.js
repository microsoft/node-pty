//@ts-check

const fs = require('fs');
const path = require('path');

/**
 * This script checks for the prebuilt binaries for the current platform and
 * architecture. It exits with 0 if prebuilds are found and 1 if not.
 *
 * If npm_config_build_from_source is set then it removes the prebuilds for the
 * current platform so they are not loaded at runtime.
 *
 * Usage:
 *     node scripts/prebuild.js
 */

const PREBUILDS_ROOT = path.join(__dirname, '..', 'prebuilds');
const PREBUILD_DIR = path.join(__dirname, '..', 'prebuilds', `${process.platform}-${process.arch}`);

// Do not use prebuilds when npm_config_build_from_source is set
if (process.env.npm_config_build_from_source === 'true') {
  console.log('\x1b[33m> Removing prebuilds and rebuilding because npm_config_build_from_source is set\x1b[0m');
  fs.rmSync(PREBUILDS_ROOT, { recursive: true, force: true });
  process.exit(1);
}

// Optional packages are installed before the parent's install lifecycle. Keep
// source builds and legacy prebuild directories working as before.
try {
  if (process.platform === 'linux' && !process.report?.getReport().header.glibcVersionRuntime) {
    console.log('> Linux prebuilds require glibc; building from source');
    process.exit(1);
  }
  const packageDir = path.dirname(require.resolve(`@node-pty/${process.platform}-${process.arch}/package.json`));
  const files = process.platform === 'win32'
    ? ['conpty.node', 'conpty_console_list.node', 'conpty/conpty.dll', 'conpty/OpenConsole.exe']
    : process.platform === 'darwin' ? ['pty.node', 'spawn-helper'] : ['pty.node'];
  if (files.every(file => fs.existsSync(path.join(packageDir, file)))) {
    console.log('> Using platform package');
    process.exit(0);
  }
} catch (error) {
  if (error.code !== 'MODULE_NOT_FOUND') { throw error; }
}

// Check whether the correct prebuilt files exist
console.log('\x1b[32m> Checking prebuilds...\x1b[0m');
if (!fs.existsSync(PREBUILD_DIR)) {
  console.log(`\x1b[33m> Rebuilding because directory ${PREBUILD_DIR} does not exist\x1b[0m`);
  process.exit(1);
}

process.exit(0);
