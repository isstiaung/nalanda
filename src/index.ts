import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { secureHeaders } from 'hono/secure-headers';
import { countUsers, getShareByToken, getUserById } from './db/queries';
import type { AppEnv } from './env';
import federationRoutes from './federation/routes';
import { SESSION_COOKIE, sessionMatches, verifySessionToken } from './lib/auth';
import { serveCover } from './lib/covers';
import accountRoutes from './routes/account';
import addRoutes from './routes/add';
import authRoutes from './routes/auth';
import borrowingRoutes from './routes/borrowing';
import bulkRoutes from './routes/bulk';
import commentsRoutes from './routes/comments';
import connectionsRoutes from './routes/connections';
import dashboardRoutes from './routes/dashboard';
import feedRoutes from './routes/feed';
import goalRoutes from './routes/goals';
import importExportRoutes from './routes/importexport';
import itemRoutes from './routes/items';
import libraryRoutes from './routes/libraries';
import loanRoutes from './routes/loans';
import { MISSING_ASSET, notFound } from './routes/notfound';
import notificationsRoutes from './routes/notifications';
import recommendationsRoutes from './routes/recommendations';
import searchRoutes from './routes/search';
import settingsRoutes from './routes/settings';
import shareRoutes, { clearSharePageCache } from './routes/share';
import shareAdminRoutes from './routes/shares';
import seriesRoutes from './routes/series';
import tagRoutes from './routes/tags';
import wantRoutes from './routes/wants';

const app = new Hono<AppEnv>();

// Connected households' pages load covers from here (docs/proposals/connections.md §7), which
// secureHeaders' same-origin resource policy would block. Registered first, so it runs last on the
// way out: it relaxes that policy for covers alone, and only on an instance with a federation key.
app.use('/covers/*', async (c, next) => {
  await next();
  if (c.env.FEDERATION_PRIVATE_KEY && c.res.status === 200) {
    c.res.headers.set('cross-origin-resource-policy', 'cross-origin');
  }
});

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

// ---- public: connections between instances — signature-authenticated, 404 unless enabled ----
// (docs/proposals/connections.md). Peers never hold a session, so this sits before the session middleware.
app.route('/', federationRoutes);

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
  // a file that isn't there, asked for by a tag, not a person: a plain 404 whoever asks, and no session lookup
  if (MISSING_ASSET.test(c.req.path)) return c.text('Not found', 404);
  const token = getCookie(c, SESSION_COOKIE);
  const session = await verifySessionToken(c.env.SESSION_SECRET, token, Math.floor(Date.now() / 1000));
  // The row check is instant revocation, and its key is who the cookie was made for: an id can be reused, a key
  // can't (§16 #56), so a removed member's cookie signs in nobody — not whoever is given their id next.
  const row = session ? await getUserById(c.env.DB, session.userId) : null;
  const user = row && sessionMatches(session, row) ? row : null;
  if (!user) {
    if ((await countUsers(c.env.DB)) === 0) return c.redirect('/setup');
    return c.redirect('/login');
  }
  c.set('user', {
    id: user.id,
    username: user.username,
    role: user.role,
    mustChangePassword: user.mustChangePassword,
    sessionKey: user.sessionKey,
  });
  if (user.mustChangePassword && !c.req.path.startsWith('/account')) return c.redirect('/account');
  await next();
});

app.route('/', dashboardRoutes);
app.route('/', goalRoutes);
app.route('/', libraryRoutes);
app.route('/', shareAdminRoutes);
app.route('/', itemRoutes);
app.route('/', bulkRoutes);
app.route('/', addRoutes);
app.route('/', loanRoutes);
app.route('/', tagRoutes);
app.route('/', seriesRoutes);
app.route('/', wantRoutes);
app.route('/', searchRoutes);
app.route('/', importExportRoutes);
app.route('/', accountRoutes);
app.route('/', settingsRoutes);
app.route('/', connectionsRoutes);
app.route('/', feedRoutes);
app.route('/', commentsRoutes);
app.route('/', borrowingRoutes);
app.route('/', recommendationsRoutes);
app.route('/', notificationsRoutes);

app.notFound(notFound);
app.onError((err, c) => {
  console.error(err);
  return c.text('Something went wrong.', 500);
});

export default app;
