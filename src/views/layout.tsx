import type { Context } from 'hono';
import type { Child, FC, PropsWithChildren } from 'hono/jsx';
import type { AppEnv, SessionUser } from '../env';

const NAV = [
  ['/', 'Home'],
  ['/add', 'Add'],
  ['/search', 'Search'],
  ['/loans', 'Loans'],
  ['/tags', 'Tags'],
] as const;

export const Layout: FC<PropsWithChildren<{ title: string; user?: SessionUser | null; path?: string }>> = ({
  title,
  user,
  path,
  children,
}) => (
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>{title} · Nalanda</title>
      <link rel="stylesheet" href="/vendor/pico.min.css" />
      <link rel="stylesheet" href="/app.css" />
      <script src="/vendor/htmx.min.js" defer></script>
      <script src="/app.js" defer></script>
    </head>
    <body>
      <header class="container">
        <nav>
          <ul>
            <li>
              <a href="/" class="brand">
                📚 Nalanda
              </a>
            </li>
          </ul>
          {user ? (
            <ul>
              {NAV.map(([href, label]) => (
                <li>
                  <a href={href} class={path === href ? 'active' : undefined}>
                    {label}
                  </a>
                </li>
              ))}
              {user.role === 'admin' ? (
                <li>
                  <a href="/settings/users" class={path?.startsWith('/settings') ? 'active' : undefined}>
                    Settings
                  </a>
                </li>
              ) : null}
              <li>
                <form method="post" action="/auth/logout" class="inline">
                  <button class="linklike" type="submit">
                    Log out
                  </button>
                </form>
              </li>
            </ul>
          ) : null}
        </nav>
      </header>
      <main class="container">{children}</main>
    </body>
  </html>
);

/** Renders a full page (doctype + layout). Partials use c.html(<Fragment/>) directly. */
export function page(c: Context<AppEnv>, title: string, body: Child) {
  const user = (c.get('user') as SessionUser | undefined) ?? null;
  const path = new URL(c.req.url).pathname;
  return c.html(`<!doctype html>${Layout({ title, user, path, children: body })}`);
}
