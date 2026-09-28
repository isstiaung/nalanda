// The 404 page. Signed-in readers get it inside the app, with the sidebar to find their way back; a public share
// link that no longer resolves gets the share page's own frame. That one says only that the link has changed or
// gone — the same words whether the token never existed, was rotated, or names an item outside its view — so it
// tells a visitor nothing about what is or was shared (CLAUDE.md, privacy invariants). Everything else — machine
// endpoints, htmx partials, JSON — keeps the plain-text 404 its callers read.
import type { Context } from 'hono';
import type { AppEnv, SessionUser } from '../env';
import { page } from '../views/layout';
import { shareNotFound } from './share';

export async function notFound(c: Context<AppEnv>): Promise<Response> {
  const path = c.req.path;
  if (path === '/share' || path.startsWith('/share/')) return shareNotFound(c);
  const user = c.get('user') as SessionUser | undefined; // unset before the session middleware
  if (!user || c.req.header('HX-Request') || path.startsWith('/api/')) return c.text('Not found', 404);
  c.status(404);
  return page(
    c,
    'Not found',
    <>
      <div class="page-head">
        <div>
          <h1>Not found</h1>
          <span class="sub">NOTHING AT THIS ADDRESS</span>
        </div>
      </div>
      <p class="muted">It may have been removed, or the link is mistyped.</p>
      <p class="back-link">
        <a href="/">← Overview</a>
      </p>
    </>,
  );
}
