import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { secureHeaders } from 'hono/secure-headers';
import { countUsers, getUserById } from './db/queries';
import type { AppEnv } from './env';
import { SESSION_COOKIE, verifySessionToken } from './lib/auth';
import { serveCover } from './lib/covers';
import accountRoutes from './routes/account';
import addRoutes from './routes/add';
import authRoutes from './routes/auth';
import dashboardRoutes from './routes/dashboard';
import importExportRoutes from './routes/importexport';
import itemRoutes from './routes/items';
import libraryRoutes from './routes/libraries';
import loanRoutes from './routes/loans';
import searchRoutes from './routes/search';
import settingsRoutes from './routes/settings';
import shareRoutes from './routes/share';
import tagRoutes from './routes/tags';

const app = new Hono<AppEnv>();

// nosniff, frame denial, HSTS, referrer policy — defaults only, no CSP (we use
// inline onsubmit= confirms; revisit if that changes)
app.use(secureHeaders());

// CSRF: SameSite=Lax cookies + same-origin check on every mutation (ARCH.md §8).
app.use(async (c, next) => {
  const method = c.req.method;
  if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
    const origin = c.req.header('origin');
    if (origin && origin !== new URL(c.req.url).origin) return c.text('Forbidden', 403);
  }
  await next();
});

// ---- public: setup/login/logout, share links, cover images ----
app.route('/', authRoutes);
app.route('/share', shareRoutes);
app.get('/covers/:key', (c) => serveCover(c.env.COVERS, c.req.param('key')));

// ---- everything registered below this middleware requires a session ----
app.use(async (c, next) => {
  const token = getCookie(c, SESSION_COOKIE);
  const userId = await verifySessionToken(c.env.SESSION_SECRET, token, Math.floor(Date.now() / 1000));
  const user = userId ? await getUserById(c.env.DB, userId) : null; // row check = instant revocation
  if (!user) {
    if ((await countUsers(c.env.DB)) === 0) return c.redirect('/setup');
    return c.redirect('/login');
  }
  c.set('user', {
    id: user.id,
    username: user.username,
    role: user.role,
    mustChangePassword: user.mustChangePassword,
  });
  if (user.mustChangePassword && !c.req.path.startsWith('/account')) return c.redirect('/account');
  await next();
});

app.route('/', dashboardRoutes);
app.route('/', libraryRoutes);
app.route('/', itemRoutes);
app.route('/', addRoutes);
app.route('/', loanRoutes);
app.route('/', tagRoutes);
app.route('/', searchRoutes);
app.route('/', importExportRoutes);
app.route('/', accountRoutes);
app.route('/', settingsRoutes);

app.notFound((c) => c.text('Not found', 404));
app.onError((err, c) => {
  console.error(err);
  return c.text('Something went wrong.', 500);
});

export default app;
