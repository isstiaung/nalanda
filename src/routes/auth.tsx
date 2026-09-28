import { Hono, type Context } from 'hono';
import { deleteCookie, setCookie } from 'hono/cookie';
import {
  countUsers,
  createFirstAdmin,
  getUserByUsername,
  recentLoginAttempts,
  recordLoginAttempt,
} from '../db/queries';
import type { AppEnv } from '../env';
import {
  createSessionToken,
  hasSessionSecret,
  hashPassword,
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  verifyPassword,
} from '../lib/auth';
import { Brand, page } from '../views/layout';

const auth = new Hono<AppEnv>();

function setSessionCookie(c: Parameters<typeof setCookie>[0], token: string, secure: boolean) {
  setCookie(c, SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'Lax',
    secure,
    maxAge: SESSION_TTL_SECONDS,
  });
}

const LoginForm = ({ error }: { error?: string }) => (
  <article class="auth-card">
    <Brand />
    <h1>Log in</h1>
    {error ? <p class="error">{error}</p> : null}
    <form method="post" action="/auth/login">
      <label>
        Username
        <input name="username" required autofocus autocomplete="username" />
      </label>
      <label>
        Password
        <input type="password" name="password" required autocomplete="current-password" />
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
// it — and then setup will be gone: log in with the password chosen for it.
async function setupWithoutSecret(c: Context<AppEnv>, posted: boolean) {
  if ((await countUsers(c.env.DB)) > 0) return noSessionSecret(c, 'An account already exists: once it is set, log in with it.');
  return noSessionSecret(c, posted ? 'Nothing was saved: set it, then create the account again.' : undefined);
}

auth.get('/login', async (c) => {
  if (!hasSessionSecret(c.env.SESSION_SECRET)) return noSessionSecret(c);
  if ((await countUsers(c.env.DB)) === 0) return c.redirect('/setup');
  return page(c, 'Log in', <LoginForm />);
});

auth.post('/auth/login', async (c) => {
  const secret = c.env.SESSION_SECRET;
  if (!hasSessionSecret(secret)) return noSessionSecret(c);
  const ip = c.req.header('cf-connecting-ip') ?? 'local';
  if ((await recentLoginAttempts(c.env.DB, ip)) >= 10) {
    return page(c, 'Log in', <LoginForm error="Too many attempts — try again in 10 minutes." />);
  }
  const body = await c.req.parseBody();
  const username = String(body['username'] ?? '').trim();
  const password = String(body['password'] ?? '');
  const user = username ? await getUserByUsername(c.env.DB, username) : null;
  const ok = user ? await verifyPassword(password, user.passwordHash) : false;
  if (!user || !ok) {
    await recordLoginAttempt(c.env.DB, ip);
    return page(c, 'Log in', <LoginForm error="Wrong username or password." />);
  }
  const token = await createSessionToken(secret, user.id, Math.floor(Date.now() / 1000));
  setSessionCookie(c, token, new URL(c.req.url).protocol === 'https:');
  return c.redirect('/');
});

auth.post('/auth/logout', (c) => {
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
  return c.redirect('/login');
});

const SetupForm = ({ error }: { error?: string }) => (
  <article class="auth-card">
    <Brand />
    <h1>Welcome</h1>
    <p class="muted">Create the admin account. Family members can be added later under Members.</p>
    {error ? <p class="error">{error}</p> : null}
    <form method="post" action="/setup">
      <label>
        Username
        <input name="username" required autofocus autocomplete="username" />
      </label>
      <label>
        Password <small>(at least 8 characters)</small>
        <input type="password" name="password" required minlength={8} autocomplete="new-password" />
      </label>
      <label>
        Confirm password
        <input type="password" name="confirm" required autocomplete="new-password" />
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
    return page(c, 'Setup', <SetupForm error="Username required; password must be at least 8 characters." />);
  }
  if (password !== confirm) {
    return page(c, 'Setup', <SetupForm error="Passwords do not match." />);
  }
  // The count above only saves hashing on a closed setup. The batch decides: of two setups racing, one wins. The
  // loser goes to login: usually it's the second click of a double-click, whose response is the page the browser
  // shows, and the password just chosen works there.
  const adminId = await createFirstAdmin(c.env.DB, { username, passwordHash: await hashPassword(password) }, STARTER_SHELVES);
  if (adminId === null) return c.redirect('/login');
  const token = await createSessionToken(secret, adminId, Math.floor(Date.now() / 1000));
  setSessionCookie(c, token, new URL(c.req.url).protocol === 'https:');
  return c.redirect('/');
});

export default auth;
