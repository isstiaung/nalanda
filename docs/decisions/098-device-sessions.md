# §16 #98 — Every sign-in is a device session: listed on Account, signed out one at a time, sliding 30 days from its last use

**Decided:** 2026-10-02. Cited as `ARCH.md §16 #98`; "§N" is a section of [ARCH.md](../../ARCH.md), "#N" another decision here.

A session was a signed cookie with nothing behind it but the user row (#56, #70). "Sign out other
devices" could end every other session, but nothing listed them or ended one alone, logging out
left a copied cookie good for its 30 days, and a session expired 30 days after sign-in however much
it was used. In the auth relook **the owner decided** on a device list with per-device sign-out,
and sessions that slide.

**What was decided:**
- **A row per sign-in** (`sessions`, migration 0060). Its id is 16 random bytes, carried in the
  signed cookie as `s`, so knowing an id alone forges nothing. The row is bound to the account as
  the cookie is, by its key (#56) and generation (#70). It holds the device's name, read once from
  the User-Agent at sign-in as browser and system (`deviceName()`: "Chrome · macOS",
  "Safari · iPhone"), and nothing else of it: no version, no model, no address. It also holds when
  it signed in and when it was last used.
- **A cookie that names a session signs in only while that row lives**, in the account's key and
  generation and within 30 days of its last use. The session middleware finds the row in the batch
  it already makes, so a page costs no D1 call more. The same batch moves `last_seen_at` on **at
  most once a day**, so an ordinary request writes nothing. When it does move, the cookie is
  re-issued for another 30 days. A session used every few weeks never expires; one left alone for
  30 days does.
- **Account lists the devices** in the call that already reads the page: name, "this device",
  signed in, last used, most recent first. *Sign out* ends any other one, the member's own only.
  This device signs out with Log out, which now deletes its row too, so a copy of the cookie kept
  anywhere signs nobody in afterwards.
- **What ends every device:** "Sign out other devices", a password change, an admin's reset and
  using a one-time link (#97) each delete the account's rows in the batch that moves its generation
  on, and **the device that asked signs in again with a new row in that same batch** (#39) — never
  by a later write that could fail and leave it signed out. Removing the member deletes the rows by
  cascade.
- **Tidy by construction.** Every sign-in ends the session its browser held before (signing in
  again never leaves the old one live), and deletes the account's rows that can no longer sign in —
  past 30 days, another key or generation — and the least recently used past **20 devices**
  (`MAX_SESSIONS`), so the list and its cost stay bounded.
- **Cookies from before** name no session. They sign in until they expire, as they always did, and
  aren't listed; "Sign out other devices" ends them as before. **Nobody is signed out by the
  upgrade.** Within 30 days every cookie still in use names a session.

**What it rules out:**
- **Keeping the User-Agent, an address or a location.** The name is enough to tell a phone from a
  laptop.
- **Writing on every request.** Daily is what "last used" needs, and it keeps D1's rows written at
  one per device per day.
- **Backing up sessions.** A restore signs out every device signed in since device sessions (a
  cookie from before needs no row, and works until it expires): no listed session outlives the
  database it was made in.

**Tests:** `test/device-sessions.spec.ts` covers:
- the row, its name, the cookie, and "this device";
- per-device sign-out, and that nobody signs out another member's device;
- logout ending a kept copy;
- sliding at most daily, with the cookie re-issued;
- 30 days unused ending a session;
- what ends every device;
- old cookies still working and still ended by "Sign out other devices";
- `deviceName()`.
