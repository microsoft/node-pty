/** Copyright (c) Microsoft Corporation. Licensed under the MIT License. */
// Kept in its own module so other platforms and verified cache hits never load it.
// The project's development typings predate Node's built-in Zstd API.
const zlib = require('node:zlib') as {
  constants: { [key: string]: number };
  zstdDecompressSync?: (input: Buffer, options: { maxOutputLength: number, params: { [key: number]: number } }) => Buffer;
};

export function decode(encoded: Buffer, size: number): Buffer {
  if (!zlib.zstdDecompressSync) {
    throw new Error('This native prebuild requires built-in Zstd support. Use Node 22.15+ or a supported newer runtime.');
  }
  return zlib.zstdDecompressSync(encoded, {
    maxOutputLength: size,
    params: { [zlib.constants.ZSTD_d_windowLogMax]: 26 }
  });
}
