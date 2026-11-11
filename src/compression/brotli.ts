/** Copyright (c) Microsoft Corporation. Licensed under the MIT License. */
import type * as zlibTypes from 'zlib';
const zlib: typeof zlibTypes = require('node:zlib');

export function decode(encoded: Buffer, size: number): Buffer {
  return zlib.brotliDecompressSync(encoded, { maxOutputLength: size } as zlibTypes.BrotliOptions);
}
