// Copyright (c) Microsoft Corporation. Licensed under the MIT License.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cp = require('child_process');
const { TARGETS, SCOPE, validateVersion } = require('./platform-packages');

function readRelease(root, tag) {
  if (!['beta', 'latest'].includes(tag)) { throw new Error('Release tag must be beta or latest'); }
  const release = JSON.parse(fs.readFileSync(path.join(root, 'release.json'), 'utf8'));
  validateVersion(release.version);
  if ((tag === 'latest') === release.version.includes('-')) { throw new Error('Release version does not match tag'); }
  const expected = [...TARGETS.map(target => `${SCOPE}/${target}`), 'node-pty'];
  if (!Array.isArray(release.packages) || release.packages.length !== expected.length) { throw new Error('Incomplete release'); }
  for (let i = 0; i < expected.length; i++) {
    const pkg = release.packages[i];
    if (pkg.name !== expected[i] || pkg.version !== release.version ||
        typeof pkg.filename !== 'string' || !/^[a-z0-9.-]+\.tgz$/.test(pkg.filename)) {
      throw new Error('Invalid release package or publish order');
    }
    const stat = fs.lstatSync(path.join(root, pkg.filename));
    if (!stat.isFile()) { throw new Error('Release tarball must be a regular file'); }
    const digest = crypto.createHash('sha512').update(fs.readFileSync(path.join(root, pkg.filename))).digest('base64');
    if (pkg.integrity !== `sha512-${digest}`) { throw new Error(`Changed release artifact: ${pkg.name}`); }
  }
  return release;
}
function npm(args) {
  if (!process.env.npm_execpath) { throw new Error('Run through npm run publish:platforms'); }
  return cp.spawnSync(process.execPath, [process.env.npm_execpath, ...args], { encoding: 'utf8' });
}
function publish(root, tag, execute = false, run = npm) {
  const release = readRelease(root, tag);
  // Validate every artifact before any remote mutation. All six native packages
  // must be present before publishing the wrapper's exact optional dependencies.
  for (const pkg of release.packages) {
    if (!execute) { console.log(`Would publish ${pkg.name}@${pkg.version} with tag ${tag}`); continue; }
    const existing = run(['view', `${pkg.name}@${pkg.version}`, 'dist.integrity', '--json', '--registry=https://registry.npmjs.org']);
    if (existing.status === 0) {
      if (JSON.parse(existing.stdout) !== pkg.integrity) { throw new Error(`Published bytes differ: ${pkg.name}`); }
      console.log(`Already published with identical bytes: ${pkg.name}`);
      continue;
    }
    if (!existing.stderr.includes('E404')) { throw new Error(existing.stderr || 'Cannot query npm'); }
    const result = run(['publish', path.join(root, pkg.filename), '--ignore-scripts', '--access=public', '--provenance',
      `--tag=${tag}`, '--registry=https://registry.npmjs.org']);
    if (result.status !== 0) { throw new Error(result.stderr || `Publishing ${pkg.name} failed`); }
    console.log(result.stdout);
  }
}
if (require.main === module) {
  const [root, tag, execute] = process.argv.slice(2);
  if (execute !== undefined && execute !== '--publish') { throw new Error('Expected --publish or no third argument'); }
  publish(path.resolve(root), tag, execute === '--publish');
}
module.exports = { readRelease, publish };
