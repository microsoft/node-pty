// Copyright (c) Microsoft Corporation. Licensed under the MIT License.
// Render measured package sizes. Each pair has its own zero-based byte scale.
const fs = require('fs');
if (!process.argv[2]) { throw new Error('Usage: node scripts/chart-compressed-prebuilds.js /path/to/chart.svg'); }
const report = require('../docs/compression-benchmark.json');
const raw = report.sizes.baseline;
const packed = report.sizes.compressed;
const nativeRaw = report.inputs.reduce((sum, file) => sum + file.rawBytes, 0);
const nativePacked = report.inputs.reduce((sum, file) => sum + file.compressedBytes, 0);
const rows = [
  ['Complete package, unpacked', raw.unpackedBytes, packed.unpackedBytes],
  ['npm download (.tgz)', raw.tarballBytes, packed.tarballBytes],
  ['.node files only (subset)', nativeRaw, nativePacked]
];
const megabytes = value => `${(value / 1_000_000).toFixed(3)} MB`;
const saving = (before, after) => ((before - after) / before * 100).toFixed(2);
const unchangedShare = (report.baselineBreakdown.windowsCompanionsAndSymbols / raw.unpackedBytes * 100).toFixed(1);
const parts = [
  '<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="640" viewBox="0 0 1000 640" role="img" aria-labelledby="title description">',
  `<title id="title">Compression saves ${saving(raw.unpackedBytes, packed.unpackedBytes)}% unpacked and ${saving(raw.tarballBytes, packed.tarballBytes)}% downloaded</title>`,
  '<desc id="description">Before and after sizes in decimal megabytes for node-pty 1.2.0-beta.18. The native addon reduction is a subset, not the whole package. Each pair starts at zero.</desc>',
  '<rect width="1000" height="640" fill="#fff"/>',
  '<g font-family="system-ui, sans-serif" fill="#17212b">',
  '<text x="32" y="42" font-size="25" font-weight="700">Small whole-package saving; large addon-only reduction</text>',
  '<text x="32" y="72" font-size="16">node-pty 1.2.0-beta.18 · Same release files · Lower is smaller</text>',
  '<text x="32" y="102" font-size="14">Gray: published   Blue: proposed   Each pair uses its own zero-based scale. 1 MB = 1,000,000 bytes.</text>'
];
rows.forEach(([label, before, after], index) => {
  const y = 145 + index * 137;
  const percent = saving(before, after);
  parts.push(`<text x="32" y="${y}" font-size="18" font-weight="650">${label}</text>`,
    `<text x="968" y="${y}" text-anchor="end" font-size="17">${percent}% smaller · ${megabytes(before - after)} saved</text>`);
  for (const [offset, bytes, color, name] of [[18, before, '#87929e', 'Before'], [52, after, '#4285f4', 'After']]) {
    parts.push(`<text x="32" y="${y + offset + 18}" font-size="15">${name}</text>`,
      `<rect x="102" y="${y + offset}" width="${(bytes / before * 630).toFixed(2)}" height="25" fill="${color}"/>`,
      `<text x="968" y="${y + offset + 18}" text-anchor="end" font-size="16">${megabytes(bytes)}</text>`);
  }
});
parts.push(`<text x="32" y="570" font-size="16">${unchangedShare}% of unpacked bytes are unchanged Windows DLLs, executables, and symbols.</text>`,
  `<text x="32" y="599" font-size="15">Decoded cache adds ${megabytes(report.currentPlatformCache.bytes)} on this macOS ARM64 host; excluded above.</text>`,
  '</g></svg>');
fs.writeFileSync(process.argv[2], parts.join('\n') + '\n');
