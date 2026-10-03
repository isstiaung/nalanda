// A household's fork, building in Cloudflare (ARCH.md §16 #101): which branch is the library's, and its database —
// found in the account by the config's name, or created — migrated. Shared by the build hook (scripts/workers-build.mjs),
// which Cloudflare's own deploy command runs, and by `npm run deploy` (scripts/deploy.mjs).
import { execFileSync } from 'node:child_process';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { findDatabase, LOCATIONS, withDatabaseId } from './database-id.mjs';

export { branchProblem } from './database-id.mjs';

/** Wrangler from this checkout: what `npm run` and Cloudflare's `npx wrangler` both run, whatever PATH the hook gets. */
const LOCAL_WRANGLER = fileURLToPath(new URL('../node_modules/.bin/wrangler', import.meta.url));
export const wrangler = (args, options = {}) => execFileSync(existsSync(LOCAL_WRANGLER) ? LOCAL_WRANGLER : 'wrangler', args, options);

/** A failure said in a sentence, for the build log. */
export class Refusal extends Error {}

/** The account's database called `name` — '' when there is none. */
function lookUp(name) {
  try {
    return findDatabase(JSON.parse(wrangler(['d1', 'list', '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })), name);
  } catch {
    throw new Refusal(
      "Couldn't list this account's D1 databases. If the build's API token can't reach D1, give it D1 Edit: the Worker →\n" +
        'Settings → Build → API token (runbooks/troubleshooting.md).',
    );
  }
}

/** The account's database called `name`, or a new one near D1_LOCATION — never rewriting wrangler.jsonc, asking nothing. */
export function findOrCreate(name, env = process.env, log = console.log) {
  const found = lookUp(name);
  if (found) {
    log(`Using this account's D1 database "${name}" (${found}).`);
    return found;
  }
  const location = (env.D1_LOCATION ?? '').trim();
  if (location && !LOCATIONS.includes(location)) throw new Refusal(`D1_LOCATION must be one of ${LOCATIONS.join(', ')} — not "${location}".`);
  log(`This account has no D1 database "${name}" yet: creating it${location ? ` near ${location}` : ''}.`);
  try {
    wrangler(['d1', 'create', name, ...(location ? ['--location', location] : []), '--update-config=false'], { stdio: ['ignore', 'inherit', 'inherit'] });
  } catch {
    // another build made it a moment ago, or the create failed: what the account has now decides
  }
  const made = lookUp(name);
  if (!made) throw new Refusal(`Couldn't create the D1 database "${name}" — the lines above say why.`);
  log(`Using D1 database "${name}" (${made}).`);
  return made;
}

/** Applies the migrations to database `id`, through a resolved copy of the config written at `path` and then removed. */
export function migrate(source, id, name, path) {
  const resolved = withDatabaseId(source, id);
  if (resolved === null) throw new Refusal('No database_name field found in wrangler.jsonc — has the config changed shape?');
  writeFileSync(path, resolved);
  try {
    wrangler(['d1', 'migrations', 'apply', name, '--remote', '--config', path], { stdio: ['ignore', 'inherit', 'inherit'] });
  } finally {
    rmSync(path, { force: true });
  }
}
