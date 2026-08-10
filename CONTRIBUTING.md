# Contributing

Thanks for looking. This is a small, opinionated project — a household library registry that
has to keep running on Cloudflare's free tier forever. Most of what follows exists to protect
that constraint.

Please **open an issue before a large PR.** Small fixes, provider tweaks, and documentation
can go straight to a pull request.

## Getting set up

```sh
npm install        # postinstall vendors htmx, the ZXing WASM, and the fonts
npm run db:migrate # creates the local SQLite database
npm run dev        # http://localhost:8787 → /setup creates the admin account
npm test           # vitest, inside the real Workers runtime
npm run typecheck
```

Everything runs offline. Local D1 is a real SQLite file and R2 is emulated, so you never need
a Cloudflare account to develop or to run the tests — CI doesn't have one either. Copy
`.dev.vars.example` to `.dev.vars` for local secrets. Develop against local D1; `--remote` is
only for deploying, remote migrations, and backups.

## Read ARCH.md first

[ARCH.md](ARCH.md) is the source of truth for architecture, and §16 is a decision log with
the reasoning behind each choice. If a change alters a decision, update ARCH.md in the same
PR. [CLAUDE.md](CLAUDE.md) holds the working conventions in short form.

## Things that will get a PR sent back

Not because the ideas are bad — because they break a constraint the project is built on.

**The stack is settled.** Server-rendered `hono/jsx` and htmx, no SPA framework, no
client-side bundler, no CSS framework (ARCH.md §17). Runtime dependencies are `hono`,
`drizzle-orm`, and `fast-xml-parser`; a fourth needs a strong argument in an issue first.

**The free tier is a hard requirement.** No paid Cloudflare features (Images, Queues, paid
Durable Objects), no AWS, nothing with a bill attached.

**10 ms CPU per request.** No server-side image processing and no server-side bulk parsing —
CSV imports are parsed in the browser and posted as JSON batches, and export streams. Password
hashing is WebCrypto PBKDF2 only; a pure-JS bcrypt or argon2 blows the budget outright.

**Workers is not Node.** No `fs`, no `net`, no native modules, no `nodejs_compat`. Only
`fetch`, WebCrypto, and Web Streams.

**Migrations are append-only.** Never edit one that has been applied anywhere. Schema changes
go through `src/db/schema.ts` + `npm run db:generate`; never hand-edit generated SQL. Anything
Drizzle's DSL can't express — the FTS5 table and its sync triggers — goes in a
`drizzle-kit generate --custom` migration.

**`toPublicItem()` is a security boundary, not a mapper.** It's the field whitelist for public
share pages. Adding a field there needs a deliberate check against ARCH.md §9 and
[SECURITY.md](SECURITY.md). Notes, loans, copy counts, `added_by`, and usernames never cross it.

**A new column isn't done until it round-trips.** Every user-visible field has to survive
`/export.csv` and come back through import mapping. Data portability is a feature, not a nicety.

**External API calls live in `src/metadata/`.** Nothing outside that directory talks to Open
Library, Google Books, BoardGameGeek, or Discogs. Likewise `src/db/` is the only code touching
D1, and `src/lib/covers.ts` the only code touching R2.

## Style

Match the code around you. The design system in `public/app.css` is hand-written — extend it
with the existing tokens and components (`.pill`, `.data-table`, `.props`, `.eyebrow`) rather
than adding new colors or a framework. Handlers render a full page normally and a partial when
the `HX-Request` header is present: one handler, two renders.

Tests live in `test/` and run inside workerd against a fresh D1 with the real migrations
applied. Anything touching auth, the share whitelist, CSV mapping, or barcode routing should
arrive with a test.

## Commits and pull requests

Conventional commit messages (`feat:`, `fix:`, `docs:`, `chore:`, `test:`), one completed unit
of work per commit, and no batching of unrelated changes. Keep PRs focused enough to review in
one sitting; CI runs typecheck and the test suite on every one.

**Target `main`.** The `deploy-site` branch is not a development branch — pushing to it
deploys the maintainer's own instance, so it only ever moves by fast-forward from `main`
when there's a reason to ship. A PR aimed at it will just be redirected.

Suspected vulnerabilities go through [SECURITY.md](SECURITY.md), not a public issue or PR.
