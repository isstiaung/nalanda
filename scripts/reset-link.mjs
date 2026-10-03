// What `npm run reset-admin` writes (ARCH.md §16 #100), kept apart from the command so a test can run the same SQL
// against a real database: no Node imports, only what Workers has too (crypto, btoa).
//
// A reset link for an admin, as the app makes one (§16 #97): its secret 32 random bytes, base64url, kept only as a
// SHA-256 hex; bound to the account's key; good for LINK_DAYS; an invite still if the account never joined; replacing
// any other link of theirs. Nothing else changes until the link is used — the password works as before, every device
// stays signed in — and using it is the app's own batch: the new password, the generation moved on, tokens and links gone.

/** As src/lib/auth.ts: test/recovery-code.spec.ts holds the two equal. */
export const LINK_DAYS = 7;

const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');

/** A link's secret, as newLinkToken() makes one: 43 characters. */
export const newLinkSecret = () => b64url(crypto.getRandomValues(new Uint8Array(32)));

/** A session key, as newSessionKey() makes one, for an account that has none (§16 #56): 22 characters. */
export const newKey = () => b64url(crypto.getRandomValues(new Uint8Array(16)));

/** What isSessionKey() accepts. */
export const isKey = (key) => typeof key === 'string' && /^[A-Za-z0-9_-]{22,64}$/.test(key);

export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** A string as an SQL literal: wrangler's --command takes no parameters. */
export const sqlString = (s) => `'${String(s).replaceAll("'", "''")}'`;

export const accountSql = (username) =>
  `SELECT id, username, role, session_key AS sessionKey FROM users WHERE username = ${sqlString(username)}`;

export const ADMINS_SQL = `SELECT username FROM users WHERE role = 'admin' ORDER BY id`;

/**
 * The statements, in an order where stopping after any of them leaves nothing wrong: a key for a keyless account; the
 * admin's old reset link gone; the new link, an invite if an invite row is still there, for an admin only; their other
 * links gone. `newSessionKey` is set only when the account's key isn't one.
 */
export function resetLinkStatements({ id, sessionKey, newSessionKey, tokenHash, days = LINK_DAYS }) {
  if (!Number.isInteger(id) || !/^[0-9a-f]{64}$/.test(tokenHash)) throw new Error('resetLinkStatements: a bad id or hash');
  return [
    ...(newSessionKey ? [`UPDATE users SET session_key = ${sqlString(newSessionKey)} WHERE id = ${id} AND session_key IS ${sessionKey == null ? 'NULL' : sqlString(sessionKey)}`] : []),
    `DELETE FROM account_links WHERE user_id = ${id} AND purpose = 'reset'`,
    `INSERT INTO account_links (user_id, session_key, purpose, token_hash, expires_at)
     SELECT id, session_key, CASE WHEN EXISTS (SELECT 1 FROM account_links WHERE user_id = ${id}) THEN 'invite' ELSE 'reset' END, '${tokenHash}', datetime('now', '+${days} days')
     FROM users WHERE id = ${id} AND role = 'admin'`,
    `DELETE FROM account_links WHERE user_id = ${id} AND token_hash <> '${tokenHash}'`,
  ];
}

/** Whether the link was made: what the command checks afterwards. */
export const linkMadeSql = (tokenHash) => `SELECT purpose FROM account_links WHERE token_hash = '${tokenHash}'`;
