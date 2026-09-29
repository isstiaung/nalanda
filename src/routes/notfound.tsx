// The 404 page. Signed-in readers get it inside the app, with the sidebar to find their way back; a public share
// link that no longer resolves gets the share page's own frame. That one says only that the link has changed or
// gone — the same words whether the token never existed, was rotated, or names an item outside its view — so it
// tells a visitor nothing about what is or was shared (CLAUDE.md, privacy invariants). Everything else — machine
// endpoints, htmx partials, JSON, and missing files — keeps the plain-text 404 its callers read.
import type { Context } from 'hono';
import type { AppEnv, SessionUser } from '../env';
import { page } from '../views/layout';
import { shareNotFound } from './share';

const FILE_LIKE = /\.[a-z0-9]{1,5}$/i;

/**
 * Where this app's own files live: at the root (/app.css, /covers.js, /robots.txt…) or under /vendor/, /icons/ and
 * /bgg/ (BoardGameGeek's logo, which signed-out share pages load).
 * A request here that reaches the Worker is for a file that doesn't exist — the files that do are served before
 * the Worker runs — so the session middleware answers it with a plain 404, signed in or not, rather than sending a
 * <script> tag to the login page. Only these places, never a page path: a tag named "node.js" is /tags/node.js.
 */
export const MISSING_ASSET =
  /^\/(?:vendor\/|icons\/|bgg\/|[^/]+\.(?:js|mjs|css|map|png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|otf|wasm|webmanifest|txt)$)/i;

export async function notFound(c: Context<AppEnv>): Promise<Response> {
  const path = c.req.path;
  // a share handler's own c.notFound() lands here; /share paths no route matches reach shareNotFound directly
  if (path === '/share' || path.startsWith('/share/')) return shareNotFound(c);
  // A missing file — /vendor/htmx.min.js, an icon, a stylesheet — is asked for by a <script> or <img>, not a reader:
  // plain text, not a page. No page path has an extension (items, shelves and shares are ids and tokens).
  if (FILE_LIKE.test(path)) return c.text('Not found', 404);
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
