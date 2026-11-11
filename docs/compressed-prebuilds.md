# Compressed native prebuilds

This proposal reduces the complete package by **2.51% unpacked** and **0.78%
downloaded**, with additional loading time. It compresses only `.node` addons.
Windows DLLs, executables, and debug symbols remain unchanged and account for
**95.1% of unpacked bytes**. It does not remove other platforms' files.

The comparison uses the same `node-pty@1.2.0-beta.18` release before and after this
proposal. The 61.80% addon saving
applies to just 4.16% of the package. The download is already gzip-compressed,
so the 675,323-byte unpacked reduction saves only 55,517 download bytes.

| Measure | Published | Proposed |
| --- | ---: | ---: |
| Complete unpacked package | 26,907,504 B | 26,232,181 B |
| npm download | 7,152,900 B | 7,097,383 B |
| `.node` files only | 1,118,952 B | 427,483 B |
| Fresh-process load, cache available | 2.56 ms | 5.67 ms |
| Fresh-process load, new cache | 2.56 ms | 46.55 ms |

The decoded cache adds **137,384 B** on the measured macOS ARM64 host. Including
that cache, package-file bytes fall by **2.00%**, not 2.51%. These are logical file
sizes, not allocated disk blocks, dependency-tree sizes, or package-manager stores.
Compression provides no measured startup speedup.

<details>
<summary>Measurement and reproduction</summary>

The rerun uses a freshly downloaded registry archive verified against npm's
SHA-512 integrity value. Repacking the baseline reproduces that archive exactly.
Both package variants use the same npm version and packing options. The runner
checks that unrelated packed files retain identical sizes and hashes.

Timings are medians of 21 fresh processes per mode on macOS ARM64 with
Node 26.12.0. Raw ordering alternates; each first load uses a new decoded cache.
Every process also spawns a real PTY. Timings exclude Node startup and PTY spawning.
OS/file caches are not flushed. Windows and Linux startup are not measured here.

After extracting the published archive:

```sh
npm run build
npm run benchmark:compressed -- /path/to/package > docs/compression-benchmark.json
node scripts/chart-compressed-prebuilds.js /tmp/node-pty-compression.svg
npm run test:compressed
```

For registry verification, pass a second argument pointing to a JSON file with
`integrity`, `downloadBytes`, and `unpackedBytes` from the verified download.
The benchmark fails if the repacked baseline differs. The recorded
[report](compression-benchmark.json) includes provenance, file inventories,
codec inputs, cache files, and every timing sample.
Upload the generated chart as a GitHub attachment; do not commit image files.

</details>

<details>
<summary>Implementation and runtime requirements</summary>

- macOS uses Brotli quality 11; Linux and Windows use Zstd level 19. This is the
  chosen size/decode-time tradeoff, not a requirement of those operating systems.
- Build and sign native files first, then run `npm run compress:prebuilds` before
  packing. Every payload must shrink and round-trip exactly.
- The loader checks its cache first. On a miss, it verifies compressed bytes,
  loads only the selected built-in codec, and verifies decoded size and SHA-512.
  Decoding is bounded to 64 MiB per file. Zstd needs Node 22.15+; packing uses 24+.
- Private cache directories are published atomically. macOS helpers and Windows
  runtime companions retain their relative paths. Package contents stay read-only.
- Each fresh process verifies cached runtime files. Repeated loads in the same
  process reuse the loaded addon. Raw source builds load no decoder.
- The default cache is `~/.node-pty/v1-<manifest SHA-512>`. `NODE_PTY_CACHE` selects
  an absolute private directory with an existing parent. Unsafe or corrupt entries
  fail with removal instructions. Close users of an entry before deleting it.
  Old entries are not automatically evicted.
- Hashes check integrity against the installed manifest, not publisher identity.
  The OS still checks native architecture and signatures. Use the public JS API,
  not internal `.node` paths.

The verified-decoding design draws on [SWC #12741](https://github.com/swc-project/swc/issues/12741)
and [Aube #1930](https://github.com/aubepkg/aube/pull/1930). Filesystem compression
and [platform-specific distribution](https://github.com/microsoft/node-pty/pull/1016)
are separate changes; their savings are not included here.

</details>
