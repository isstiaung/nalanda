import { Hono } from 'hono';
import {
  createApiToken,
  forgetLoginAttempt,
  getUserById,
  MAX_API_TOKENS,
  MAX_TOKEN_NAME,
  recordLoginAttempt,
  revokeApiToken,
  setDisplayName,
  setPassword,
  signOutOtherDevices,
  userWithTokens,
} from '../db/queries';
import type { AppEnv } from '../env';
import { hasSessionSecret, hashApiToken, hashPassword, newApiToken, verifyPassword } from '../lib/auth';
import { ledgerDate } from '../lib/dates';
import { clientIp, signIn, TOO_MANY_ATTEMPTS } from './auth';
import { MAX_DISPLAY_NAME, normalizeDisplayName } from '../lib/names';
import { VERSION } from '../version';
import { invalid } from '../views/components';
import { page } from '../views/layout';

const account = new Hono<AppEnv>();

/**
 * The name you go by outside this library (§16 #45): shown on share pages and to connected households only where an
 * admin has switched names on. Your username signs you in and never leaves the app.
 */
const DisplayNameForm = ({ displayName, saved }: { displayName: string | null; saved?: boolean }) => (
  <article class="panel form-card account-card" id="display-name">
    <p class="eyebrow">Display name</p>
    {saved ? <p class="notice">Display name saved.</p> : null}
    <form method="post" action="/account/display-name">
      <label>
        Display name <small>(optional — up to {MAX_DISPLAY_NAME} characters)</small>
        <input name="displayName" value={displayName ?? ''} maxlength={MAX_DISPLAY_NAME} autocomplete="nickname" />
      </label>
      <button type="submit">Save display name</button>
    </form>
    <p class="muted form-note">
      Signs your ratings, reviews and reading on share pages and to connected households — but only once an admin
      switches names on there. Leave it empty to stay unnamed. It isn't your login: your username signs you in, and
      never leaves this library.
    </p>
  </article>
);

/**
 * Every other device signed out (§16 #70): the one place a member can answer a lost phone or a shared laptop left
 * signed in, without an admin. This device stays in — its cookie is re-issued in the new generation. A password
 * change does the same, and an admin's reset signs a member out everywhere, temporary password in hand.
 */
const DevicesForm = ({ done }: { done?: boolean }) => (
  <article class="panel form-card account-card" id="devices">
    <p class="eyebrow">Devices</p>
    {done ? <p class="notice">Every other device is signed out. This one stays in.</p> : null}
    {/* as every settings panel reads: the explanation, then the action (.switch-form) */}
    <form method="post" action="/account/sign-out-others" class="switch-form">
      <p class="muted">
        Signs this account out everywhere but here — a phone that went missing, a browser left signed in. Changing your
        password does the same. Each of them logs in again with your password; this device stays signed in.
      </p>
      <button type="submit">Sign out other devices</button>
    </form>
  </article>
);

/**
 * A member's read-only API tokens (§16 #88): made here, shown once — on this page, never in a URL — and revoked here.
 * Every path that moves the account's generation on deletes them, so each one listed works.
 */
const TokensForm = ({ tokens, fresh, error }: { tokens: Array<{ id: number; name: string; createdAt: string }>; fresh?: { name: string; token: string } | null; error?: string }) => (
  <article class="panel form-card account-card" id="tokens">
    <p class="eyebrow">API tokens</p>
    {fresh ? (
      <div class="notice token-fresh">
        <p>
          Your token <strong>{fresh.name}</strong>. Copy it now — it is shown this once and kept only as a hash:
        </p>
        <p>
          <code class="mono break-anywhere token-secret">{fresh.token}</code>
        </p>
        <p class="muted">
          Send it as <code>Authorization: Bearer {'<token>'}</code> to <code>/api/v1/…</code>. It reads what you see here — private notes, locations, prices, who has what on loan — and can change nothing. Keep it as you keep your password.
        </p>
      </div>
    ) : null}
    {error ? (
      <p class="error" role="alert">
        {error}
      </p>
    ) : null}
    {tokens.length ? (
      <ul class="token-list">
        {tokens.map((t) => (
          <li>
            <span>
              <strong>{t.name}</strong> <small class="muted">· made {ledgerDate(t.createdAt)}</small>
            </span>
            <form method="post" action={`/account/tokens/${t.id}/revoke`} class="inline-form">
              <button type="submit" class="btn-danger">
                Revoke
              </button>
            </form>
          </li>
        ))}
      </ul>
    ) : (
      <p class="muted">No tokens. One lets a script or another app read your library as JSON — the shelves with their filters, an item with its reads and reviews, search, loans, your want list and goals — exactly as you see it, private notes and locations included, and change nothing. Keep one as you keep your password. See <a href="https://github.com/isstiaung/nalanda/blob/main/runbooks/api.md">runbooks/api.md</a>.</p>
    )}
    {tokens.length < MAX_API_TOKENS ? (
      <form method="post" action="/account/tokens" class="inline-form">
        <input name="name" placeholder="What it's for — e.g. the blog" aria-label="Token name" required maxlength={MAX_TOKEN_NAME} />
        <button type="submit">Make a token</button>
      </form>
    ) : (
      <p class="muted">You have {MAX_API_TOKENS} tokens — revoke one to make another.</p>
    )}
    <p class="muted form-note">Signing out other devices, or changing your password, takes every token with it.</p>
  </article>
);

/** Which field a refused password change is about, so its message is tied to that field. */
type PasswordField = 'current' | 'next' | 'confirm';

const Form = ({
  mustChange,
  error,
  errorField,
  ok,
  displayName,
  nameSaved,
  devicesDone,
  tokens,
  freshToken,
  tokenError,
}: {
  mustChange: boolean;
  error?: string;
  errorField?: PasswordField;
  ok?: boolean;
  displayName?: string | null;
  nameSaved?: boolean;
  devicesDone?: boolean;
  tokens?: Array<{ id: number; name: string; createdAt: string }>; // none on a refused password change: the section is below it
  freshToken?: { name: string; token: string } | null;
  tokenError?: string;
}) => (
  <>
    <div class="page-head">
      <h1>Account</h1>
    </div>
    <article class="panel form-card account-card">
      <p class="eyebrow">Password</p>
      {mustChange ? (
        <p class="notice">Set your own password to continue — you logged in with a temporary one.</p>
      ) : null}
      {error ? (
        <p class="error" role="alert" id="password-error">
          {error}
        </p>
      ) : null}
      {ok ? <p class="notice">Password changed. Every other device is signed out; this one stays in.</p> : null}
      <form method="post" action="/account/password">
        <label>
          Current password
          <input type="password" name="current" required autocomplete="current-password" {...invalid(errorField === 'current' && error, 'password-error')} />
        </label>
        <label>
          New password <small>(at least 8 characters)</small>
          <input type="password" name="next" required minlength={8} autocomplete="new-password" {...invalid(errorField === 'next' && error, 'password-error')} />
        </label>
        <label>
          Confirm new password
          <input type="password" name="confirm" required autocomplete="new-password" {...invalid(errorField === 'confirm' && error, 'password-error')} />
        </label>
        <button type="submit">Change password</button>
      </form>
    </article>
    {mustChange ? null : <DisplayNameForm displayName={displayName ?? null} saved={nameSaved} />}
    {mustChange ? null : <DevicesForm done={devicesDone} />}
    {mustChange ? null : <TokensForm tokens={tokens ?? []} fresh={freshToken} error={tokenError} />}
    <p class="muted version-line">
      Nalanda <span class="mono">v{VERSION}</span> ·{' '}
      <a href={`https://github.com/isstiaung/nalanda/releases/tag/v${VERSION}`}>release notes</a>
    </p>
  </>
);

/** The Account page, with the member's tokens — and, right after one is made, the token itself, this once (§16 #88). */
async function accountPage(c: Parameters<typeof page>[0], extras: { freshToken?: { name: string; token: string } | null; tokenError?: string } = {}) {
  const user = c.get('user');
  const { displayName, tokens } = await userWithTokens(c.env.DB, user.id); // one call, as getUserById was
  return page(
    c,
    'Account',
    <Form
      mustChange={user.mustChangePassword}
      ok={c.req.query('ok') === '1'}
      displayName={displayName}
      nameSaved={c.req.query('name') === 'saved'}
      devicesDone={c.req.query('devices') === 'out'}
      tokens={tokens}
      freshToken={extras.freshToken ?? null}
      tokenError={extras.tokenError}
    />,
  );
}

account.get('/account', (c) => accountPage(c));

/** Makes a token (§16 #88): the secret is shown on the page this once, and only its hash is kept. */
account.post('/account/tokens', async (c) => {
  const user = c.get('user');
  if (user.mustChangePassword) return c.redirect('/account');
  const body = await c.req.parseBody();
  const name = String(body['name'] ?? '').trim().slice(0, MAX_TOKEN_NAME);
  if (!name) return accountPage(c, { tokenError: 'Give the token a name — what it is for.' });
  const token = newApiToken();
  const id = await createApiToken(c.env.DB, user, name, await hashApiToken(token));
  if (id === null) return accountPage(c, { tokenError: `You have ${MAX_API_TOKENS} tokens — revoke one to make another.` });
  c.header('cache-control', 'no-store'); // shown this once: never from the back button's cache either
  return accountPage(c, { freshToken: { name, token } });
});

account.post('/account/tokens/:id/revoke', async (c) => {
  const id = c.req.param('id');
  if (/^\d{1,15}$/.test(id)) await revokeApiToken(c.env.DB, c.get('user').id, Number(id));
  return c.redirect('/account#tokens');
});

account.post('/account/display-name', async (c) => {
  const body = await c.req.parseBody();
  await setDisplayName(c.env.DB, c.get('user').id, normalizeDisplayName(body['displayName']));
  return c.redirect('/account?name=saved#display-name');
});

account.post('/account/password', async (c) => {
  const sessionUser = c.get('user');
  const user = await getUserById(c.env.DB, sessionUser.id);
  if (!user) return c.redirect('/login');
  const body = await c.req.parseBody();
  const current = String(body['current'] ?? '');
  const next = String(body['next'] ?? '');
  const confirm = String(body['confirm'] ?? '');

  // The current password is checked under login's throttle (ARCH.md §8), by address and by this account: whoever
  // holds a session cookie could otherwise guess at the password itself without limit, and a right guess would sign
  // the owner out everywhere. Counted before the check, as at login; a right password takes its row back.
  const attempt = await recordLoginAttempt(c.env.DB, clientIp(c), user.username);
  if (!attempt) {
    c.status(429);
    return page(c, 'Account', <Form mustChange={user.mustChangePassword} error={TOO_MANY_ATTEMPTS} />);
  }
  if (!(await verifyPassword(current, user.passwordHash))) {
    return page(c, 'Account', <Form mustChange={user.mustChangePassword} error="Current password is wrong." errorField="current" />);
  }
  await forgetLoginAttempt(c.env.DB, attempt);
  if (next.length < 8) {
    return page(c, 'Account', (
      <Form mustChange={user.mustChangePassword} error="New password must be at least 8 characters." errorField="next" />
    ));
  }
  if (next !== confirm) {
    return page(c, 'Account', <Form mustChange={user.mustChangePassword} error="New passwords do not match." errorField="confirm" />);
  }
  // the new password signs every other device out (§16 #70); this one carries on, in the generation the row is in now
  const account = await setPassword(c.env.DB, user.id, await hashPassword(next), false);
  if (!account || !hasSessionSecret(c.env.SESSION_SECRET)) return c.redirect('/login');
  await signIn(c, c.env.SESSION_SECRET, account);
  return c.redirect(user.mustChangePassword ? '/' : '/account?ok=1');
});

/** Signs the account out everywhere but this device (§16 #70): the generation moves on, and this cookie moves with it. */
account.post('/account/sign-out-others', async (c) => {
  const account = await signOutOtherDevices(c.env.DB, c.get('user').id);
  if (!account || !hasSessionSecret(c.env.SESSION_SECRET)) return c.redirect('/login');
  await signIn(c, c.env.SESSION_SECRET, account);
  return c.redirect('/account?devices=out#devices');
});

export default account;
