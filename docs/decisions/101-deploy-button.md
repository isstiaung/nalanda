# §16 #101 — A Deploy to Cloudflare button: a household's own copy, its database and bucket made for it, the release branch, and /setup asking for the session secret

**Decided:** 2026-10-02. Cited as `ARCH.md §16 #101`; "§N" is a section of [ARCH.md](../../ARCH.md), "#N" another decision here.

Running Nalanda meant a terminal: create the D1 database and the R2 bucket with wrangler, put the
secrets, deploy with the database id in the environment (#24). **The owner wanted self-hosting easy
for other households**: a button in the README that does it.

Cloudflare's [Deploy to Cloudflare button](https://developers.cloudflare.com/workers/platform/deploy-buttons/)
(checked 2026-10-02) works like this:
- It copies a public repository into the person's GitHub or GitLab account. The copy is a clone, not a
  fork.
- It creates the bindings `wrangler.jsonc` declares (here, the D1 database and the R2 bucket) and
  writes the new database's id over the placeholder in their copy.
- It asks for every secret `.dev.vars.example` lists, with the descriptions in `package.json`'s
  `cloudflare.bindings`.
- It builds and deploys through Workers Builds with the `deploy` script, as every later push to the
  copy does.

All of it is free. R2, though, has to be **switched on in the account first**. It's free (10 GB a
month), but Cloudflare asks for a card or PayPal account to enable it, and a new account has it off.
The button then stops with "uses R2 which is only available with an R2 subscription". The runbook
and the README say so before the click (found in the first test click, 2026-10-03).

**What was decided:**
- **The button deploys the release branch**, `deploy-site`
  (`https://deploy.workers.cloudflare.com/?url=https://github.com/isstiaung/nalanda/tree/deploy-site`):
  the latest tagged release, never work in progress on `main` (the owner's choice).
- **This repository still names no Cloudflare resource** (#24): its `database_id` stays the all-zero
  placeholder, which is what the button expects. The id is chosen in one place,
  `scripts/database-id.mjs`, in order:
  - `D1_DATABASE_ID` when set (this repository's own deploys, unchanged);
  - otherwise the id in `wrangler.jsonc` when it isn't the placeholder (a button copy);
  - otherwise none. It never guesses.

  `npm run deploy` and every remote script (`backup`, `reset-admin`, the backfills) use it. They
  name the database as the config does (`nalanda` here), so a copy whose database the person renamed
  still finds its own. For this repository every command line they run is exactly what it was. The
  npm migrate scripts and the local scratch servers (the audit, the demo build) use the binding, `DB`,
  as Cloudflare's templates do. The backfills' cover bucket is still `nalanda-covers` by name. They
  are the owner's own tools.
  - A `D1_DATABASE_ID` that is the placeholder itself is refused, as one that isn't a UUID is.
- **The form asks for one secret, `SESSION_SECRET`**, with no value filled in. `.dev.vars.example`
  lists only it uncommented; Discogs, BoardGameGeek, Google Books, a home share and connections are
  optional and set later in the dashboard. The example once carried a sample value. A form that kept
  it would sign everyone's cookie with a string anyone can read, so **the app refuses that value** as
  it refuses a blank one (`hasSessionSecret()`): setup and login answer 503 and say why.
- **`/setup` asks for the session secret first** (the owner's choice). A button deploy's address is
  easy to guess (`nalanda.<account>.workers.dev`). Until the admin exists, whoever opens `/setup`
  first would make it, and a person who clicked a button may not go there at once. Only whoever
  deployed knows the secret.
  - It is compared in constant time (both hashed, the digests compared in full).
  - A wrong one writes nothing, is throttled (ten an address in ten minutes, on a counter of its
    own), and is never filled back in.
  - Lost it? Set a new one in the dashboard and use that: a secret's value can't be read back, only
    replaced.
  - This applies to every instance not yet set up, by button or by hand.
- **A copy's own Actions run none of this repository's workflows.** Cloudflare's import leaves
  `.github/workflows` out of a copy altogether (found in the test click). Besides, CI, the releases and
  the demo are guarded to run only in `isstiaung/nalanda`, in case a copy ever gets them; a fork's pull
  request still runs CI, since for `pull_request` the repository is this one. The import keeps
  `.github/dependabot.yml`, whose run then fails in a copy with no workflows to update, so the runbook
  says to delete it. A household's copy holds its own database id and maybe another database
  name, so this repository's checks don't apply to it. So the rule that *this* repository's
  `wrangler.jsonc` keeps the placeholder (#24) is a CI step, not a test: the tests pass in a copy too.
- **The button reaches only what is on `deploy-site`.** A change to what the button needs (the
  example, the deploy script, the setup check) reaches new households with the release that moves
  `deploy-site`, not with the merge. So the README's button and the release go out together:
  **release right after merging anything the button depends on.**
- **Updating a copy** is taking a release's files from this repository, keeping the copy's own
  `wrangler.jsonc` and leaving out `.github`, then pushing. A copy is one commit ("source repo
  import") with none of this repository's history, so `git merge` refuses it. Workers Builds deploys
  the push, and its migrations run first, as they always do (`runbooks/updating.md`).

**What the first test click showed** (2026-10-03, in a separate account):
- The form asks for `SESSION_SECRET` with an empty field, and won't go on until one is typed.
- R2 must be switched on in the account first (above).
- The build command is empty, which is right, and the deploy command is the `deploy` script.
- The copy's `wrangler.jsonc` keeps its comments, gets the real `database_id`, and takes the Worker
  name chosen on the form (`name`) and a `preview_bucket_name`. `database_name` stays as it was.
- The copy is a single commit by `cloudflare[bot]`, without `.github/workflows`.

**What it rules out:**
- **Generating the session secret in the app**, stored in D1: a backup would then hold what forges
  every session.
- **A real id in this repository's config** to make the button simpler: #24 stands, and the button
  doesn't need it.
- **Pointing the button at `main`.**
- **Trying the button in the owner's production account.** Its default names (`nalanda`,
  `nalanda-covers`) would replace the live Worker. A test click goes in a separate free account (the
  owner's choice).

**Upgrading.** Nothing for an instance already set up: `/setup` is gone once an admin exists. An
instance whose `SESSION_SECRET` is the example's old sample value stops signing anyone in until it is
changed; nobody should have one. In local development, set `SESSION_SECRET` in `.dev.vars`;
`npm run seed:demo` reads it from there.

**Tests:**
- `test/deploy-config.spec.ts`: the id chosen from the environment, a copy's config or neither; a
  malformed or placeholder one refused; the id written into the config; the form asking for
  `SESSION_SECRET` alone, empty, and described. It passes in a copy as in this repository. The
  placeholder check is in CI (`ci.yml`).
- `test/setup.spec.ts`: the old sample treated as no secret; a wrong secret writing nothing, refused,
  throttled and never echoed.
