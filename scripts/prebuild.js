//@ts-check

const fs = require('fs');
const path = require('path');

/**
 * This script copies the prebuilt binaries from the prebuild directory
 * for the current platform and architecture to the build/Release directory.
 * 
 * Usage:
 *     node scripts/prebuild.js
 */

// Skip copying prebuilds when npm_config_build_from_source is set
const buildFromSource = process.env.npm_config_build_from_source;
if (buildFromSource) {
  const val = buildFromSource.toLowerCase();
  if (val !== 'false' && val !== '0' && val !== '') {
    console.log('\x1b[33m> Skipping prebuild copy because npm_config_build_from_source is set\x1b[0m');
    process.exit(1);
  }
}

const PREBUILD_DIR = path.join(__dirname, '..', 'prebuilds', `${process.platform}-${process.arch}`);
const RELEASE_DIR = path.join(__dirname, '../build/Release');

/* Copy prebuild files to build/Release */
console.log('\x1b[32m> Copying prebuilds to release folder...\x1b[0m');
if (!fs.existsSync(PREBUILD_DIR)) {
  console.log(`  SKIPPED Prebuild directory ${PREBUILD_DIR} does not exist`);
  // Exit with 1 to fall back on node-gyp building the native modules
  process.exit(1);
}
fs.cpSync(PREBUILD_DIR, RELEASE_DIR, { recursive: true });