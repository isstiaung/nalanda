// Which D1 database a deploy or a remote command means (ARCH.md §16 #24, #101). Pure, so a test can hold it.
//
// This repository's wrangler.jsonc carries no `database_id`: it names no Cloudflare resource (only the all-zero
// `preview_database_id` that keys local dev). Its own deploys take the real id from D1_DATABASE_ID and write it into a
// copy of the config. A household's fork deploys with no id at all: its database is the one the config names
// (`nalanda`) in the household's own account, found by that name — or made, on the first deploy
// (scripts/fork-database.mjs). So the id is, in order: D1_DATABASE_ID when set; a real `database_id` in the config, if
// one was ever written in; otherwise the account's database of the config's name.

export const PLACEHOLDER_ID = '00000000-0000-0000-0000-000000000000';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ID_FIELD = /("database_id"\s*:\s*")([^"]*)(")/;
const NAME_FIELD = /"database_name"\s*:\s*"([^"]*)"/;

/** What wrangler.jsonc says: its database's id when it is a real one ('' for the placeholder), and its name. */
export function configuredDatabase(source) {
  const id = ID_FIELD.exec(source)?.[2] ?? '';
  return { id: UUID.test(id) && id !== PLACEHOLDER_ID ? id : '', name: NAME_FIELD.exec(source)?.[1] ?? '', hasIdField: ID_FIELD.test(source) };
}

/**
 * The id to deploy or run against: `{ id, from }` with `from` 'env' or 'config', or `{ error }` saying why there is
 * none. An env value that isn't a UUID is an error, not a fallback: whoever set it meant it.
 */
export function chooseDatabaseId(envValue, source) {
  const fromEnv = (envValue ?? '').trim();
  if (fromEnv === PLACEHOLDER_ID) return { error: 'D1_DATABASE_ID is the all-zero placeholder, not a database: `wrangler d1 list` shows the real id' };
  if (fromEnv) return UUID.test(fromEnv) ? { id: fromEnv, from: 'env' } : { error: `D1_DATABASE_ID is not a UUID: ${fromEnv}` };
  const { id } = configuredDatabase(source);
  return id ? { id, from: 'config' } : { error: 'no-id' };
}

/** The config with `id` as its database_id: in place of the one it had, or added after `database_name` — null when it
 *  has neither. */
export function withDatabaseId(source, id) {
  if (ID_FIELD.test(source)) return source.replace(ID_FIELD, `$1${id}$3`);
  const named = /(\n([ \t]*)"database_name"\s*:\s*"[^"]*",[ \t]*\n)/;
  return named.test(source) ? source.replace(named, `$1$2"database_id": "${id}",\n`) : null;
}

/** The id of the database called `name` in `wrangler d1 list --json`'s answer, or '' when there is none. */
export function findDatabase(listed, name) {
  if (!Array.isArray(listed) || !name) return '';
  const matches = listed.filter((db) => db && db.name === name && typeof db.uuid === 'string' && UUID.test(db.uuid));
  return matches.length === 1 ? matches[0].uuid : '';
}

/** Where a new D1 database may be placed (`wrangler d1 create --location`). */
export const LOCATIONS = ['wnam', 'enam', 'weur', 'eeur', 'apac', 'oc'];

/**
 * The branch a fork's library runs: `deploy-site`, the latest release — or NALANDA_BRANCH, a build variable, when a
 * household (or a test) runs another. A build of any other branch is refused: a hook can't tell a preview build from a
 * production one, and code going live on a database it didn't migrate is worse than a failed build.
 */
export function branchProblem(env = process.env) {
  const branch = (env.WORKERS_CI_BRANCH ?? '').trim();
  const library = (env.NALANDA_BRANCH ?? '').trim() || 'deploy-site';
  if (branch === library) return '';
  return (
    `This build is of \`${branch || 'an unknown branch'}\`, and a library runs \`${library}\`` +
    (branch === 'main' ? ' — `main` is work in progress' : '') +
    `. Set the Worker's production branch to ${library} (Settings → Build → Branch control), and your fork's default ` +
    'branch too; turn off builds for other branches.'
  );
}
