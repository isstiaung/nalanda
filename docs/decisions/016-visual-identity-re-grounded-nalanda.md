# §16 #16 — Visual identity re-grounded in Nalanda itself: "the manuscript ledger"

**Decided:** 2026-07-18 (reading log (Goodreads redundancy, phase 1)). Cited as `ARCH.md §16 #16`; "§N" is a section of [ARCH.md](../../ARCH.md), "#N" another decision here.

The
accession-ledger bones stay; the materials become the Pala-era scriptorium's:
palm-leaf buff paper, lampblack ink, **indigo** working accent, **vermilion**
rubrication (red stays reserved for circulation/danger, exactly as red ink marked
critical annotations in the manuscripts), turmeric gold for ratings; dark mode is
the lamp-lit reading room (warm blacks). Display face is **Eczar** (OFL,
Devanagari-first design), vendored as woff2 via `@fontsource/eczar` +
`scripts/vendor.mjs` — never a CDN. Signature: the **śirorekhā** — the brand's
vermilion double rule sits *above* the wordmark, which hangs from it like
Devanagari letters from their headstroke; नालन्दा appears in the brand sub-line
and share footer (system Devanagari fonts, graceful fallback). Logo, PWA icons,
manifest, and theme-color metas follow the new palette. The faintest ink, `--ink-3`,
was deepened to `#746b58` (light) and `#8f846d` (dark) so the 10–11px mono labels it
carries clear 4.5:1 on paper. *Amended after 1.6.0:* every control — input, select,
button, a filter menu's summary, the Table/Covers toggle — shares one size, `--control-h`
(32px tall) and `--control-text` (13px), with its one line of text in `line-height: normal`,
centred, so a row of controls sets its words on one level line (Chromium rounds each
control's baseline on its own, and differing heights, sizes or line-heights put them a
pixel apart). Every dropdown shares one chevron, `--chevron`. Pills, tags and the filter
count trim their line box to cap height (`text-box`) and centre their capitals. The owner
chose 32px and 13px over 30px and 12.5px.
