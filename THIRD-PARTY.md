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

### Discogs

This application uses Discogs’ API but is not affiliated with, sponsored or endorsed by Discogs. ‘Discogs’ is a trademark of Zink Media, LLC.

That notice is word for word what Discogs'
[API Terms of Use](https://support.discogs.com/hc/en-us/articles/360009334593-API-Terms-of-Use)
("Last Updated: May 27th, 2025") ask for, *"prominently on Your application and any other
public-facing use of Our API and the Content that You create"*; it *"may be included in Your
terms and conditions or usage documentation"*, which this file and the README are. The same
terms say: *"You must display the following notice directly next to any data You use from the
Discogs API: “Data provided by Discogs.” The notice must include a hyperlink to the discogs.com
page that includes the data. The link back must not use any mechanism that prevents passing
along search engine ranking credit to that page, such as 'nofollow'."*

So a record whose pressing came from Discogs says **Data provided by Discogs.** right below
it, linked to the release's page on discogs.com, with the notice under it: on the record's page,
on a share page showing it, on a connected household's copy, and beside each Discogs result on
the Add page. Where and why: ARCH.md §16 #63. Nalanda ships no Discogs file or logo; the terms
ask for none, and Discogs' [Application Name and Description
Policy](https://support.discogs.com/hc/en-us/articles/360009207054-Application-Name-and-Description-Policy)
limits how its mark may be used. A fork that drops Discogs drops the credit with it.

The terms split Discogs' data into CC0 Data — release titles, formats, track listings,
barcodes, labels — and **Restricted Data**, which includes *"'Marketplace Data' such as …
pricing"*. They also forbid showing their data more than six hours older than Discogs' own,
which is why Nalanda fetches and stores no marketplace prices (ARCH.md §16 #61).
