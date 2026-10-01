# §16 #21 — Front door via `HOME_SHARE_TOKEN` (optional secret)

**Decided:** 2026-07-19 (went live). Cited as `ARCH.md §16 #21`; "§N" is a section of [ARCH.md](../../ARCH.md), "#N" another decision here.

The app lives on a
subdomain whose root should greet guests, not a login form: with the secret set,
anonymous `GET /` 302s to `/share/<token>`; signed-in users still get the
dashboard. Config-as-secret chosen over a DB flag (no migration or admin UI for
a single-household setting; repoint with `wrangler secret put HOME_SHARE_TOKEN`,
which applies immediately and survives deploys) and over a Cloudflare edge
redirect rule (hardcodes a token outside the app — rotation would 404 the front
door). The token is validated per request, so a stale value (share rotated or
deleted) degrades to the normal login redirect. Share pages still carry no links
into the authenticated app; the household signs in at `/login` directly.
