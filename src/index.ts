import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { secureHeaders } from 'hono/secure-headers';
import { countUsers, getShareByToken, getUserById } from './db/queries';
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
import shareRoutes, { clearSharePageCache } from './routes/share';
import shareAdminRoutes from './routes/shares';
import tagRoutes from './routes/tags';

const app = new Hono<AppEnv>();

// nosniff, frame denial, HSTS — no CSP (we use inline onsubmit= confirms).
// Referrer policy must NOT be no-referrer: browsers apply referrer policy to the
// Origin header too, sending `Origin: null` on same-origin form posts — which
// would make our own CSRF check reject every login.
app.use(secureHeaders({ referrerPolicy: 'strict-origin-when-cross-origin' }));

// CSRF: SameSite=Lax cookies + same-site check on every mutation (ARCH.md §8).
// Sec-Fetch-Site is the primary signal (sent by all modern browsers, immune to
// referrer-policy quirks); the Origin comparison is the legacy fallback.
app.use(async (c, next) => {
  const method = c.req.method;
  if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
    const site = c.req.header('sec-fetch-site');
    const origin = c.req.header('origin');
    const allowed = site
      ? site === 'same-origin' || site === 'none' // none = direct user navigation
      : !origin || origin === new URL(c.req.url).origin;
    if (!allowed) return c.text('Forbidden', 403);
  }
  await next();
  // Writes invalidate, coarsely: any successful mutation clears this isolate's
  // share-page cache so edits/rotations go public here immediately. Other
  // isolates converge within the cache TTL (ARCH.md §16 #19).
  if (method !== 'GET' && c.res.status < 400) clearSharePageCache();
});

// ---- public: setup/login/logout, share links, cover images ----
app.route('/', authRoutes);
app.route('/share', shareRoutes);
app.get('/covers/:key', (c) => serveCover(c.env.COVERS, c.req.param('key')));

// ---- front door: with HOME_SHARE_TOKEN set, anonymous "/" lands on that share ----
// The token lives in a secret so the front page can be repointed (e.g. after a share
// rotation) with `wrangler secret put HOME_SHARE_TOKEN` — no code deploy. Signed-in
// users keep their dashboard; a stale token falls through to the login redirect
// instead of 404ing the front door. (ARCH.md §16 #21)
app.get('/', async (c, next) => {
  const homeToken = c.env.HOME_SHARE_TOKEN;
  if (!homeToken) return next();
  const session = getCookie(c, SESSION_COOKIE);
  if (await verifySessionToken(c.env.SESSION_SECRET, session, Math.floor(Date.now() / 1000))) return next();
  const share = await getShareByToken(c.env.DB, homeToken);
  return share ? c.redirect(`/share/${homeToken}`) : next();
});

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
app.route('/', shareAdminRoutes);
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
