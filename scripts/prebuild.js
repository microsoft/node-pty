//@ts-check

const fs = require('fs');
const path = require('path');

/**
 * This scripts either copies the prebuilt binaries from the prebuild directory
 * for the current platform and architecture to the build/Release directory or
 * copies them in the other direction.
 * 
 * Usage:
 *   To copy binaries from prebuilds/<platform>-<arch> to the build/Release:
 * 
 *     node scripts/prebuild.js
 *
 *   To copy the binaries from the build/Release directory to the prebuilds dir:
 *
 *     node scripts/prebuild.js --populate
 */

const POPULATE = process.argv.includes('--populate');
const PREBUILD_DIR = path.join(__dirname, '..', 'prebuilds', `${process.platform}-${process.arch}`);
const RELEASE_DIR = path.join(__dirname, '../build/Release');

/* Populate: Copy all build/Release files to prebuilds/<platform>-<arch> */
if (POPULATE) {
  console.log('\x1b[32m> Copying release to prebuilds folder...\x1b[0m');
  fs.mkdirSync(PREBUILD_DIR, { recursive: true });
  fs.cpSync(RELEASE_DIR, PREBUILD_DIR, { recursive: true });
  process.exit(0);
}

/* Default: Copy prebuild files to build/Release */
console.log('\x1b[32m> Copying prebuilds to release folder...\x1b[0m');
if (!fs.existsSync(PREBUILD_DIR)) {
  console.log(`  SKIPPED Prebuild directory ${PREBUILD_DIR} does not exist`);
  // Exit with 1 to fall back on node-gyp building the native modules
  process.exit(1);
}
fs.cpSync(PREBUILD_DIR, RELEASE_DIR, { recursive: true });