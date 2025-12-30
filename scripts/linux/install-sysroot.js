/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

const { execSync } = require('child_process');
const { tmpdir } = require('os');
const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');

const REPO_ROOT = path.join(__dirname, '..', '..');

const ghApiHeaders = {
  Accept: 'application/vnd.github.v3+json',
  'User-Agent': 'node-pty Build',
};

if (process.env.GITHUB_TOKEN) {
  ghApiHeaders.Authorization = 'Basic ' + Buffer.from(process.env.GITHUB_TOKEN).toString('base64');
}

const ghDownloadHeaders = {
  ...ghApiHeaders,
  Accept: 'application/octet-stream',
};

function getSysrootChecksum(expectedName) {
  const checksumPath = path.join(REPO_ROOT, 'scripts', 'linux', 'checksums.txt');
  const checksums = fs.readFileSync(checksumPath, 'utf8');
  for (const line of checksums.split('\n')) {
    const [checksum, name] = line.split(/\s+/);
    if (name === expectedName) {
      return checksum;
    }
  }
  return undefined;
}

async function fetchUrl(options, retries = 10, retryDelay = 1000) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30 * 1000);
    const version = '20250407-330404';
    try {
      const response = await fetch(`https://api.github.com/repos/Microsoft/vscode-linux-build-agent/releases/tags/v${version}`, {
        headers: ghApiHeaders,
        signal: controller.signal
      });
      if (response.ok && (response.status >= 200 && response.status < 300)) {
        console.log(`Fetch completed: Status ${response.status}.`);
        const contents = Buffer.from(await response.arrayBuffer());
        const asset = JSON.parse(contents.toString()).assets.find((a) => a.name === options.assetName);
        if (!asset) {
          throw new Error(`Could not find asset in release of Microsoft/vscode-linux-build-agent @ ${version}`);
        }
        console.log(`Found asset ${options.assetName} @ ${asset.url}.`);
        const assetResponse = await fetch(asset.url, {
          headers: ghDownloadHeaders
        });
        if (assetResponse.ok && (assetResponse.status >= 200 && assetResponse.status < 300)) {
          const assetContents = Buffer.from(await assetResponse.arrayBuffer());
          console.log(`Fetched response body buffer: ${assetContents.byteLength} bytes`);
          if (options.checksumSha256) {
            const actualSHA256Checksum = createHash('sha256').update(assetContents).digest('hex');
            if (actualSHA256Checksum !== options.checksumSha256) {
              throw new Error(`Checksum mismatch for ${asset.url} (expected ${options.checksumSha256}, actual ${actualSHA256Checksum})`);
            }
          }
          console.log(`Verified SHA256 checksums match for ${asset.url}`);
					const tarCommand = `tar -xz -C ${options.dest}`;
					execSync(tarCommand, { input: assetContents });
					console.log(`Fetch complete!`);
					return;
        }
        throw new Error(`Request ${asset.url} failed with status code: ${assetResponse.status}`);
      }
      throw new Error(`Request https://api.github.com failed with status code: ${response.status}`);
    } finally {
      clearTimeout(timeout);
    }
  } catch (e) {
    if (retries > 0) {
      console.log(`Fetching failed: ${e}`);
      await new Promise(resolve => setTimeout(resolve, retryDelay));
      return fetchUrl(options, retries - 1, retryDelay);
    }
    throw e;
  }
}

async function getSysroot(arch) {
  let expectedName;
  let triple;
  const prefix = '-glibc-2.28-gcc-10.5.0';

  switch (arch) {
    case 'x64':
      expectedName = `x86_64-linux-gnu${prefix}.tar.gz`;
      triple = 'x86_64-linux-gnu';
      break;
    case 'arm64':
      expectedName = `aarch64-linux-gnu${prefix}.tar.gz`;
      triple = 'aarch64-linux-gnu';
      break;
    default:
      throw new Error(`Unsupported architecture: ${arch}`);
  }

  console.log(`Fetching ${expectedName} for ${triple}`);
  const checksumSha256 = getSysrootChecksum(expectedName);
  if (!checksumSha256) {
    throw new Error(`Could not find checksum for ${expectedName}`);
  }

  const sysroot = path.join(tmpdir(), `vscode-${arch}-sysroot`);
  const stamp = path.join(sysroot, '.stamp');
  const result = `${sysroot}/${triple}/${triple}/sysroot`;

  if (fs.existsSync(stamp) && fs.readFileSync(stamp).toString() === expectedName) {
    console.log(`Sysroot already installed: ${result}`);
    return result;
  }

  console.log(`Installing ${arch} root image: ${sysroot}`);
  fs.rmSync(sysroot, { recursive: true, force: true });
  fs.mkdirSync(sysroot, { recursive: true });

  await fetchUrl({
    checksumSha256,
    assetName: expectedName,
    dest: sysroot
  });

  fs.writeFileSync(stamp, expectedName);
  console.log(`Sysroot installed: ${result}`);
  return result;
}

async function main() {
  const arch = process.argv[2] || process.env.ARCH || 'x64';
  console.log(`Installing sysroot for architecture: ${arch}`);

  try {
    const sysrootPath = await getSysroot(arch);
    console.log(`SYSROOT_PATH=${sysrootPath}`);
  } catch (error) {
    console.error('Error installing sysroot:', error);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { getSysroot };
