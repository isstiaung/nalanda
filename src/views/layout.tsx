import type { Context } from 'hono';
import type { Child, FC, PropsWithChildren } from 'hono/jsx';
import type { Library } from '../db/schema';
import { listLibraries } from '../db/queries';
import type { AppEnv, SessionUser } from '../env';
import { loadIdentity } from '../federation/keys';

type NavLibrary = Library & { itemCount: number };

const Head: FC<{ title: string }> = ({ title }) => (
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="theme-color" content="#f6f2e7" media="(prefers-color-scheme: light)" />
    <meta name="theme-color" content="#171310" media="(prefers-color-scheme: dark)" />
    <title>{title} · Nalanda</title>
    <link rel="icon" href="/logo.svg" type="image/svg+xml" />
    <link rel="apple-touch-icon" href="/icons/apple-touch-icon.png" />
    <link rel="manifest" href="/manifest.webmanifest" />
    <link rel="stylesheet" href="/app.css" />
    {/* Before paint, not in app.js (which is deferred): a deferred script would let
        the full table render first and then visibly drop columns. */}
    <script
      dangerouslySetInnerHTML={{
        __html:
          "try{var h=localStorage.getItem('nalanda:hidden-columns');" +
          "if(h)document.documentElement.setAttribute('data-hide-cols',h);}catch(e){}",
      }}
    />
    {/* Confirmation prompts. Their text lives in a data-confirm attribute, never in an inline handler: a name
        someone typed must stay text, and the browser decodes HTML escapes back into quotes before it runs
        inline code — a shelf named x'); … would run as script for whoever pressed Delete. Inline here rather
        than in the deferred app.js, so a quick tap on a destructive button can't beat the listener. */}
    <script
      dangerouslySetInnerHTML={{
        __html:
          // A refusal also stops the event: htmx submits from its own listener on the form, which ignores a
          // cancelled default. Capturing at the document runs first, so a stopped event never reaches it.
          "function no(e){e.preventDefault();e.stopImmediatePropagation();}" +
          "document.addEventListener('submit',function(e){var f=e.target;" +
          "if(f&&f.dataset&&f.dataset.confirm&&!confirm(f.dataset.confirm))no(e);},true);" +
          "document.addEventListener('click',function(e){var b=e.target&&e.target.closest?e.target.closest('button[data-confirm]'):null;" +
          "if(b&&!confirm(b.dataset.confirm))no(e);},true);",
      }}
    />
    <script src="/vendor/htmx.min.js" defer></script>
    <script src="/app.js" defer></script>
  </head>
);

export const Brand: FC = () => (
  <a href="/" class="brand">
    <div class="brand-rule"></div>
    <div class="brand-name">Nalanda</div>
    <div class="brand-sub">
      <span class="brand-deva" lang="sa">
        नालन्दा
      </span>
      {' · home library registry'}
    </div>
  </a>
);

const NavLink: FC<{ href: string; label: string; path: string; count?: number; exact?: boolean }> = ({
  href,
  label,
  path,
  count,
  exact,
}) => {
  const active = exact ? path === href : path === href || path.startsWith(`${href}/`);
  return (
    <a href={href} class={active ? 'nav-link active' : 'nav-link'}>
      <span>{label}</span>
      {count !== undefined ? <span class="nav-count">{count}</span> : null}
    </a>
  );
};

const Sidebar: FC<{ user: SessionUser; path: string; libraries: NavLibrary[]; federation: boolean }> = ({
  user,
  path,
  libraries,
  federation,
}) => (
  <aside class="sidebar" id="sidebar">
    <Brand />
    <nav class="nav-section" aria-label="Catalog">
      <div class="nav-eyebrow">Catalog</div>
      <NavLink href="/" label="Overview" path={path} exact />
      <NavLink href="/add" label="Add items" path={path} />
      <NavLink href="/search" label="Search" path={path} />
      <NavLink href="/tags" label="Tags" path={path} />
    </nav>
    <nav class="nav-section" aria-label="Circulation">
      <div class="nav-eyebrow">Circulation</div>
      <NavLink href="/loans" label="Loans" path={path} />
      {federation ? <NavLink href="/feed" label="Feed" path={path} /> : null}
      {federation ? <NavLink href="/borrowed" label="Borrowed" path={path} /> : null}
      {user.role === 'admin' ? <NavLink href="/shares" label="Shared links" path={path} /> : null}
      {federation && user.role === 'admin' ? <NavLink href="/connections" label="Connections" path={path} /> : null}
    </nav>
    <nav class="nav-section" aria-label="Shelves">
      <div class="nav-eyebrow">Shelves</div>
      {libraries.map((l) => (
        <NavLink href={`/libraries/${l.id}`} label={l.name} path={path} count={l.itemCount} />
      ))}
    </nav>
    <nav class="nav-section" aria-label="Data">
      <div class="nav-eyebrow">Data</div>
      <NavLink href="/import" label="Import / export" path={path} />
      {user.role === 'admin' ? <NavLink href="/settings/users" label="Members" path={path} /> : null}
    </nav>
    <div class="sidebar-foot">
      <div class="whoami">
        {user.username} · {user.role}
      </div>
      <NavLink href="/account" label="Account" path={path} />
      <form method="post" action="/auth/logout">
        <button class="linklike" type="submit">
          Log out
        </button>
      </form>
    </div>
  </aside>
);

export const Layout: FC<
  PropsWithChildren<{
    title: string;
    user?: SessionUser | null;
    path?: string;
    libraries?: NavLibrary[];
    federation?: boolean;
  }>
> = ({ title, user, path = '/', libraries = [], federation = false, children }) => (
  <html lang="en">
    <Head title={title} />
    {user ? (
      <body>
        <div class="app">
          <Sidebar user={user} path={path} libraries={libraries} federation={federation} />
          <div>
            <header class="mobile-bar">
              <button type="button" id="nav-toggle" class="btn-quiet" aria-label="Menu" aria-controls="sidebar">
                ☰
              </button>
              <span class="brand-name">Nalanda</span>
            </header>
            <main class="content">
              <div class="content-inner">{children}</div>
            </main>
          </div>
        </div>
      </body>
    ) : (
      <body>
        <main class="auth-shell">{children}</main>
      </body>
    )}
  </html>
);

/** Renders a full page (doctype + app shell). Partials use c.html(<Fragment/>) directly. */
export async function page(c: Context<AppEnv>, title: string, body: Child) {
  const user = (c.get('user') as SessionUser | undefined) ?? null;
  const path = new URL(c.req.url).pathname;
  const libraries = user ? await listLibraries(c.env.DB) : [];
  // Feed and Connections exist only on an instance with a federation key; only admins manage connections.
  const federation = !!user && !!(await loadIdentity(c.env.FEDERATION_PRIVATE_KEY));
  return c.html(`<!doctype html>${Layout({ title, user, path, libraries, federation, children: body })}`);
}
