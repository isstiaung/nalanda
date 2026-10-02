# §16 #97 — One-time links let a member in: an invite for a new account, a reset for a forgotten password; no admin ever sees a password

**Decided:** 2026-10-02. Cited as `ARCH.md §16 #97`; "§N" is a section of [ARCH.md](../../ARCH.md), "#N" another decision here.

Until now an admin made a member's account with a temporary password shown once, passed it on, and
the member had to change it at first sign-in (`must_change_password`); a reset did the same. The
admin saw every member's first password, and so did whatever the password was sent through. In the
auth relook **the owner decided** that one-time links replace temporary passwords, for both.

**What was decided:**
- **An invite is a link.** *Create account* on Members makes the account and its link in one batch
  (#39): the account gets a password nobody knows — a real PBKDF2 hash of 32 random bytes kept
  nowhere (`unusablePasswordHash()`), so checking a guess against it costs what any check does —
  and the page shows `https://<instance>/join/<secret>` **once**, with its QR code (drawn in the
  browser by `/qr.js`, as a share's is, #85) so a member can scan it from the admin's screen. The
  secret is 32 random bytes, base64url; only its SHA-256 is kept (`account_links`, migration 0059),
  as an API token's is (#88).
- **A reset is a link too, and takes effect at once.** *Reset password* replaces the member's
  password with one nobody knows, moves their generation on (every session ends, #70), deletes
  their API tokens (#88) and makes a reset link — one batch. The old password stops working the
  moment an admin presses the button, as a temporary password stopped it before; the lost-phone
  remedy is unchanged. For an account that never used its invite (it still has no password of its
  own) the new link is an invite again, even once the old one has expired.
- **Bound, short-lived, single use.** A link carries the account's id and session key (#56), so a
  removed member's link — the row also cascades — never opens a newcomer given the id. It is good
  for seven days (`LINK_DAYS`). Using it sets the password, moves the generation on, deletes the
  member's API tokens and **every link of theirs**, in one batch whose statements each find the
  account through the link: of two uses racing, one sets the password and the other finds nothing.
  An account has at most one link: a new one replaces the old. Links past their week are deleted
  whenever a link is made.
- **`/join/<secret>`** is public, before the session middleware, beside `/login`: the account's
  username (read-only, offered to a password manager), a new password of at least 8 characters
  and its confirmation, and *Set password and sign in*, which signs the member in on this device.
  The page is `Cache-Control: no-store`. A link that doesn't work — used, expired, replaced,
  made up — answers **410 with the same page whatever the reason**, naming nobody. A POST looks the
  link up before hashing anything, so a made-up link costs a lookup, never a PBKDF2.
- **Members says where things stand.** *Invited · until <date>* or *Reset link out · until <date>*
  beside a name, and *New invite link* in place of *Reset password* while an invite is out. The
  link itself appears only on the response that made it.

**What it rules out:**
- **Throttling the links.** A secret of 256 bits can't be guessed, as a share token (#18) or an API
  token (#88) can't, and a per-account counter would let anyone refuse a member their link.
- **Email.** The admin passes the link on however they like — a message, the QR code on screen.
  Nalanda still sends no mail and stores no address.
- **Keeping temporary passwords** as an option beside links: one way in, one thing to secure.

**Upgrading.** Migration 0059 adds `account_links`; nothing changes for existing accounts. A member
who still has a temporary password from before keeps it, and the forced change at first sign-in
(`mustChangeMayReach()`) still applies to them. Backups leave `account_links` out, as they leave
`login_attempts` out: a link is a short-lived secret, and an admin makes a new one in a click.

**Tests:** `test/account-links.spec.ts` covers:
- the invite shown once, with only its hash kept;
- the join page: no-store, refusals, sign-in, single use, and a race;
- a reset ending sessions, tokens and the old password;
- an invite staying an invite;
- members unable to mint links;
- dead links answering the same way;
- a removed member's link opening no newcomer.

`test/auth.spec.ts` covers the secret and the unusable hash.
