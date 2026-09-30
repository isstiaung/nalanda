# Third-party software

Nalanda is MIT-licensed (see [LICENSE](LICENSE)). It depends on the following, all under
licenses compatible with it. No package is vendored into git — `npm install` fetches the
packages, and `scripts/vendor.mjs` copies the browser-facing ones into `public/vendor/`
along with their license texts. The one third-party file in git is BoardGameGeek's logo,
below: it comes from no package.

## Served to browsers

These ship to every visitor of a deployed instance, so their license notices are copied
into `public/vendor/` next to the assets themselves.

| Asset | Package | License | Notice lands at |
|---|---|---|---|
| htmx | [`htmx.org`](https://htmx.org) | 0BSD | `public/vendor/htmx.LICENSE.txt` |
| ZXing barcode decoder (JS + WASM) | [`zxing-wasm`](https://github.com/Sec-ant/zxing-wasm) | MIT | `public/vendor/zxing/LICENSE.txt` |
| Eczar (display face, Latin subset) | [`@fontsource/eczar`](https://fonts.google.com/specimen/Eczar) | SIL OFL 1.1 | `public/vendor/fonts/eczar.LICENSE.txt` |

Eczar is by the [Eczar Project Authors](https://github.com/rosettatype/eczar), copyright
2014. The OFL requires that the font be distributed with its license and that any derived
font not use the reserved name — Nalanda ships the woff2 files unmodified.

### BoardGameGeek's "Powered by BGG" logo

`public/bgg/powered-by-bgg-rgb.svg` (light theme) and `public/bgg/powered-by-bgg-reversed-rgb.svg`
(dark theme) are BoardGameGeek's own files, committed unmodified from the logo folder its API terms
link to: <https://drive.google.com/drive/folders/1k3VgEIpNEY59iTVnpTibt31JcO0rEaSw> (Color → SVG,
fetched 2026-09-29).

They are **not** under Nalanda's MIT license. The logo is a BoardGameGeek, LLC trademark
(<https://boardgamegeek.com/terms>, "Respect our Trademarks"), shown because the
[XML API Terms of Use](https://boardgamegeek.com/wiki/page/XML_API_Terms_of_Use) require it:
*"We require that you include the 'Powered by BGG' logo (linked back to BoardGameGeek) in
public-facing uses of the our XML API"*, displayed *"at a size such that the text is easily
legible."* Where Nalanda shows it: ARCH.md §16 #44. A fork that drops BoardGameGeek may delete
the folder; one that keeps BoardGameGeek keeps the logo.

## Bundled into the Worker

| Package | License | Used for |
|---|---|---|
| [`hono`](https://hono.dev) | MIT | HTTP routing and server-rendered JSX |
| [`drizzle-orm`](https://orm.drizzle.team) | Apache-2.0 | D1 schema and queries |
| [`fast-xml-parser`](https://github.com/NaturalIntelligence/fast-xml-parser) | MIT | BoardGameGeek's XML API (Workers has no `DOMParser`) |

## Build and test only

`wrangler`, `drizzle-kit`, `vitest`, `@cloudflare/vitest-pool-workers`,
`@cloudflare/workers-types`, and `typescript` — all MIT or Apache-2.0, none shipped.

The accessibility audit (ARCH.md §18) adds these, also never shipped:

| Package | License | Used for |
|---|---|---|
| [`eslint`](https://eslint.org) | MIT | `npm run lint` |
| [`eslint-plugin-jsx-a11y`](https://github.com/jsx-eslint/eslint-plugin-jsx-a11y) | MIT | the accessibility rules `npm run lint` runs |
| [`@babel/core`](https://babeljs.io), [`@babel/eslint-parser`](https://babeljs.io) | MIT | parsing TSX for ESLint |
| [`axe-core`](https://github.com/dequelabs/axe-core) | MPL-2.0 | `npm run a11y`'s checks, injected into the audit's browser |
| [`playwright`](https://playwright.dev) | Apache-2.0 | `npm run a11y`'s browser automation |

axe-core's MPL-2.0 is a file-level copyleft that applies to distributing axe-core's own files,
modified or not. Nalanda doesn't distribute them — they stay in `node_modules` and run only in
the audit's browser — and nothing here modifies them. The Chromium that
`npx playwright install chromium` downloads for the audit is an open-source Chromium build under
its own licenses, fetched to your machine or the CI runner, never into the repo or a deployment.

## Data sources

Metadata and cover art are fetched at runtime from Open Library, Google Books,
BoardGameGeek, and Discogs. Each has its own terms of use, and none of them are affiliated
with this project — if you run an instance, you are the API consumer and those terms are
between you and them. BoardGameGeek's, for example, require an approved application (its
token is your `BGG_TOKEN`) and the logo above.
