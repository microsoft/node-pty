/**
 * Copyright (c) 2019, Microsoft Corporation (MIT License).
 */

const cp = require('child_process');
const fs = require('fs');
const path = require('path');
const packageJson = require('../package.json');

// Determine if this is a stable or beta release
const publishedVersions = getPublishedVersions();
const isStableRelease = !publishedVersions.includes(packageJson.version);

// Get the next version
const nextVersion = isStableRelease ? packageJson.version : getNextBetaVersion();
console.log(`Setting version to ${nextVersion}`);

// Set the version in package.json
const packageJsonFile = path.resolve(__dirname, '..', 'package.json');
packageJson.version = nextVersion;
fs.writeFileSync(packageJsonFile, JSON.stringify(packageJson, null, 2));

function getNextBetaVersion() {
  if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.exec(packageJson.version)) {
    console.error('The package.json version must be of the form x.y.z');
    process.exit(1);
  }
  const tag = 'beta';
  const stableVersion = packageJson.version.split('.');
  const nextStableVersion = `${stableVersion[0]}.${parseInt(stableVersion[1]) + 1}.0`;
  const publishedVersions = getPublishedVersions(nextStableVersion, tag);
  if (publishedVersions.length === 0) {
    return `${nextStableVersion}-${tag}1`;
  }
  const latestPublishedVersion = publishedVersions.sort((a, b) => {
    const aVersion = parseInt(a.substr(a.search(/[0-9]+$/)));
    const bVersion = parseInt(b.substr(b.search(/[0-9]+$/)));
    return aVersion > bVersion ? -1 : 1;
  })[0];
  const latestTagVersion = parseInt(latestPublishedVersion.substr(latestPublishedVersion.search(/[0-9]+$/)), 10);
  return `${nextStableVersion}-${tag}${latestTagVersion + 1}`;
}

function getPublishedVersions(version, tag) {
  const isWin32 = process.platform === 'win32';
  const versionsProcess = isWin32 ?
    cp.spawnSync('npm.cmd', ['view', packageJson.name, 'versions', '--json'], { shell: true }) :
    cp.spawnSync('npm', ['view', packageJson.name, 'versions', '--json']);
  const versionsJson = JSON.parse(versionsProcess.stdout);
  if (tag) {
    return versionsJson.filter(v => !v.search(new RegExp(`${version}-${tag}[0-9]+`)));
  }
  return versionsJson;
}
