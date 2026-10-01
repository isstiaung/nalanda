# §16 #73 — A cover from the camera: the browser shrinks the picture, the Worker sniffs and stores it, under the rules every cover keeps

**Decided:** 2026-10-01 (where it is now). Cited as `ARCH.md §16 #73`; "§N" is a section of [ARCH.md](../../ARCH.md), "#N" another decision here.

A cover could only come from a URL: a provider's, or one pasted into the form. Old books,
Indian editions, small-press games and anything Open Library or the Cover Art Archive has no
image for were stuck with the placeholder, and the review of 2026-10-01 put a photo from the
phone first among what libib has that Nalanda lacked. **The owner asked** for it, for books,
records and board games alike.

**What was decided:**
- **The browser does the shrinking.** The Worker never resizes an image (§12: 10 ms CPU), and a
  phone's photo is 3–12 MB. `public/app.js` watches any `input[type=file][data-resize="cover"]`:
  a picked image is redrawn at most 1,200 px on its long side as a JPEG at 0.85 (with
  `createImageBitmap(…, { imageOrientation: 'from-image' })`, so a sideways phone photo comes
  out upright), and put back into the field with a `DataTransfer`, which the form then sends as
  any file. A browser that can't sends the original, and the server's limit decides. Nothing is
  sent on its own: the person still presses the button (WCAG 3.2.2). The field carries no
  `capture` attribute: with it, a phone opens the camera and offers no way to pick a photo
  already taken; with `accept="image/*"` alone, it offers the camera, the photo library and files.
- **The Worker stores bytes, and reads the type from them.** `storeUploadedCover()` in
  `src/lib/covers.ts` (still the only R2 code) takes 500 bytes to 4 MB, sniffs the magic
  numbers for JPEG, PNG, GIF, WebP or AVIF, and puts the bytes under a new UUID with *that*
  type — never the type the upload declares, since an SVG named `.jpg` would otherwise be
  served from this origin as an image and could carry script (#58's rule for covers copied
  from a connection, applied to covers that walk in the door). Anything else is refused, with
  the reason on the page: under the cover, an alert; on the item form, a field error on the
  photo field through `invalid()`, and nothing saved. `serveCover()`'s sandboxing CSP still
  fronts every object. **4 MB, measured:** parsing a multipart body and buffering it is CPU
  work in proportion to its size, and in workerd 8 MB took about 7 ms before any D1 or R2
  call — too close to the request's 10 ms (§12) — while 4 MB took about 4 ms. The limit only
  matters for a browser that couldn't shrink the picture; the resized path is a few hundred KB.
- **Three ways in, one function.** `POST /items/:id/cover` from the form under an item's cover
  (take or pick a picture, "Use this photo"; "Remove cover" beside it), and a `photo` field on
  the item form for an add or an edit — where a photo takes the place of a cover URL typed
  beside it, which then isn't fetched, because the photo is the one the person just took. Any member, as any catalog edit is. The item is
  pointed at the new key and the old object deleted only once nothing points at it, as an
  edit's cover change already does; `setCover()` reads the old key and writes the new in one
  batch, since a `RETURNING` clause sees the row as updated.
- **A photo is a cover like any other.** It is shown wherever the item's cover is — share
  pages and connections included — and the field says so. It is kept where a stored cover is
  kept: the backfill (#8) touches only coverless items; Refresh from Discogs or BGG never
  touches a cover; and #67's one-off replaces only a record's cover never saved since its
  Discogs add, which an upload's `updated_at` rules out.
- **No new column.** Nothing records that a cover was a photo: `cover_key` is the cover, and
  the export carries no cover (#38), as before.

**What it rules out:** resizing, cropping or rotating on the server (§12); storing the
original as well as the shrunk copy (R2 is free up to 10 GB, but a 10 MB photo per book is
the wrong shape for it); trusting the upload's declared type or its extension; auto-submitting
on capture.

`test/cover-photo.spec.ts` holds it: the sniff for each type and against SVG, RIFF-but-not-WebP
and truncated headers; a PNG claimed as a JPEG stored as a PNG; size limits; the route for a
member, a record and a game, replacing and deleting the old object, refusing with the alert,
removing; the add and edit forms with a photo, with a photo beside a URL, and with the empty
file field a browser sends when none is chosen; and app.js's hook.
