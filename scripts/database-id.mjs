// Which D1 database a deploy or a remote command means (ARCH.md §16 #24, #101). Pure, so a test can hold it.
//
// This repository's wrangler.jsonc carries an all-zero placeholder `database_id`: it names no Cloudflare resource, and
// deploys take the real id from D1_DATABASE_ID. A copy made with the Deploy to Cloudflare button is different: the
// button creates the person's database and writes its id into their copy's wrangler.jsonc. So the id is, in order:
// D1_DATABASE_ID when set; the config's own when it isn't the placeholder; and otherwise none — never a guess.

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
  if (fromEnv) return UUID.test(fromEnv) ? { id: fromEnv, from: 'env' } : { error: `D1_DATABASE_ID is not a UUID: ${fromEnv}` };
  const { id } = configuredDatabase(source);
  return id ? { id, from: 'config' } : { error: 'no-id' };
}

/** The config with `id` in place of whatever database_id it had — null when it has no such field. */
export function withDatabaseId(source, id) {
  return ID_FIELD.test(source) ? source.replace(ID_FIELD, `$1${id}$3`) : null;
}
