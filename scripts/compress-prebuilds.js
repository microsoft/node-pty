// Copyright (c) Microsoft Corporation. Licensed under the MIT License.
// Run after building TypeScript and final native signing/stripping, before pack.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { verifyNativeTarget } = require('./native-target');
const { MANIFEST, MAX_FILE_SIZE, digest, validateManifest, verifyBytes, nativeCodecForTarget } = require('../lib/compressedNative');

function compressPrebuild(dir, target) {
  if (fs.existsSync(path.join(dir, MANIFEST))) {
    throw new Error(`Already compressed: ${dir}`);
  }
  const names = target.startsWith('win32-')
    ? ['conpty.node', 'conpty_console_list.node', 'conpty/conpty.dll', 'conpty/OpenConsole.exe']
    : target.startsWith('darwin-') ? ['pty.node', 'spawn-helper'] : ['pty.node'];
  const codec = nativeCodecForTarget(target);
  const suffix = codec === 'brotli' ? '.br' : '.zst';
  const outputs = [];
  const manifest = { version: 2, target, codec, files: names.map(name => {
    const filename = path.join(dir, name);
    const stat = fs.lstatSync(filename);
    if (!stat.isFile() || !stat.size || stat.size > MAX_FILE_SIZE) { throw new Error(`Invalid input: ${filename}`); }
    const raw = fs.readFileSync(filename);
    const file = { path: name, size: raw.length, sha512: digest(raw), compressed: name.endsWith('.node') };
    if (file.compressed) {
      verifyNativeTarget(raw, target);
      const encoded = codec === 'brotli' ? zlib.brotliCompressSync(raw, { params: {
        [zlib.constants.BROTLI_PARAM_QUALITY]: 11,
        [zlib.constants.BROTLI_PARAM_LGWIN]: 20,
        [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length
      } }) : zlib.zstdCompressSync(raw, { params: { [zlib.constants.ZSTD_c_compressionLevel]: 19 } });
      if (encoded.length >= raw.length) { throw new Error(`Compression does not save space: ${filename}`); }
      const decode = codec === 'brotli' ? zlib.brotliDecompressSync : zlib.zstdDecompressSync;
      verifyBytes(decode(encoded, { maxOutputLength: raw.length }), file);
      file.encodedSize = encoded.length;
      file.encodedSha512 = digest(encoded);
      outputs.push({ filename, encoded });
    }
    return file;
  }) };
  validateManifest(manifest, target);
  // Complete all round-trip checks before changing any input. Release staging
  // is disposable; a failed publication must never be packed or published.
  for (const { filename, encoded } of outputs) { fs.writeFileSync(`${filename}${suffix}`, encoded, { flag: 'wx' }); }
  fs.writeFileSync(path.join(dir, MANIFEST), JSON.stringify(manifest) + '\n', { flag: 'wx' });
  for (const { filename } of outputs) { fs.unlinkSync(filename); }
  return manifest;
}

if (require.main === module) {
  const root = path.resolve(process.argv[2] || path.join(__dirname, '../prebuilds'));
  for (const target of fs.readdirSync(root).sort()) {
    compressPrebuild(path.join(root, target), target);
  }
}
module.exports = { compressPrebuild };
