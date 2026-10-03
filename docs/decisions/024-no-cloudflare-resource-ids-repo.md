# §16 #24 — No Cloudflare resource ids in the repo

**Decided:** 2026-07-19 (went live). Cited as `ARCH.md §16 #24`; "§N" is a section of [ARCH.md](../../ARCH.md), "#N" another decision here.

Going open source, `wrangler.jsonc` keeps
an all-zero placeholder `database_id` and `npm run deploy` (`scripts/deploy.mjs`)
resolves the real id from `D1_DATABASE_ID` into a gitignored copy of the config. The
id is not a credential — it is inert without account access — so this is hygiene, not
a secret fix: a public repo should describe how to run *an* instance, not point at
one. Wrangler does not interpolate environment variables inside its config (a literal
`${VAR}` is sent to the API verbatim — verified), hence the resolved copy; it lives in
the project root because wrangler resolves `main`, `assets`, and `migrations_dir`
relative to the config file's own directory. The placeholder must stay a well-formed
UUID — `wrangler dev` rejects an empty string — and it is load-bearing for local
storage keying (#20), so editing it orphans an existing local database. Local dev,
migrations, and tests all run against the placeholder, so a clone needs no edit at
all. The same pass added LICENSE (MIT), CONTRIBUTING, SECURITY, THIRD-PARTY, CI, and
CODEOWNERS, and untracked `options/`.

**Amended 2026-10-03 (#101).** `wrangler.jsonc` now has **no `database_id` at all**. The all-zero UUID
moved to `preview_database_id`, which keys local dev exactly as before, so no local database was
re-keyed (tested). Without an id, Cloudflare's own `wrangler deploy` connects the binding by its
`database_name`, which is what lets a household's fork deploy with Cloudflare's default command.
`deploy.mjs` writes the real id from `D1_DATABASE_ID` into its resolved copy after `database_name`.
The rule stands: the repo names no Cloudflare resource.
