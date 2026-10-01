# On your phone

Nalanda installs to a phone's home screen and opens full-screen, like an app
([#48](../decisions/048-installed-app-keeps-no-pages.md)). Sign in on the phone first, in the
browser, over HTTPS — your `workers.dev` address or custom domain; the camera needs HTTPS, which
Cloudflare gives you.

- **iPhone / iPad** — in **Safari**, tap **Share** → **Add to Home Screen** → **Add**. The
  home-screen app may keep its own sign-in apart from Safari's, so sign in there too.
- **Android** — in **Chrome**, open the **⋮** menu → **Install app** (or **Add to Home screen**),
  and confirm. Long-press the icon for a **Scan** shortcut.

## Scanning

Point the camera at a book's or record's barcode from **Add items → Scan**; the browser's own
barcode detector is used where it has one, and otherwise the vendored ZXing decoder, served from
your instance. No camera, or a glossy sleeve? Type the digits into the box beneath — the same
lookup. Where each barcode goes, and what a result offers, is in
[cataloguing.md](cataloguing.md#adding).

## With no signal

In a basement or a bookshop, the scanner keeps working. Opening the app with no connection shows a
scan-only page, and a barcode scanned there — or on the Add page when the lookup can't reach the
server — is held on the phone: the barcode and the time, nothing else, up to 200. Back online,
**Add items** lists what you scanned, each looked up, for you to add to a shelf, put on your want
list, or drop — one at a time or all to one shelf. Nothing is added until you say so.

Held scans belong to the account signed in on the phone: logging out clears them, and another
account signing in on the same phone never sees them. Nothing is synced in the background.

## Nothing of yours stays on the phone

The app keeps only its own static files — the offline page, the stylesheet, the fonts, the scanner
— and refreshes them from the network whenever it can, so a deploy reaches phones at once. No page
of your catalog and no API answer is ever stored; share pages are left alone entirely; and every
signed-in page tells the browser not to cache it either, so Back after a logout shows nothing
([members-and-privacy.md](members-and-privacy.md#sessions-and-sign-in)).

## On a small screen

The sidebar folds into a drawer; tables you act on — Shared links, Members, Loans, Borrowed — become
cards; nothing scrolls sideways. Every page meets WCAG 2.2 AA in both themes at phone width
([ARCH.md §18](../../ARCH.md)). Scanner trouble — the camera never opening, a decode that never
comes, an old icon — is in
[runbooks/troubleshooting.md → Scanner](../../runbooks/troubleshooting.md#scanner).

## Scanning a shelf in one go

Tick **Keep scanning** beside the camera on Add items and each barcode is held with a beep, a
vibration and a running count while the camera stays on — the same list the phone fills with no
signal, so online and offline scanning are one mode. The list shows every held code without
looking anything up; **Look up** fetches one, and **Add all** sends them twenty at a time: each is
looked up by the usual providers, skipped when the catalogue already has it (by ISBN, an ISBN-10's
EAN-13, or a record's barcode), held as *maybe already here* when a title and author match a book
catalogued without an ISBN, and otherwise added as a bare record — no cover, no description beyond
what the lookup carried; the cover backfill fills those later. The report says what was added,
what was here, what might be, and what nothing was found for; those stay on the list with an
**Add by hand** link to the manual form, prefilled. The queue still holds a barcode and a time and
nothing else ([#94](../decisions/094-rapid-batch-scanning.md),
[runbooks/troubleshooting.md → Scanning a shelf in one go](../../runbooks/troubleshooting.md#scanner)).
