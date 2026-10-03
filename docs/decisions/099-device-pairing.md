# §16 #99 — A device signs in from another one, both ways round: a code a signed-in device shows, or a QR the new device shows, approved on a signed-in phone by typing its number

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
  scans the QR, which only **fills the form in**: opening it signs nobody in, so a link preview or a
  prefetch spends nothing.
  - The code works once, within **five minutes** (`PAIR_MINUTES`). It is shown only on the
    response that made it and kept as its SHA-256, as a one-time link is (#97).
  - An account has one code at a time: a new one replaces the old.
  - The code is bound to the account's key (#56) and generation (#70), so "Sign out other
    devices", a password change or a reset kills it.
  - A typed code is a guess at a credential, so it is throttled: **ten wrong an address in ten
    minutes, on a counter of its own**, apart from the address's failed logins. A household behind one
    router, setting up its devices, never uses up its password tries, nor they its codes, and ten more
    guesses at a 40-bit code that lives five minutes change nothing. It counts **by the address alone**
    (`recordLoginAttempt(…, null)`): a code names no account, and no username anyone types elsewhere
    adds to an address's count. What can't be a code at all (the wrong length, a character outside the
    31) is answered before the count, so a typo costs no try.
  - Signing in, deleting the code and taking the try back are **one batch** (#39).
- **A QR the new device shows.** Log in → *Sign in with your phone* opens a request with three
  secrets:
  - a poll secret, in an `HttpOnly` cookie on `/pair` alone, lasting five minutes;
  - a QR code of `https://<instance>/pair/approve/<secret>`, 256 bits, kept as a hash;
  - **two digits**, 10 to 99, shown large beside the QR.

  A phone signed in to the library scans the QR. Its page names the device asking, by its browser
  and system as a session is named (#98), and the account it would join. It warns against approving
  a link someone sent or a number someone read out, and asks for **the number shown on that
  device**, typed. The page never shows the number.
  - The right number approves the request **for the phone's account**, bound to its key and
    generation.
  - Any other answer, or *Don't sign it in*, ends the request. On both devices it says so, and
    nothing is signed in. One wrong answer is all a request gets. The approval and the ending are one
    batch.
  - The new device's page asks every two seconds (htmx). Until there is news the answer is **204**,
    which htmx leaves alone, so nothing on the page is replaced while someone reads it or tabs through
    it, and its live region isn't re-created. When the request is approved, the page **claims** its
    session: one batch makes its device session (#98) and deletes the request (#39). Of two claims
    racing, one signs in. The page names its request (the start of the poll secret's hash, nothing
    secret), so an older tab whose cookie a newer request replaced says it's over rather than wait on
    someone else's request. Without JavaScript the QR can't be drawn: the page says so and links to
    the code.
  - Opening a request is a row anyone may make, so it allows **ten an address in ten minutes**,
    counted apart from logins under an address column only this route writes. Tapping it a few times
    never uses up a household's password tries on one router's address, and nobody elsewhere can use
    up the address's requests.
- **What the number does, and doesn't.** It stops a request approved **blind**: a link opened by
  someone who can't see the asking screen is right once in ninety guesses, and one wrong answer ends
  it. It does **not** stop someone who is shown the link *and* told the number. If the asking device
  is a stranger's, the stranger knows the number. That is what the warning on the phone's page is
  for, and why the page names the device and the account. The device's name is a hint, not a check:
  a User-Agent says what it likes.
- **Who can approve, and make codes.** Only someone signed in. A session still on a temporary
  password can do neither (`mustChangeMayReach()`). A phone that isn't signed in is sent to log in
  and lands on the overview as usual; scanning again then reaches the request.
- **What the new device gets** is an ordinary device session (#98), named after its own browser,
  listed on Account, signed out like any other.
- **A browser's own session is never lost to a failed attempt.** Signing in ends the session a
  browser held before (#98), and that delete now runs only once the new session is in. A wrong code,
  or a claim that finds nothing, leaves whoever was signed in there signed in.
- **Tidy by construction.** Every new code or request deletes the ones whose five minutes are up,
  and the table (`device_pairings`, migration 0061) holds only open requests. Removing a member
  deletes theirs by cascade. Backups leave it out: nothing in it outlives five minutes.

**What it rules out:**
- **Picking the number from a few choices.** With three on offer, a blind approval is right a third
  of the time. Typing two digits costs a thumb a moment and makes it one in ninety.
- **A link that signs in.** Neither the code's QR nor the approve page signs anyone in on opening.
  Only the new device's own poll, holding its cookie, claims an approved request.
- **Asking for the password to make a code.** Whoever can use a signed-in device can already do
  anything it can. The session a code makes ends, like every other, with "Sign out other devices".
  (A recovery code, which outlives that, does ask, §16 #100.)
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
- **the code:**
  - shown with its QR and kept as a hash;
  - filled in, and not spent, by opening it;
  - signing in once, and dying past its minutes, when replaced, and when the account's generation
    moves;
  - the throttle, apart from failed logins both ways, a typo costing nothing, and the try taken back;
  - a wrong code leaving the browser's session alone;
  - no username typed elsewhere throttling an address;
- **the scan:**
  - the phone's page naming the device and never showing the number;
  - a 204 while waiting, then approval and the claim;
  - a wrong number, a non-number and *Don't sign it in* each ending the request;
  - the poll cookie needed to claim, and a race;
  - lapsing, and a moved generation;
  - a failed claim leaving the browser's session alone;
  - two tabs;
  - the poll's answers in the household's language;
  - the throttle counted apart from logins;
  - a temporary-password session refused;
- **the code and the digits read back as typed.**
