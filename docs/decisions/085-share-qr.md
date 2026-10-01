# §16 #85 — A share link's QR code is drawn in the browser from its address — the mark under the vermilion rule, level H — and nothing new is published

**Decided:** 2026-10-01. Cited as `ARCH.md §16 #85`; "§N" is a section of [ARCH.md](../../ARCH.md), "#N" another decision here.

A share link is an address nobody can type; on a card by the shelf or a note on the fridge it
wants to be a code. **The owner decided** on a QR per link on the Shared links page, generated in
the browser by a small vendored library, in the ledger's colours with the Nalanda mark centred
under the vermilion rule, error correction high enough for the mark, a plain fallback — and
nothing new published.

**What was decided:**
- **Drawn in the browser, never on the Worker.** `public/qr.js` draws each link's code on a
  canvas from the address already printed beside it, using
  [`qrcode-generator`](https://github.com/kazuhikoarase/qrcode-generator) (MIT, 2.0.4),
  vendored by `scripts/vendor.mjs` into `public/vendor/qrcode.js` like htmx and ZXing — pinned,
  served from this origin, never a CDN, never in the Worker bundle (10 ms, #17). The package
  ships no LICENSE file; its MIT notice is the header of the file itself, which travels with it
  ([THIRD-PARTY.md](../../THIRD-PARTY.md)).
- **The ledger's code.** Modules in lampblack on palm-leaf — the page's own `--ink` and `--paper`,
  so the lamp-lit theme draws its own — a four-module quiet zone, and over the centre a palm-leaf
  square about a sixth of the area carrying the vermilion rule (`--stamp`, the brand's
  śirorekhā, #16) with the Ratnodadhi mark (`/logo.svg`, fetched once, given a size so every
  browser will paint an SVG onto a canvas) beneath it. **Error correction H** (30 %) is what makes
  the covered sixth recoverable; every reader tested decodes it, and the address stays printed
  beside the code regardless.
- **An image, a button, a fallback.** The page carries an `<img data-qr>` per link — a blank
  palm-leaf square until the script draws it — with an `alt` naming the link, and a hidden
  **Download PNG** button the script reveals once the drawing is done (512 px, for print; the page
  shows it at 104 px). Without JavaScript the address is there as before. The lint's accessibility
  rules are why it is an image and a button rather than a canvas and a link.
- **Nothing new is published.** The code is the address; whoever scans it lands on the same share
  page with the same whitelist (#18, #9). Rotating a link changes the address and so the code;
  removing it removes both. No request leaves the page for the drawing.

**What it rules out:** a server-side image (CPU, and a new public surface); a QR anywhere but
behind the admin-only Shared links page (a code on a share page itself would be a link into the
web from the web — nothing stops that, but nothing asks for it); QR codes for anything that is not
a share link (items, members, the app).

`test/share-qr.spec.ts` holds it: the Shared links page carries an image and a download button per
link, named after it, with its address and the two scripts, and nothing for a member; the vendored
file and the drawing script are served, the former with its MIT header; a rotated link's code is
the new address.
