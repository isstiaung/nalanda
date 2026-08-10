# Third-party software

Nalanda is MIT-licensed (see [LICENSE](LICENSE)). It depends on the following, all under
licenses compatible with it. Nothing here is vendored into git — `npm install` fetches the
packages, and `scripts/vendor.mjs` copies the browser-facing ones into `public/vendor/`
along with their license texts.

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

## Bundled into the Worker

| Package | License | Used for |
|---|---|---|
| [`hono`](https://hono.dev) | MIT | HTTP routing and server-rendered JSX |
| [`drizzle-orm`](https://orm.drizzle.team) | Apache-2.0 | D1 schema and queries |
| [`fast-xml-parser`](https://github.com/NaturalIntelligence/fast-xml-parser) | MIT | BoardGameGeek's XML API (Workers has no `DOMParser`) |

## Build and test only

`wrangler`, `drizzle-kit`, `vitest`, `@cloudflare/vitest-pool-workers`,
`@cloudflare/workers-types`, and `typescript` — all MIT or Apache-2.0, none shipped.

## Data sources

Metadata and cover art are fetched at runtime from Open Library, Google Books,
BoardGameGeek, and Discogs. Each has its own terms of use, and none of them are affiliated
with this project — if you run an instance, you are the API consumer and those terms are
between you and them.
