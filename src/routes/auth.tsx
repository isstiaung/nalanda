import { Hono, type Context } from 'hono';
import { deleteCookie, setCookie } from 'hono/cookie';
import {
  countUsers,
  createFirstAdmin,
  ensureSessionKey,
  forgetLoginAttempt,
  getUserByUsername,
  LOGIN_ATTEMPT_WINDOW_MINUTES,
  recordLoginAttempt,
} from '../db/queries';
import type { AppEnv } from '../env';
import {
  createSessionToken,
  DUMMY_HASH,
  hasSessionSecret,
  hashPassword,
  isSessionKey,
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  verifyPassword,
  type SessionRef,
} from '../lib/auth';
import { invalid } from '../views/components';
import { Brand, page } from '../views/layout';

const auth = new Hono<AppEnv>();

/** Signs this account in on this response: a cookie naming its id, session key (§16 #56) and generation (§16 #70). */
export async function signIn(c: Context<AppEnv>, secret: string, account: SessionRef): Promise<void> {
  const token = await createSessionToken(secret, account, Math.floor(Date.now() / 1000));
  setCookie(c, SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'Lax',
    secure: new URL(c.req.url).protocol === 'https:', // plain http only for local dev, where Secure would drop it
    maxAge: SESSION_TTL_SECONDS,
  });
}

/** `fieldsWrong`: whether the error is about what was typed (a wrong password) rather than about waiting. */
const LoginForm = ({ error, note, fieldsWrong = true }: { error?: string; note?: string; fieldsWrong?: boolean }) => (
  <article class="auth-card">
    <Brand />
    <h1>Log in</h1>
    {note ? <p class="notice">{note}</p> : null}
    {error ? (
      <p class="error" role="alert" id="login-error">
        {error}
      </p>
    ) : null}
    <form method="post" action="/auth/login">
      <label>
        Username
        {/* eslint-disable-next-line no-restricted-syntax -- the login page is one form: its first field is where everyone starts */}
        <input name="username" required autofocus autocomplete="username" {...invalid(fieldsWrong && error, 'login-error')} />
      </label>
      <label>
        Password
        <input type="password" name="password" required autocomplete="current-password" {...invalid(fieldsWrong && error, 'login-error')} />
      </label>
      <button type="submit">Log in</button>
    </form>
  </article>
);

// Without a session secret nobody can be signed in: the cookie is signed with it. Setup and login say so before
// they write anything. (An empty one once let setup create the admin and then fail on signing — which closed
// setup, and login failed the same way.)
const NoSessionSecret = ({ note }: { note?: string }) => (
  <article class="auth-card">
    <Brand />
    <h1>Not ready yet</h1>
    <p class="error">
      This Nalanda has no <code>SESSION_SECRET</code>, so nobody can sign in.{note ? ` ${note}` : ''}
    </p>
    <p class="eyebrow">Whoever runs it sets one</p>
    <p>
      From the project folder, run <code>npx wrangler secret put SESSION_SECRET</code> and paste a long random value
      (<code>openssl rand -base64 32</code> makes one).
    </p>
    <p>
      Or in the Cloudflare dashboard: the Worker → <strong>Settings</strong> → <strong>Variables and Secrets</strong>{' '}
      → add a secret named <code>SESSION_SECRET</code>.
    </p>
    <p class="muted">
      Then reload this page. Running it locally? Put it in <code>.dev.vars</code> and restart <code>npm run dev</code>.
    </p>
  </article>
);

function noSessionSecret(c: Context<AppEnv>, note?: string) {
  c.status(503);
  return page(c, 'Not ready yet', <NoSessionSecret note={note} />);
}

// Setup's note says what to do once the secret is set. An account may already exist — the old failure above made
// it — and then setup will be gone: log in with the password chosen for it. A database that can't be read (never
// migrated) still gets the explanation, with the plain note.
async function setupWithoutSecret(c: Context<AppEnv>, posted: boolean) {
  const accountExists = await countUsers(c.env.DB).then((n) => n > 0, () => false);
  if (accountExists) return noSessionSecret(c, 'An account already exists: once it is set, log in with it.');
  return noSessionSecret(c, posted ? 'Nothing was saved: set it, then create the account again.' : undefined);
}

auth.get('/login', async (c) => {
  if (!hasSessionSecret(c.env.SESSION_SECRET)) return noSessionSecret(c);
  if ((await countUsers(c.env.DB)) === 0) return c.redirect('/setup');
  // a setup that lost the race to another (below) lands here
  const note =
    c.req.query('raced') === undefined
      ? undefined
      : 'Setup was already done: another setup finished first. Log in with that account — if it isn’t yours, ask whoever made it to add you.';
  return page(c, 'Log in', <LoginForm note={note} />);
});

/** The lockout, as the login page and Account both answer it: the sentence, and 429 so a script can tell it from a wrong guess. */
export const TOO_MANY_ATTEMPTS = `Too many attempts — try again in ${LOGIN_ATTEMPT_WINDOW_MINUTES} minutes.`;

/** Where a request comes from, for throttling: Cloudflare's header, or "local" under `wrangler dev`. */
export const clientIp = (c: Context<AppEnv>): string => c.req.header('cf-connecting-ip') ?? 'local';

auth.post('/auth/login', async (c) => {
  const secret = c.env.SESSION_SECRET;
  if (!hasSessionSecret(secret)) return noSessionSecret(c);
  const body = await c.req.parseBody();
  const username = String(body['username'] ?? '').trim();
  const password = String(body['password'] ?? '');
  // Counted before the password is checked, in the statement that counts (ARCH.md §8): ten failures in ten minutes
  // from this address, or at this account from anywhere, and the guess isn't checked at all — the right password
  // included, until they age out.
  const attempt = await recordLoginAttempt(c.env.DB, clientIp(c), username);
  if (!attempt) {
    c.status(429);
    return page(c, 'Log in', <LoginForm error={TOO_MANY_ATTEMPTS} fieldsWrong={false} />);
  }
  const user = username ? await getUserByUsername(c.env.DB, username) : null;
  // a name nobody has is checked against a fixed hash: the answer takes as long either way, and says nothing about
  // which usernames exist
  const ok = (await verifyPassword(password, user?.passwordHash ?? DUMMY_HASH)) && user !== null;
  if (!user || !ok) return page(c, 'Log in', <LoginForm error="Wrong username or password." />);
  await forgetLoginAttempt(c.env.DB, attempt); // no failure: a login counts towards nobody's ten
  // an account restored from an older backup, or added by hand, has no key yet: it gets one now
  const account = isSessionKey(user.sessionKey) ? user : await ensureSessionKey(c.env.DB, user.id);
  if (!account) return page(c, 'Log in', <LoginForm error="Wrong username or password." />);
  await signIn(c, secret, account);
  return c.redirect('/');
});

auth.post('/auth/logout', (c) => {
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
  return c.redirect('/login');
});

type SetupField = 'username' | 'password' | 'confirm';

/** `wrong`: the fields the error is about, which point at it. */
const SetupForm = ({ error, wrong = [] }: { error?: string; wrong?: SetupField[] }) => (
  <article class="auth-card">
    <Brand />
    <h1>Welcome</h1>
    <p class="muted">Create the admin account. Family members can be added later under Members.</p>
    {error ? (
      <p class="error" role="alert" id="setup-error">
        {error}
      </p>
    ) : null}
    <form method="post" action="/setup">
      <label>
        Username
        {/* eslint-disable-next-line no-restricted-syntax -- setup is one form, on a fresh instance: its first field is where everyone starts */}
        <input name="username" required autofocus autocomplete="username" {...invalid(wrong.includes('username') && error, 'setup-error')} />
      </label>
      <label>
        Password <small>(at least 8 characters)</small>
        <input type="password" name="password" required minlength={8} autocomplete="new-password" {...invalid(wrong.includes('password') && error, 'setup-error')} />
      </label>
      <label>
        Confirm password
        <input type="password" name="confirm" required autocomplete="new-password" {...invalid(wrong.includes('confirm') && error, 'setup-error')} />
      </label>
      <button type="submit">Create account</button>
    </form>
  </article>
);

auth.get('/setup', async (c) => {
  if (!hasSessionSecret(c.env.SESSION_SECRET)) return setupWithoutSecret(c, false);
  if ((await countUsers(c.env.DB)) > 0) return c.notFound();
  return page(c, 'Setup', <SetupForm />);
});

// starter shelves for the three media types this household collects
const STARTER_SHELVES = ['Books', 'Board games', 'Vinyl'];

auth.post('/setup', async (c) => {
  const secret = c.env.SESSION_SECRET;
  if (!hasSessionSecret(secret)) return setupWithoutSecret(c, true);
  if ((await countUsers(c.env.DB)) > 0) return c.notFound();
  const body = await c.req.parseBody();
  const username = String(body['username'] ?? '').trim();
  const password = String(body['password'] ?? '');
  const confirm = String(body['confirm'] ?? '');
  if (!username || password.length < 8) {
    return page(c, 'Setup', <SetupForm error="Username required; password must be at least 8 characters." wrong={['username', 'password']} />);
  }
  if (password !== confirm) {
    return page(c, 'Setup', <SetupForm error="Passwords do not match." wrong={['confirm']} />);
  }
  // The count above only saves hashing on a closed setup. The batch decides: of two setups racing, one wins. The
  // loser goes to login, which says why: usually it's the second click of a double-click, whose response is the
  // page the browser shows, and the password just chosen works there.
  const admin = await createFirstAdmin(c.env.DB, { username, passwordHash: await hashPassword(password) }, STARTER_SHELVES);
  if (admin === null) return c.redirect('/login?raced=1');
  await signIn(c, secret, admin);
  return c.redirect('/');
});

export default auth;
