# §16 #70 — Sign out other devices: a session generation beside the identity key, named by the cookie and moved on by a sign-out, a new password or a reset

**Decided:** 2026-10-01 (where it is now). Cited as `ARCH.md §16 #70`; "§N" is a section of [ARCH.md](../../ARCH.md), "#N" another decision here.

A session is a signed cookie, good for 30 days, and nothing short of rotating `SESSION_SECRET`
for the whole household could end one: a phone that went missing stayed signed in, and so did
a browser on a borrowed laptop. #56 left this for the owner — "a second, rotating value beside
the identity key (a `session_generation` counter the cookie also names, say), in its own
migration" — and named a reset as the natural place. The review of 2026-10-01 put it beside the
timezone fix (#69) as a safety gap. **The owner decided** to build it as #56 sketched.

**What was decided:**
- **`users.session_generation`**, an integer, 0 for every account (migration 0041, a column with
  a default and nothing else). It is *which of this account's sessions still count*, beside
  `session_key`, which is *which account this is*. The key never rotates: the offline scan
  queue's stamp and the gift-list stamp hang from it (`accountIdentity()`), and rotating it
  would make a device drop its held scans. The generation rotates freely, and nothing hangs
  from it.
- **The cookie names it: `{u, k, g, e}`**, and `sessionMatches()` compares `g` with the row the
  middleware already reads — **no D1 call added**. `g` is written only from 1 on, so a cookie
  made in generation 0 is byte for byte what it was.
- **Old cookies stay good.** A cookie without `g` is generation 0, which is every account's
  until it moves on, so the upgrade signs nobody out — unlike #56, which refused old cookies
  because they were the hole; here they aren't.
- **Three things move it on**, each in the statement that writes, with `RETURNING` so the
  caller can re-issue a cookie in the new generation: **Sign out other devices** on Account
  (`signOutOtherDevices()`; this device's cookie is re-issued, so it stays in); **a password
  change** (`setPassword()`, the same re-issue — the new password and the old sessions are never
  both good, and a member who suspects a password leak gets both answers at once); **an admin's
  reset** (`setPassword()` again, no re-issue — the member logs in with the temporary
  password). A reset is therefore the admin's remedy for someone else's lost phone, as #56
  wanted, and there is no separate admin button: the Members table is crowded, and a reset is
  what an admin would do anyway.
- **`ensureSessionKey()` returns the generation too.** A login that mints a key for an account
  without one must sign in at the row's current generation, or it would be refused on the next
  request.
- **Logout is unchanged**: it clears this device's cookie and nothing else.

**What it rules out:** rotating `session_key` (above); a sessions table (a D1 call per request,
the budget #37 guards, and a list of devices the app has no way to name honestly — it sees no
device, only cookies); signing out *all* devices including this one (the button's whole point
is to stay in; Log out is beside it for the other case).

`test/sign-out-devices.spec.ts` holds it: the cookie's shape in generation 0 and after, a stale
generation refused and a current one not, the Account button keeping the acting device in and
signing the rest out, a password change and a reset doing the same, a cookie from before the
column still good, and a page's query count unchanged.
