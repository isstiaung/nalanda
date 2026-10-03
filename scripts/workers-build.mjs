// wrangler.jsonc's custom build (ARCH.md §16 #101): runs before every `wrangler deploy`, `wrangler versions upload`,
// `wrangler dev` and `wrangler types`, told which by WRANGLER_COMMAND. With no database_id in the config, a plain
// `wrangler deploy` would connect to the account's `nalanda` database by name and publish whatever is checked out,
// without its migrations — so this decides who may publish:
//   - `npm run deploy` (scripts/deploy.mjs), which has migrated already: on its way;
//   - a household's fork building in Cloudflare (Workers Builds, no D1_DATABASE_ID) with Cloudflare's own deploy
//     command: on the library's branch (deploy-site, or NALANDA_BRANCH) this finds the account's `nalanda` database by
//     name, or creates it near D1_LOCATION, and applies the migrations before the code goes up — wrangler's deploy then
//     connects the DB binding to it by name, and creates the cover bucket when it's missing. Any other branch: stopped;
//   - any other publish — a plain `wrangler deploy` from a laptop, or a build of this repository's own instance whose
//     deploy command isn't `npm run deploy` — is stopped, with what to run instead.
// `wrangler dev`, `wrangler types`, and anything else: returns at once (local dev, the tests and the audit).
import { readFileSync } from 'node:fs';
import { configuredDatabase } from './database-id.mjs';
import { branchProblem, findOrCreate, migrate, Refusal } from './fork-database.mjs';

const env = process.env;
const publishing = env.WRANGLER_COMMAND === 'deploy' || env.WRANGLER_COMMAND === 'versions upload';
const viaNpmDeploy = env.npm_lifecycle_event === 'deploy';
const inBuilds = env.WORKERS_CI === '1';
const ownInstance = (env.D1_DATABASE_ID ?? '').trim() !== '';

try {
  if (!publishing || viaNpmDeploy) {
    // nothing to do: not a publish, or `npm run deploy`, which migrated already
  } else if (!inBuilds) {
    throw new Refusal(
      'Deploy with `npm run deploy` (D1_DATABASE_ID=<id> npm run deploy), not a plain `wrangler ' + env.WRANGLER_COMMAND + '`:\n' +
        "that would publish this checkout onto the account's `nalanda` database without its migrations (ARCH.md §16 #101).",
    );
  } else if (ownInstance) {
    throw new Refusal(
      "This build sets D1_DATABASE_ID — this repository's own instance — so its deploy command must be `npm run deploy`,\n" +
        'which migrates first: the Worker → Settings → Build → Deploy command (runbooks/deploy.md).',
    );
  } else {
    // a household's fork, building in Cloudflare with Cloudflare's own deploy command
    const problem = branchProblem(env);
    if (problem) throw new Refusal(problem);
    const source = readFileSync('wrangler.jsonc', 'utf8');
    const name = configuredDatabase(source).name || 'nalanda';
    const id = findOrCreate(name, env);
    migrate(source, id, name, '.wrangler-build.jsonc');
    console.log(`Migrated "${name}"; the deploy connects to it by name.`);
  }
} catch (err) {
  console.error(err instanceof Refusal ? err.message : err);
  process.exit(1);
}
