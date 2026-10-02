# §16 #99 — A device signs in from another one, both ways round: a code a signed-in device shows, or a QR the new device shows, approved on a signed-in phone by picking its number

**Decided:** 2026-10-02. Cited as `ARCH.md §16 #99`; "§N" is a section of [ARCH.md](../../ARCH.md), "#N" another decision here.

Signing in on a television, a family tablet or a borrowed laptop meant typing a password on it: slow
with a remote, and a password left in a browser nobody watches. In the auth relook **the owner
decided** on signing in from a device that is already signed in, in **both directions**: the
signed-in device shows something the new one takes, *and* the new device shows something a
signed-in phone scans. Passkeys, a second factor, Google/Apple/Microsoft sign-in and email codes
were each considered and set aside.

**What was decided:**
- **A code from a signed-in device.** Account → Devices → *Sign in another device* shows a code
  of eight characters, `ABCD-EFGH`, from 31 that can't be mistaken for each other (no 0/O,
  1/I/L), about 40 bits. Beside it is a QR code of `https://<instance>/pair?code=<code>`. The new
  device types the code at `/pair` (Log in → *Sign in with a code from a signed-in device*), or
  scans the QR, which only **fills the form in**: a GET signs nobody in, so a link preview or a
  prefetch spends nothing.
  - The code works once, within **five minutes** (`PAIR_MINUTES`). It is shown only on the
    response that made it and kept as its SHA-256, as a one-time link is (#97).
  - An account has one code at a time: a new one replaces the old.
  - The code is bound to the account's key (#56) and generation (#70), so "Sign out other
    devices", a password change or a reset kills it.
  - A typed code is a guess at a credential, so it **counts with the address's failed logins**:
    ten in ten minutes between them, under the address's own name, never a counter anyone else
    could use up. It is forgotten when it works, as a login is.
- **A QR the new device shows.** Log in → *Sign in with your phone* opens a request with three
  secrets:
  - a poll secret, in an `HttpOnly` cookie on `/pair` alone, lasting five minutes;
  - a QR code of `https://<instance>/pair/approve/<secret>`, 256 bits, kept as a hash;
  - **two digits**, 10 to 99, shown large beside the QR.

  A phone signed in to the library scans the QR and its page names the device asking, by its
  browser and system as a session is named (#98), and the account it would join. The phone offers
  **three numbers**; the person picks the one the new device shows.
  - The right number approves the request **for the phone's account**, bound to its key and
    generation.
  - A wrong number, or *Don't sign it in*, ends the request: on both devices it says so, and
    nothing is signed in.
  - The new device polls every two seconds (htmx, with a *Continue* button that does the same
    without it) and, once approved, **claims** its session: one batch makes its device session
    (#98) and deletes the request (#39). Of two claims racing, one signs in.
  - Opening a request is a row anyone may make, so it allows **ten an address in ten minutes**,
    counted apart from logins: tapping it a few times never uses up a household's password tries
    on one router's address.
- **Why the number.** A QR that signs in whoever scans it could be sent to someone signed in, as
  a link or on a screen they can't see, and they'd sign a stranger in with one tap. The number is
  only on the asking device's screen, so approving needs that screen in front of you. The two wrong
  choices come from the request's own hash, the same on every load, so reloading the page narrows
  nothing down. The device's name is a hint, not the check: a User-Agent says what it likes.
- **Who can approve, and make codes.** Only someone signed in. A session still on a temporary
  password can do neither (`mustChangeMayReach()`). A phone that isn't signed in is sent to log in
  and lands on the overview as usual; scanning again then reaches the request.
- **What the new device gets** is an ordinary device session (#98), named after its own browser,
  listed on Account, signed out like any other.
- **Tidy by construction.** Every new code or request deletes the ones whose five minutes are up,
  and the table (`device_pairings`, migration 0061) holds only open requests. Removing a member
  deletes theirs by cascade. Backups leave it out: nothing in it outlives five minutes.

**What it rules out:**
- **Approving without the number**, or with the number typed on the phone instead of picked.
  Typing two digits costs the person more and checks nothing more.
- **A link that signs in.** Neither the code's QR nor the approve page signs anyone in on a GET.
- **Push to the phone.** There is no app to push to, and no notification service in a $0 stack. The
  phone scans.
- **Remembering a device** past its session. The new device's session slides and ends as any
  other.
- **Showing the code or the QR again.** It is on the response that made it, then gone. A lost one
  is a new one.

**Logs.** With Workers Logs on, Cloudflare's request log records `/pair?code=…` when the QR is
opened, and an approve link's address, as it records a share link's. Each is used once, within
five minutes.

**Tests:** `test/device-pairing.spec.ts` covers:
- **the code:** shown with its QR, kept as a hash, filled in and not spent by opening, signing in
  once; dying past its minutes, when replaced, and when the account's generation moves; the
  throttle;
- **the scan:** the phone's page naming the device and offering the right number among the same
  three on every load; approval and the claim; a wrong number and *Don't sign it in*; the poll
  cookie being needed to claim; a race; lapsing; a moved generation; the throttle counted apart
  from logins; a temporary-password session refused;
- **the codes read back as typed**, and the three choices.
