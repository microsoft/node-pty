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

const PREBUILD_DIR = path.join(__dirname, '..', 'prebuilds', `${process.platform}-${process.arch}`);

// Skip copying prebuilds when npm_config_build_from_source is set
if (process.env.npm_config_build_from_source === 'true') {
  console.log('\x1b[33m> Removing prebuilds and rebuilding because npm_config_build_from_source is set\x1b[0m');
  fs.rmSync(PREBUILD_DIR, { recursive: true });
  process.exit(1);
}

/* Copy prebuild files to build/Release */
console.log('\x1b[32m> Copying prebuilds to release folder...\x1b[0m');
if (!fs.existsSync(PREBUILD_DIR)) {
  console.log(`  SKIPPED Prebuild directory ${PREBUILD_DIR} does not exist`);
  // Exit with 1 to fall back on node-gyp building the native modules
  process.exit(1);
}
// Exit with 0 to skip node-gyp building from source
process.exit(0);
