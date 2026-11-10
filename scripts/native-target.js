// Copyright (c) Microsoft Corporation. Licensed under the MIT License.
// Check the compiler artifact before labeling a package with a platform/CPU.
// The native loader still validates the complete image and its signature.
function verifyNativeTarget(bytes, target) {
  const [platform, arch] = target.split('-');
  let valid = false;
  if (bytes.length >= 64 && (arch === 'arm64' || arch === 'x64')) {
    if (platform === 'linux') {
      valid = bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) &&
        bytes[4] === 2 && bytes[5] === 1 && bytes.readUInt16LE(18) === (arch === 'arm64' ? 183 : 62);
    } else if (platform === 'darwin') {
      valid = bytes.readUInt32LE(0) === 0xfeedfacf && bytes.readUInt32LE(4) === (arch === 'arm64' ? 0x100000c : 0x1000007);
    } else if (platform === 'win32') {
      const offset = bytes.readUInt32LE(0x3c);
      valid = bytes[0] === 0x4d && bytes[1] === 0x5a && offset <= bytes.length - 6 &&
        bytes.readUInt32LE(offset) === 0x4550 && bytes.readUInt16LE(offset + 4) === (arch === 'arm64' ? 0xaa64 : 0x8664);
    }
  }
  if (!valid) { throw new Error(`Native image does not match ${target}`); }
}
module.exports = { verifyNativeTarget };
