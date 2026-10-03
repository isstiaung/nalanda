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
`userId + sessionKey + expiry` payload signed with HMAC-SHA256 under `SESSION_SECRET`, carried
in a `SameSite=Lax` cookie with a 30-day TTL, marked `Secure` over https. Every request
re-reads the user row and requires its `session_key` to match the cookie's: user ids are
reused (SQLite gives a new row max(id)+1), keys are 128 random bits and never are, so a
removed account's cookie never signs in whoever is later given its id (ARCH.md §16 #56).
Anything that trusts a user
id *across time* — a cookie, a stamp, a cached decision — without also binding the key is a
vulnerability. Login is throttled to 10 failed attempts in 10 minutes per IP *and* per
account (the username as typed, so guesses spread over many addresses still add up): the
attempt is counted in the statement that checks the count, before the password is verified,
so a burst of parallel guesses stops at ten too; past the limit the answer is 429, the right
password included, until the failures age out. A login that succeeds takes its row back. The
per-account count is a trade: anyone who knows a username can keep that account from signing in
anew with ten wrong guesses every ten minutes. Usernames are never published, and sessions already
signed in are untouched, so what it blocks is a new device, or a sign-in after "Sign out other
devices" or a password change; the way out is to wait the window out from a quiet moment, or to
clear the account's rows (`runbooks/accounts-and-access.md`). An
unknown username is checked against a fixed hash (`DUMMY_HASH`), so it costs what a wrong
password does and the response time says nothing about which usernames exist. The
current-password check under Account counts against the same limits, so a stolen session
cookie can't be turned into the password by guessing.

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
- **No `database_id` in `wrangler.jsonc`**, and an all-zero `preview_database_id` that only keys
  local dev: this repo names no Cloudflare database, bucket, or account. Deploys take the real id from
  `D1_DATABASE_ID` in the environment (`scripts/deploy.mjs`); a household's fork, building in
  Cloudflare, uses its own account's `nalanda` database by name. Even a real D1 id would be
  inert without credentials for the account that owns it — keeping it out is hygiene.
- **Sessions are listed, and slide.** Every sign-in is a server-side row the signed cookie names,
  so Account lists each device and signs any one out, and Log out ends that device's session for
  any copy of its cookie (ARCH.md §16 #98). A session lives 30 days from its last use. Only the
  browser and system are kept from the User-Agent; no address or location.
- **Setting up a new instance** (ARCH.md §16 #101). Until its first admin exists, anyone who reaches
  `/setup` could make one, and a new library's address (`nalanda.<account>.workers.dev`) is easy to guess. So `/setup` asks first
  for the `SESSION_SECRET` that whoever deployed it set: compared in constant time, throttled, and
  never echoed back. The value this repository once published as an example counts as no secret at
  all, and nobody can sign in with it.
- **Signing in from another device** (ARCH.md §16 #99). Either a code shown on a signed-in
  device's Account page (about 40 bits, five minutes, once, ten wrong an address in ten minutes on a
  counter apart from logins), or a QR on the new device that a signed-in phone approves by **typing** the two-digit
  number shown on that device. One wrong answer ends the request, so a link opened blind is approved
  once in ninety. It does not stop someone who sends the link *and* the number: the phone's page
  warns against exactly that, and names the device and the account it would join. Opening either
  link signs nobody in; codes and requests are kept as SHA-256 and die with the account's
  generation.
- **No password reset emails.** Deliberate — there is no email infrastructure. An admin
  makes a one-time link instead (ARCH.md §16 #97): 256 random bits in its path, kept only as a
  SHA-256, bound to the account, good for seven days and once. Making a reset link stops the old
  password and signs the member out everywhere at once. Links aren't throttled — like share links
  and API tokens they can't be guessed — and a dead one answers the same way whatever the reason.
  With Workers Logs on, Cloudflare's request log records a live link's address, as it does a share
  link's; the link dies when used and after its week.
- **An admin's recovery code** (ARCH.md §16 #100) is how an admin with a forgotten password gets
  back in when no other admin can make them a link. It is shown once, at setup, or when made
  again on Account, which asks for the password. It is about 99 bits, kept as a SHA-256, used once,
  and replaced in the batch that uses it. A new password set any other way — changed, reset by
  another admin, a one-time link — deletes it in its batch, so a code made by whoever had the old
  password can't undo the remedy. `/recover` counts under login's throttle, by address and by account,
  and answers a wrong code and an unknown username alike. Failing that, `npm run reset-admin`, run
  with the Cloudflare credentials, makes the admin a one-time reset link.
- **Metadata providers are called server-side over plain `fetch`.** Nalanda sends them
  barcodes and search terms; it sends them nothing about your users.
- **GHSA-67mh-4wv8-2f99 (esbuild dev server).** Dismissed deliberately: it requires
  `esbuild --serve`, which this project never runs — esbuild is only ever a bundler
  library here, and both dev servers go through workerd. Development scope, so it never
  reaches the Worker bundle, and the vulnerable copy is pinned by a deprecated transitive
  dependency that cannot be upgraded (ARCH.md §16 #26).

## If you run an instance

Set a long random `SESSION_SECRET` and don't reuse it anywhere else — it signs every
session cookie, so rotating it logs everyone out (which is also how you revoke a stolen
session). Keep `.dev.vars` out of git; it already is, via `.gitignore`.
