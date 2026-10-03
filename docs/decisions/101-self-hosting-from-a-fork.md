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
  → Import a repository (Workers Builds).
  - **Name `nalanda`**, the config's `name`. With another name, Workers Builds fails or overrides it
    and offers to change the fork's config.
  - **Production branch `deploy-site`**, the latest release, as this repository's own instance
    runs. The fork must include it: untick "Copy the `main` branch only". It must also be **the
    fork's default branch**, set before importing, because Cloudflare builds the default branch the
    moment a repository is imported.
  - **Deploy command `npm run deploy`**, with an empty build command (there is no build step).
  - **Builds for non-production branches off.**
- **The first deploy makes everything, with nothing to set.** This repository keeps its all-zero
  placeholder `database_id` (#24), so local dev and the tests are untouched. `deploy.mjs` takes the
  id, in order, from:
  1. `D1_DATABASE_ID` (this repository's own deploys, exactly as before);
  2. the config's own id when it isn't the placeholder;
  3. otherwise, **in Workers Builds only** (`WORKERS_CI=1`), the deploying account's database of the
     config's name, `nalanda`, found with `wrangler d1 list`, or **created** (`wrangler d1 create
     nalanda`, never rewriting the config) when there is none.

  Some cases are refused:
  - **On a laptop** with no id, the deploy refuses as it always has: it never guesses at which
    database a terminal means, and an interactive `d1 create` would rewrite `wrangler.jsonc`.
  - **A build of `main`** is refused before anything is touched (`WORKERS_CI_BRANCH`). A household
    runs releases, and `main` may carry migrations no release has.
  - **The location.** A database's location is fixed when it is made, near whoever made it: here,
    Cloudflare's build machine. So an optional **`D1_LOCATION`** build variable (`apac`, `weur`, …,
    validated) is passed as `--location`, and the runbook says to set it at import.
  - **A failed create** (two builds racing) is checked against the account again before giving up.
  - **A build token that can't reach D1.** Cloudflare's default build token lists no D1 permission,
    so the deploy says to give the token D1 Edit rather than failing with a stack trace.

  It then migrates and deploys with that id. The migrations always run before the code, the first
  deploy included: a new database is made and migrated before the Worker that needs it goes live.
  `wrangler deploy` creates the `nalanda-covers` bucket itself when it's missing: wrangler 4.45 and
  later provisions a binding's resource by its configured name.
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
  the releases and the demo are guarded to run only in `isstiaung/nalanda` besides. That a
  repository's `wrangler.jsonc` keeps the placeholder (#24) is a CI step, not a test.

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
- `test/deploy-config.spec.ts`:
  - the id chosen from the environment, the config or neither, and a malformed or placeholder one
    refused;
  - the id written into the config;
  - finding the account's database by name in `wrangler d1 list`'s answer;
  - `.dev.vars.example` carrying no value for `SESSION_SECRET`.
- `test/setup.spec.ts`:
  - the old sample treated as no secret;
  - a wrong secret writing nothing, refused, throttled and never echoed;
  - a secret ending in a newline still matching.
- `scripts/deploy.mjs` was run against a fake `wrangler` that records each call and the config it is
  given:
  - with `D1_DATABASE_ID` set, in Workers Builds or not, every call and config is byte-identical to
    before;
  - a laptop with no id refuses and touches nothing;
  - a fork build with a database uses it;
  - a fork's first build creates the database (with `--location` when `D1_LOCATION` is set, and
    `--update-config=false`), migrates it, then deploys;
  - a build of `main`, a bad `D1_LOCATION` and an unreadable `d1 list` each stop with a sentence;
  - a create that loses a race carries on with the database the other build made.
