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

// Check whether the correct prebuilt files exist
console.log('\x1b[32m> Checking prebuilds...\x1b[0m');
if (!fs.existsSync(PREBUILD_DIR)) {
  console.log(`\x1b[33m> Rebuilding because directory ${PREBUILD_DIR} does not exist\x1b[0m`);
  process.exit(1);
}

// Ensure spawn-helper has execute permission (may be stripped by npm pack)
if (process.platform === 'darwin') {
  const spawnHelper = path.join(PREBUILD_DIR, 'spawn-helper');
  if (fs.existsSync(spawnHelper)) {
    fs.chmodSync(spawnHelper, 0o755);
  }
}

process.exit(0);
