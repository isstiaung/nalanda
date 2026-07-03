// Copies pinned client assets from node_modules into public/vendor/.
// Runs on postinstall; re-run manually after bumping versions (npm run vendor).
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const vendor = join(root, 'public', 'vendor');

const files = [
  ['node_modules/htmx.org/dist/htmx.min.js', 'htmx.min.js'],
  // ES build is split: reader/index.js imports ../share.js — keep the layout.
  // The .wasm is served from our origin via a locateFile override in scanner.js
  // (zxing-wasm defaults to a CDN, which we never use).
  ['node_modules/zxing-wasm/dist/es/reader/index.js', 'zxing/reader/index.js'],
  ['node_modules/zxing-wasm/dist/es/share.js', 'zxing/share.js'],
  ['node_modules/zxing-wasm/dist/reader/zxing_reader.wasm', 'zxing/zxing_reader.wasm'],
];

for (const [src, dest] of files) {
  const target = join(vendor, dest);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(join(root, src), target);
}
console.log(`vendored ${files.length} assets into public/vendor/`);
