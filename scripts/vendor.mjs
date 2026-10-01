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
  // QR codes for share links (ARCH.md §16 #85), drawn in the browser by public/qr.js. The package ships no LICENSE
  // file: its MIT notice is the header of this very file, so it travels with it.
  ['node_modules/qrcode-generator/dist/qrcode.js', 'qrcode.js'],
  // Display face for titles/brand (Devanagari-first design, OFL) — see app.css. Its Latin subset carries every title;
  // its Devanagari subset, declared for Devanagari's own range, carries a Hindi one and the brand's नालन्दा (§16 #93).
  ['node_modules/@fontsource/eczar/files/eczar-latin-600-normal.woff2', 'fonts/eczar-latin-600-normal.woff2'],
  ['node_modules/@fontsource/eczar/files/eczar-latin-700-normal.woff2', 'fonts/eczar-latin-700-normal.woff2'],
  ['node_modules/@fontsource/eczar/files/eczar-devanagari-600-normal.woff2', 'fonts/eczar-devanagari-600-normal.woff2'],
  ['node_modules/@fontsource/eczar/files/eczar-devanagari-700-normal.woff2', 'fonts/eczar-devanagari-700-normal.woff2'],
  // Eczar has no Tamil: a Tamil title falls through --serif to Tiro Tamil (OFL), its Tamil subset alone — the package's
  // Latin subsets are left out on purpose, so a Latin heading never reaches it. It ships one weight.
  ['node_modules/@fontsource/tiro-tamil/files/tiro-tamil-tamil-400-normal.woff2', 'fonts/tiro-tamil-tamil-400-normal.woff2'],
  // These assets are served to browsers from our own origin, so their licenses
  // travel with them: the OFL and MIT both require the notice be distributed
  // alongside the thing it covers. See THIRD-PARTY.md.
  ['node_modules/htmx.org/LICENSE', 'htmx.LICENSE.txt'],
  ['node_modules/zxing-wasm/LICENSE', 'zxing/LICENSE.txt'],
  ['node_modules/@fontsource/eczar/LICENSE', 'fonts/eczar.LICENSE.txt'],
  ['node_modules/@fontsource/tiro-tamil/LICENSE', 'fonts/tiro-tamil.LICENSE.txt'],
];

for (const [src, dest] of files) {
  const target = join(vendor, dest);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(join(root, src), target);
}
console.log(`vendored ${files.length} assets into public/vendor/`);
