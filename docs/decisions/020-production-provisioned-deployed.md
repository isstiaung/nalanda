# §16 #20 — Production provisioned and deployed

**Decided:** 2026-07-19 (went live). Cited as `ARCH.md §16 #20`; "§N" is a section of [ARCH.md](../../ARCH.md), "#N" another decision here.

Production provisioned and deployed. D1 `nalanda` + R2 `nalanda-covers` created via
wrangler; full local catalog migrated (per-table SQL restore — FTS rebuilt itself
via triggers — plus all cover objects copied key-for-key out of miniflare's local
store, so no production backfill was needed). Deploys run through the Cloudflare
dashboard git integration: push to `deploy-site` → `npm run deploy`. Two live
lessons: an empty `SESSION_SECRET` throws `DataError` on HMAC import at login (the
Worker boots fine — set the secret before first login; since 1.3.0 setup and login
refuse a missing or blank secret up front and say how to set it, §8), and
dashboard-pasted secret values can pick up whitespace (piping the value into
`wrangler secret put` is the reliable path). Local reminder: miniflare keys local D1 state by `database_id`, so
changing the id in `wrangler.jsonc` orphans local data until the state file is
copied to the new key.
