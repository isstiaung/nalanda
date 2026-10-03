# §16 #101 — Self-hosting from a fork, all in the browser: the first deploy makes the database, Sync fork brings each release, and /setup asks for the session secret

**Decided:** 2026-10-02, revised 2026-10-03 before it shipped. Cited as `ARCH.md §16 #101`; "§N" is a section of
[ARCH.md](../../ARCH.md), "#N" another decision here.

Running Nalanda meant a terminal: create the D1 database and the R2 bucket with wrangler, put the
secrets, deploy with the database id in the environment (#24). **The owner wanted self-hosting easy
for other households.**

**First, a Deploy to Cloudflare button — tried, and set aside.** The button (built in #150, tested in
a separate account on 2026-10-03) did what it promises. It copied the repository into the person's
GitHub, created the database and bucket, asked for `SESSION_SECRET` and deployed. But its copy is a
fresh repository of one commit ("source repo import"), with none of this repository's history and
without `.github/workflows`. Such a copy can't take a release with `git merge`, and has no **Sync
fork**. Updating meant a terminal and a checkout of the release's files minus your config: the very
thing the button was meant to spare people.

That is by design. One-click buttons, Cloudflare's as Vercel's and Netlify's, are built for
*templates*: a starting point you then make your own. Nalanda is software a household runs as it is,
and keeps updating. Self-hosted projects with the same need say so: NextChat's README tells anyone
who used its one-click deploy to delete that copy, fork instead, and deploy the fork, so updates
arrive. **The owner chose to build the fork flow before releasing** (2026-10-03).

**What was decided:**
- **A household forks this repository and imports the fork in Cloudflare**: Workers & Pages → Create
  application → Import a repository (Workers Builds), **keeping Cloudflare's defaults**.
  - **Name `nalanda`**, the config's `name`. With another name, Workers Builds fails or overrides it
    and offers to change the fork's config.
  - **`deploy-site` is the fork's default branch**, set before importing (untick "Copy the `main`
    branch only" when forking). Cloudflare builds the default branch the moment a repository is
    imported, and makes it the production branch. A household runs releases, as this repository's own
    instance does.
  - **The deploy command stays Cloudflare's own**, a plain `npx wrangler deploy`. The owner asked for
    "as automated as possible" after the first fork test failed on exactly this setting.
    `npm run deploy` works too.
  - **Builds for non-production branches off.**
- **No `database_id` in `wrangler.jsonc`**, so wrangler's deploy connects the DB binding by its
  `database_name` (wrangler ≥ 4.45). The all-zero UUID moved to `preview_database_id`, which local dev
  keys by exactly as before, so no local database was re-keyed (tested). This repository's own deploys
  write the real id from `D1_DATABASE_ID` into their resolved copy, after `database_name` (#24,
  amended).
- **A custom build makes the first deploy make everything.** `wrangler.jsonc`'s `build.command`
  (`scripts/workers-build.mjs`) runs before every deploy, version upload and `wrangler dev`, after
  the config is read and before wrangler connects the bindings. It returns at once except in a fork's
  build (`WORKERS_CI=1`, no `D1_DATABASE_ID`, not under `npm run deploy`).
  - On the library's branch (`deploy-site`, or a `NALANDA_BRANCH` build variable) it finds the
    account's `nalanda` database with `wrangler d1 list`. If there is none, it **creates** it
    (`wrangler d1 create nalanda`, near `D1_LOCATION`, never rewriting the config). Then it applies
    the migrations, before the code goes up. Wrangler's deploy then connects to that database by name,
    and creates the `nalanda-covers` bucket when it's missing.
  - **Any other branch's build is refused**, `main` above all. A hook can't tell a preview build from
    a production one, and code going live on a database it didn't migrate is worse than a failed
    build.
  - `npm run deploy` in a fork does the same through `scripts/fork-database.mjs`, which both share.
  - A laptop with no id still refuses as it always has: it never guesses at which database a terminal
    means.
  - **Who may publish.** With no id in the config, a plain `wrangler deploy` would connect to any
    account's `nalanda` database by name: the owner's live library, from a laptop, with whatever is
    checked out and no migrations. Before, the all-zero id made that fail. The hook now refuses it,
    told the command by wrangler (`WRANGLER_COMMAND`: `deploy` or `versions upload`). Only three
    publishes go ahead:
    - `npm run deploy`, which migrated already;
    - a fork's Cloudflare build on its library's branch, migrated by the hook itself;
    - otherwise nothing: a build of this repository's own instance (it sets `D1_DATABASE_ID`) whose
      deploy command isn't `npm run deploy` is refused too, so it can never deploy unmigrated.

    `wrangler dev` and `wrangler types` pass straight through. A side agent raised this on
    2026-10-04, and the owner had it fixed before shipping.
  - **Location.** A database's location is fixed when it is made, near whoever made it: here,
    Cloudflare's build machine. So an optional **`D1_LOCATION`** build variable (`apac`, `weur`, …,
    validated) is passed as `--location`.
  - **A failed create** (two builds racing) is checked against the account again before giving up.
  - **A build token that can't reach D1.** Cloudflare's default token lists no D1 permission, so the
    build says to give the token D1 Edit rather than failing with a stack trace.
- **R2 must be switched on in the account first.** It's free (10 GB a month), but Cloudflare asks
  for a card or PayPal account to enable it, and a new account has it off. The runbook says so
  before anything else.
- **`SESSION_SECRET` is set in the dashboard** (the Worker → Settings → Variables and Secrets). Until
  then the library says *Not ready yet* and how to set it. `.dev.vars.example` leaves it empty, and
  **the app refuses the sample value it used to carry** (`hasSessionSecret()`), as it refuses a
  blank one: anyone can read it.
- **`/setup` asks for the session secret first.** A new library's address is easy to guess
  (`nalanda.<account>.workers.dev`), and until the admin exists whoever opens `/setup` first would
  make it. Only whoever deployed knows the secret.
  - It is compared in constant time (both trimmed and hashed, the digests compared in full).
  - A wrong one writes nothing, is throttled (ten an address in ten minutes, on a counter of its
    own), and is never filled back in.
  - The error says how to replace a lost secret: a value can't be read back, only replaced.
  - This applies to every instance not yet set up.
- **Updates are GitHub's Sync fork** on `deploy-site`: Workers Builds deploys it, migrations first.
  A release whose notes ask for a backup is still backed up first, from a laptop: a clone of
  `deploy-site`, pulled before each backup so its backup script matches the running release, finds
  the household's `nalanda` database by name, as the deploys do. That is the one step that needs a
  terminal.
- **A secret saved in the dashboard** may only upload a version. If the library still says *Not
  ready yet*, the runbook says to deploy the latest version from **Deployments**.
- **A fork runs none of this repository's workflows.** GitHub leaves Actions off in a fork, and CI,
  the releases and the demo are guarded to run only in `isstiaung/nalanda` besides.

**What it rules out:**
- **The Deploy to Cloudflare button**, for the reasons above. A household on a copy would need a
  terminal for every update.
- **Generating the session secret in the app**, stored in D1: a backup would then hold what forges
  every session.
- **A real id in this repository's config.** #24 stands.
- **Deploying `main`**: a household runs releases.
- **Creating a database anywhere but the deploy**: a backup or a hand-run command
  (`scripts/remote-config.mjs`) needs a database that's already there, and says so.

**Upgrading.** Nothing for an instance already set up: `/setup` is gone once an admin exists, and
this repository's own deploys still take `D1_DATABASE_ID`. An instance whose `SESSION_SECRET` is the
example's old sample value stops signing anyone in until it is changed; nobody should have one. In
local development, set `SESSION_SECRET` in `.dev.vars`; `npm run seed:demo` reads it from there.

**Tests:**
- `test/deploy-config.spec.ts` covers:
  - this repository's config: no `database_id`, the placeholder only as `preview_database_id`, and
    the build hook;
  - the id chosen from the environment, the config or neither, and a malformed or placeholder one
    refused;
  - the id written in after `database_name`;
  - the library's branch, with `NALANDA_BRANCH`, and `main` and other branches refused;
  - finding the account's database by name in `wrangler d1 list`'s answer;
  - `.dev.vars.example` carrying no value for `SESSION_SECRET`.
- `test/setup.spec.ts` covers:
  - the old sample treated as no secret;
  - a wrong secret writing nothing, refused, throttled and never echoed;
  - a secret ending in a newline still matching.
- **Local dev was tested** against a database seeded under the old config. With the new config,
  `wrangler dev` still found it.
- **The scripts were run against a fake `wrangler`**, from scratch copies that can't reach the real
  one, recording each call and the config handed over:
  - this repository's `npm run deploy` with `D1_DATABASE_ID`: the same two calls as before, and a
    resolved config that differs only by the `preview_database_id` line, which deploys ignore;
  - the build hook doing nothing there, in local dev, or under `npm run deploy`;
  - the hook creating a fork's database (near `D1_LOCATION`), migrating it, and passing on;
  - the hook reusing an existing database, and accepting a branch named by `NALANDA_BRANCH`;
  - the hook refusing `main` and other branches;
  - a laptop with no id refusing;
  - `npm run deploy` in a fork doing the same as the hook;
  - backups finding the database by `D1_DATABASE_ID`, or by name;
  - no resolved config left behind.
- **The guard, with the real wrangler** (`--dry-run`, which contacts nothing):
  - a plain `wrangler deploy` from a laptop is refused by the hook;
  - the same command as `npm run deploy` runs it goes through;
  - a Workers Build that sets `D1_DATABASE_ID` with a bare deploy command is refused.
- **Order.** Wrangler's own code (4.142) runs the custom build while resolving the entry point,
  before it bundles and connects bindings, so the hook's database exists when the deploy connects
  to it by name.
