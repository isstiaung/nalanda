import { Hono } from 'hono';
import { deleteCookie, setCookie } from 'hono/cookie';
import {
  countUsers,
  createLibrary,
  createUser,
  getUserByUsername,
  recentLoginAttempts,
  recordLoginAttempt,
} from '../db/queries';
import type { AppEnv } from '../env';
import {
  createSessionToken,
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

auth.get('/login', async (c) => {
  if ((await countUsers(c.env.DB)) === 0) return c.redirect('/setup');
  return page(c, 'Log in', <LoginForm />);
});

auth.post('/auth/login', async (c) => {
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
  const token = await createSessionToken(c.env.SESSION_SECRET, user.id, Math.floor(Date.now() / 1000));
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
  if ((await countUsers(c.env.DB)) > 0) return c.notFound();
  return page(c, 'Setup', <SetupForm />);
});

auth.post('/setup', async (c) => {
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
  const user = await createUser(c.env.DB, {
    username,
    passwordHash: await hashPassword(password),
    role: 'admin',
    mustChangePassword: false,
  });
  // starter shelves for the three media types this household collects
  for (const name of ['Books', 'Board games', 'Vinyl']) {
    await createLibrary(c.env.DB, name);
  }
  const token = await createSessionToken(c.env.SESSION_SECRET, user.id, Math.floor(Date.now() / 1000));
  setSessionCookie(c, token, new URL(c.req.url).protocol === 'https:');
  return c.redirect('/');
});

export default auth;
