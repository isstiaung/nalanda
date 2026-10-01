import { Hono } from 'hono';
import { getUserById, setDisplayName, setPassword, signOutOtherDevices } from '../db/queries';
import type { AppEnv } from '../env';
import { hasSessionSecret, hashPassword, verifyPassword } from '../lib/auth';
import { signIn } from './auth';
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
}: {
  mustChange: boolean;
  error?: string;
  errorField?: PasswordField;
  ok?: boolean;
  displayName?: string | null;
  nameSaved?: boolean;
  devicesDone?: boolean;
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
    <p class="muted version-line">
      Nalanda <span class="mono">v{VERSION}</span> ·{' '}
      <a href={`https://github.com/isstiaung/nalanda/releases/tag/v${VERSION}`}>release notes</a>
    </p>
  </>
);

account.get('/account', async (c) => {
  const user = c.get('user');
  const row = await getUserById(c.env.DB, user.id);
  return page(
    c,
    'Account',
    <Form
      mustChange={user.mustChangePassword}
      ok={c.req.query('ok') === '1'}
      displayName={row?.displayName ?? null}
      nameSaved={c.req.query('name') === 'saved'}
      devicesDone={c.req.query('devices') === 'out'}
    />,
  );
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

  if (!(await verifyPassword(current, user.passwordHash))) {
    return page(c, 'Account', <Form mustChange={user.mustChangePassword} error="Current password is wrong." errorField="current" />);
  }
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
