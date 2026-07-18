import type { Context } from 'hono';
import type { Child, FC, PropsWithChildren } from 'hono/jsx';
import type { Library } from '../db/schema';
import { listLibraries } from '../db/queries';
import type { AppEnv, SessionUser } from '../env';

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

const Sidebar: FC<{ user: SessionUser; path: string; libraries: NavLibrary[] }> = ({ user, path, libraries }) => (
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
  PropsWithChildren<{ title: string; user?: SessionUser | null; path?: string; libraries?: NavLibrary[] }>
> = ({ title, user, path = '/', libraries = [], children }) => (
  <html lang="en">
    <Head title={title} />
    {user ? (
      <body>
        <div class="app">
          <Sidebar user={user} path={path} libraries={libraries} />
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
  return c.html(`<!doctype html>${Layout({ title, user, path, libraries, children: body })}`);
}
