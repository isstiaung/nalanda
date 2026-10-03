// A one-time reset link for an admin who is locked out (ARCH.md §16 #100), made from a laptop with wrangler's
// credentials: the way back in when the recovery code is lost too, or the instance is older than recovery codes.
//
//   npm run reset-admin -- <admin username> --url=https://your.library   production (wrangler logged in)
//   npm run reset-admin -- <admin username> --local                      the local dev database
//
// It makes a link and changes nothing else: the password works as before and every device stays signed in until the
// link is used, when the app sets the new password and signs every other device out. So it needs no backup first —
// nothing it does loses anything (runbooks/accounts-and-access.md). Members are reset by an admin, under Members.
import { spawnSync } from 'node:child_process';
import { DATABASE, removeRemoteConfig, writeRemoteConfig } from './remote-config.mjs';
import { accountSql, ADMINS_SQL, isKey, LINK_DAYS, linkMadeSql, newKey, newLinkSecret, resetLinkStatements, sha256Hex } from './reset-link.mjs';

const args = process.argv.slice(2);
const local = args.includes('--local');
const url = (args.find((a) => a.startsWith('--url='))?.slice('--url='.length) ?? '').replace(/\/+$/, '');
const username = args.find((a) => !a.startsWith('--'));
const usage = 'npm run reset-admin -- <admin username> --url=https://your.library   (or --local)';

/** Stops with a reason — thrown, so the `finally` below still deletes the config copy. */
class Refusal extends Error {}
const fail = (message) => {
  throw new Refusal(message);
};

if (!username) {
  console.error(`Usage: ${usage}`);
  process.exit(1);
}
if (url && !/^https?:\/\/[^/\s]+$/.test(url)) {
  console.error(`--url wants the library's address alone, like https://library.example — not ${url}`);
  process.exit(1);
}

const config = local ? null : writeRemoteConfig(usage);
// Ctrl-C reaches wrangler too, which stops; this process outlives it and still deletes the config copy
process.on('SIGINT', () => {});

/** One --command (statements joined by ';'), its JSON answer: one entry per statement, each with its `results`. */
function d1(sql) {
  const where = local ? ['--local'] : ['--remote', '--config', config];
  const run = spawnSync('npx', ['wrangler', 'd1', 'execute', DATABASE, ...where, '--json', '--yes', '--command', sql], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  if (run.status !== 0) fail(`wrangler d1 execute failed (exit ${run.status}).`);
  return JSON.parse(run.stdout);
}

try {
  const [found] = d1(accountSql(username));
  const account = found?.results?.[0];
  if (!account) {
    const admins = (d1(ADMINS_SQL)[0]?.results ?? []).map((a) => a.username);
    fail(`No account is called "${username}". The admins: ${admins.length ? admins.join(', ') : 'none'}.`);
  }
  if (account.role !== 'admin') fail(`"${username}" is a member: an admin resets a member under Members, which makes them a link.`);

  const secret = newLinkSecret();
  const tokenHash = await sha256Hex(secret);
  const keyless = !isKey(account.sessionKey);
  d1(resetLinkStatements({ id: account.id, sessionKey: account.sessionKey, newSessionKey: keyless ? newKey() : null, tokenHash }).join(';\n'));
  const made = d1(linkMadeSql(tokenHash))[0]?.results?.[0];
  if (!made) fail('The link was not made: the account changed while this ran. Run it again.');

  const path = `/join/${secret}`;
  console.log(`\n${made.purpose === 'invite' ? 'An invite' : 'A reset link'} for ${username}, good once, for ${LINK_DAYS} days:\n`);
  console.log(`  ${url ? `${url}${path}` : `<your library's address>${path}`}\n`);
  console.log('Open it to choose a new password. Until then nothing has changed: the old password still works, and every');
  console.log('device stays signed in. Using it signs every other device out. Then make a new recovery code on Account.');
} catch (err) {
  if (!(err instanceof Refusal)) throw err;
  console.error(err.message);
  process.exitCode = 1;
} finally {
  if (config) removeRemoteConfig();
}
