# Security policy

## Reporting a vulnerability

Use GitHub's private vulnerability reporting: **Security → Report a vulnerability** on this
repository. That opens a private advisory only the maintainers can see. Please don't open a
public issue for a suspected vulnerability.

Include what you'd need yourself: the route or function, what an attacker gets, and the
smallest reproduction you have. A failing test against `main` is the fastest possible
report.

This is a household project maintained by one person in spare time — expect a reply in days,
not hours. There is no bounty.

## What's supported

`main`, and nothing else. There are no releases or version branches; self-hosters track
`main` and redeploy. Fixes land there and each operator deploys on their own schedule.

## The security model

Knowing what the design already promises makes it clearer what counts as a break.

**Authentication.** Passwords are PBKDF2-HMAC-SHA256, 100,000 iterations (workerd's ceiling)
over a 16-byte random salt, compared in constant time. Sessions are stateless: a
`userId + expiry` payload signed with HMAC-SHA256 under `SESSION_SECRET`, carried in a
`SameSite=Lax` cookie with a 30-day TTL, marked `Secure` over https. Login is throttled to
10 failed attempts per IP per 10 minutes.

**CSRF.** `SameSite=Lax` cookies plus an Origin-check middleware on every mutation. All
mutations are POSTs; a state-changing GET would itself be a bug.

**Share links.** Tokens are 128-bit random, one per published view. Two mechanisms keep them
honest, and defeating either is a vulnerability:

- `toPublicItem()` in `src/lib/share.ts` is a **field whitelist**. Private notes, loans and
  borrowers, the `copies` count, `added_by`, and usernames must never reach a share page.
  (`inCollection`, the derived `copies > 0` boolean, is whitelisted deliberately.)
- `itemMatchesShare()` scopes a token to the filters captured when the view was published,
  so a "reviews only" link can't be walked into the rest of the shelf by guessing item ids.

**Cover art.** `/covers/:key` is public without authentication, by design. Its safety rests
entirely on keys being `crypto.randomUUID()` values that are never derived from item data
and never enumerable. Anything that makes cover keys guessable, listable, or derivable is a
vulnerability even though the route is "already public".

## Already known, and intended

Please don't file these:

- **Share pages are unauthenticated.** Anyone with the URL sees the page — that is the
  feature. The control is that tokens are unguessable, revocable per view, and `noindex`.
- **Share pages are cached in-isolate for an hour.** After rotating or removing a share, an
  untouched isolate can keep serving the old page for up to 1 hour (ARCH.md §16 #19). It's a
  burst shield with a known, accepted lag.
- **The `database_id` in `wrangler.jsonc`.** An account-scoped resource identifier, inert
  without credentials for the account that owns it.
- **No password reset emails.** Deliberate — there is no email infrastructure. An admin
  issues one-time temporary passwords instead (ARCH.md §8).
- **Metadata providers are called server-side over plain `fetch`.** Nalanda sends them
  barcodes and search terms; it sends them nothing about your users.

## If you run an instance

Set a long random `SESSION_SECRET` and don't reuse it anywhere else — it signs every
session cookie, so rotating it logs everyone out (which is also how you revoke a stolen
session). Keep `.dev.vars` out of git; it already is, via `.gitignore`.
