import type { Context } from 'hono';
import { getCookie } from 'hono/cookie';
import { todayFor, TZ_COOKIE } from '../lib/dates';
import type { Child, FC, PropsWithChildren } from 'hono/jsx';
import type { Library } from '../db/schema';
import { householdLocale, listLibraries } from '../db/queries';
import type { AppEnv, SessionUser } from '../env';
import { unreadCounts } from '../db/federation';
import { loadIdentity } from '../federation/keys';
import { scanQueueOwner } from '../lib/auth';
import { resolveLocale, translator, type StringKey, type Translator } from '../i18n';
import { I18n, useI18n } from './i18n';

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
    {/* installed to a home screen it opens full-screen (the manifest says so too; older iOS reads only these) */}
    <meta name="mobile-web-app-capable" content="yes" />
    <meta name="apple-mobile-web-app-capable" content="yes" />
    <meta name="apple-mobile-web-app-title" content="Nalanda" />
    <link rel="stylesheet" href="/app.css" />
    {/* Before paint, not in app.js (which is deferred): a deferred script would let
        the full table render first and then visibly drop columns. Until someone picks columns on this device,
        a window under 1400px wide starts without Tags, so the table fits beside the sidebar; Columns shows it
        again (app.js keeps the same default). */}
    <script
      dangerouslySetInnerHTML={{
        __html:
          "var h=null;try{h=localStorage.getItem('nalanda:hidden-columns');}catch(e){}" +
          "if(h===null&&window.matchMedia&&matchMedia('(max-width: 1399px)').matches)h='tags';" +
          "if(h)document.documentElement.setAttribute('data-hide-cols',h);",
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
    {/* a cover that fails to load falls back to its media icon — shared with the public share pages */}
    <script src="/covers.js" defer></script>
  </head>
);

export const Brand: FC = () => {
  const { t } = useI18n();
  return (
    <a href="/" class="brand">
      <div class="brand-rule"></div>
      <div class="brand-name">Nalanda</div>
      <div class="brand-sub">
        <span class="brand-deva" lang="sa">
          नालन्दा
        </span>
        {' · '}
        {t('brand.sub')}
      </div>
    </a>
  );
};

const isActive = (href: string, path: string, exact?: boolean) =>
  exact ? path === href : path === href || path.startsWith(`${href}/`);

const NavLink: FC<{ href: string; label: string; path: string; count?: number; unread?: number; exact?: boolean }> = ({
  href,
  label,
  path,
  count,
  unread,
  exact,
}) => {
  const { t } = useI18n();
  const active = isActive(href, path, exact);
  return (
    <a href={href} class={active ? 'nav-link active' : 'nav-link'} aria-current={active ? 'page' : undefined}>
      <span>{label}</span>
      {count !== undefined ? <span class="nav-count">{count}</span> : null}
      {unread ? (
        <span class="nav-unread" aria-label={t('nav.unread_count', { count: unread })}>
          {unread > 99 ? '99+' : unread}
        </span>
      ) : null}
    </a>
  );
};

export type Unread = { notifications: number; feed: number };
const NONE_UNREAD: Unread = { notifications: 0, feed: 0 };

/**
 * The sidebar's collapsible sections, in order (ARCH.md §16 #62). Their ids are the whole vocabulary of the `nav`
 * cookie — the sections this device's member has opened — which the server renders open, so the first paint is right.
 */
export const NAV_SECTIONS = ['library', 'shelves', 'reading', 'lending', 'sharing', 'settings'] as const;
export type NavSectionId = (typeof NAV_SECTIONS)[number];
export const NAV_COOKIE = 'nav';

/** Today where the request's device is (ARCH.md §16 #69): its `tz` cookie's zone, else UTC. */
export const todayOf = (c: Context<AppEnv>): string => todayFor(getCookie(c, TZ_COOKIE));

/**
 * What this request renders in (ARCH.md §16 #93). Behind the session middleware it is already set, from the call
 * that read the account. A page with no session — log in, setup, a share page — resolves the household's language
 * and its translation here, one call, and keeps it on the context so the page's other renders cost nothing more.
 */
export async function i18nOf(c: Context<AppEnv>): Promise<Translator> {
  const set = c.get('i18n') as Translator | undefined;
  if (set) return set;
  const { language, translation } = await householdLocale(c.env.DB);
  const i18n = translator(resolveLocale(null, { language }), translation);
  c.set('i18n', i18n);
  return i18n;
}

/**
 * The sections a `nav` cookie asks to keep open. The browser writes it, so it is only ever a filter over the known
 * ids: anything else in it — an unknown name, markup, a repeat — is dropped, and none of it reaches the page.
 */
export function navCookieSections(value: string | undefined): NavSectionId[] {
  if (!value || value.length > 100) return []; // all six ids joined are 49 characters; a longer value isn't ours
  const names = value.split('.');
  return NAV_SECTIONS.filter((id) => names.includes(id));
}

type NavEntry = { href: string; label: string; count?: number; unread?: number; exact?: boolean };
type NavGroup = { id: NavSectionId; label: string; links: NavEntry[] };

/** What each section holds for this member. A link they can't use is absent, and so is a section left empty. */
function navGroups(user: SessionUser, libraries: NavLibrary[], federation: boolean, unread: Unread, t: (key: StringKey) => string): NavGroup[] {
  const admin = user.role === 'admin';
  const only = (...links: (NavEntry | false)[]) => links.filter((l): l is NavEntry => l !== false);
  const groups: NavGroup[] = [
    {
      id: 'library',
      label: t('nav.library'),
      links: only(
        { href: '/tags', label: t('nav.tags') },
        { href: '/series', label: t('nav.series') },
        { href: '/creators', label: t('nav.creators') },
        { href: '/publishers', label: t('nav.publishers') },
      ),
    },
    {
      id: 'shelves',
      label: t('nav.shelves'),
      links: libraries.map((l) => ({ href: `/libraries/${l.id}`, label: l.name, count: l.itemCount })),
    },
    {
      id: 'reading',
      label: t('nav.reading'),
      links: only(
        { href: '/wants', label: t('nav.wants') },
        { href: '/discover', label: t('nav.discover') },
        { href: '/quotes', label: t('nav.quotes') },
        { href: '/goals', label: t('nav.goals') },
        { href: '/year-in-review', label: t('nav.year') },
      ),
    },
    {
      id: 'lending',
      label: t('nav.lending'),
      // Borrowed is for every household (§16 #82): what is borrowed from people, and from connections where there are any
      links: only({ href: '/loans', label: t('nav.loans') }, { href: '/borrowed', label: t('nav.borrowed') }),
    },
    {
      id: 'sharing',
      label: t('nav.sharing'),
      links: only(
        admin && { href: '/shares', label: t('nav.shares') },
        federation && { href: '/feed', label: t('nav.feed'), unread: unread.feed },
        federation && { href: '/notifications', label: t('nav.notifications'), unread: unread.notifications },
        federation && { href: '/recommendations', label: t('nav.recommended') },
        federation && admin && { href: '/connections', label: t('nav.connections') },
      ),
    },
    {
      id: 'settings',
      label: t('nav.settings'),
      links: only(
        { href: '/import', label: t('nav.import') },
        admin && { href: '/settings/users', label: t('nav.members') },
        admin && { href: '/trash', label: t('nav.trash') },
        { href: '/account', label: t('nav.account') },
      ),
    },
  ];
  return groups.filter((g) => g.links.length > 0);
}

/**
 * One section: a native <details>, so it opens and closes with no script and from the keyboard — its <summary> is a
 * button to assistive tech, announced expanded or collapsed — and a closed one keeps its links out of the tab order.
 * Closed, its header carries the section's unread total (CSS hides it once open, where each link shows its own).
 */
const NavSection: FC<{ group: NavGroup; path: string; open: boolean }> = ({ group, path, open }) => {
  const { t } = useI18n();
  const unread = group.links.reduce((n, l) => n + (l.unread ?? 0), 0);
  return (
    <details class="nav-section" data-nav={group.id} open={open}>
      <summary class="nav-summary">
        <span class="nav-eyebrow">{group.label}</span>
        {unread ? (
          // the count and the word "unread" read out in place, no role: "Sharing & connections, 3 unread, collapsed"
          <span class="nav-unread nav-summary-unread">
            {unread > 99 ? '99+' : unread}
            <span class="sr-only"> {t('nav.unread')}</span>
          </span>
        ) : null}
      </summary>
      <div class="nav-links">
        {group.links.map((l) => (
          <NavLink href={l.href} label={l.label} path={path} count={l.count} unread={l.unread} exact={l.exact} />
        ))}
      </div>
    </details>
  );
};

const Sidebar: FC<{
  user: SessionUser;
  path: string;
  libraries: NavLibrary[];
  federation: boolean;
  unread: Unread;
  navOpen: readonly NavSectionId[];
}> = ({ user, path, libraries, federation, unread, navOpen }) => {
  const { t } = useI18n();
  return (
    <aside class="sidebar" id="sidebar">
      <Brand />
      <nav class="nav" aria-label={t('nav.main')}>
        {/* pinned: always in view, in no section */}
        <div class="nav-pinned">
          <NavLink href="/" label={t('nav.overview')} path={path} exact />
          <NavLink href="/add" label={t('nav.add')} path={path} />
          <NavLink href="/search" label={t('nav.search')} path={path} />
        </div>
        {navGroups(user, libraries, federation, unread, t).map((g) => (
          // open if this device keeps it open, and always when it holds the page being shown
          <NavSection group={g} path={path} open={navOpen.includes(g.id) || g.links.some((l) => isActive(l.href, path, l.exact))} />
        ))}
      </nav>
      <div class="sidebar-foot">
        <div class="whoami">
          {user.username} · {t(user.role === 'admin' ? 'role.admin' : 'role.member')}
        </div>
        <form method="post" action="/auth/logout">
          <button class="linklike" type="submit">
            {t('nav.logout')}
          </button>
        </form>
      </div>
    </aside>
  );
};

export const Layout: FC<
  PropsWithChildren<{
    title: string;
    user?: SessionUser | null;
    path?: string;
    libraries?: NavLibrary[];
    federation?: boolean;
    unread?: Unread;
    /** whose offline scans this device may hold — see scanQueueOwner(); app.js reads it */
    scanOwner?: string;
    /** the sidebar sections this device keeps open — navCookieSections() of the `nav` cookie */
    navOpen?: readonly NavSectionId[];
  }>
> = ({ title, user, path = '/', libraries = [], federation = false, unread = NONE_UNREAD, scanOwner, navOpen = [], children }) => {
  const i18n = useI18n();
  const { t } = i18n;
  return (
    // the page's language (§16 #93): the member's choice, else the household's — what every string below is in
    <html lang={i18n.locale}>
      <Head title={title} />
      {user ? (
        <body data-scan-owner={scanOwner}>
          {/* the first Tab stop on every page: past the sidebar, straight to the page itself */}
          <a href="#main" class="skip-link">
            {t('app.skip')}
          </a>
          <div class="app">
            <Sidebar user={user} path={path} libraries={libraries} federation={federation} unread={unread} navOpen={navOpen} />
            <div>
              <header class="mobile-bar">
                <button type="button" id="nav-toggle" class="btn-quiet" aria-label={t('nav.menu')} aria-controls="sidebar" aria-expanded="false">
                  ☰
                </button>
                {/* the wordmark hangs from its headstroke here too — the rule lives in .brand-rule, as in the sidebar */}
                <div class="mobile-brand">
                  <div class="brand-rule"></div>
                  <div class="brand-name">Nalanda</div>
                </div>
                {/* the sidebar folds away on a phone, taking its badges with it — so the bar carries the one that matters */}
                {unread.notifications ? (
                  <a href="/notifications" class="nav-unread mobile-unread" aria-label={t('nav.unread_notifications', { count: unread.notifications })}>
                    {unread.notifications > 99 ? '99+' : unread.notifications}
                  </a>
                ) : unread.feed ? (
                  <a href="/feed" class="nav-unread mobile-unread" aria-label={t('nav.new_in_feed', { count: unread.feed })}>
                    {unread.feed > 99 ? '99+' : unread.feed}
                  </a>
                ) : null}
              </header>
              {/* tabindex=-1: the skip link moves focus here in every browser, not only where following a link does */}
              <main class="content" id="main" tabindex={-1}>
                <div class="content-inner">{children}</div>
              </main>
              {/* an htmx request that fails says so here, in fixed words (app.js, §16 #65); empty, it takes no room */}
              <output id="app-status" class="app-status" aria-live="polite"></output>
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
};

/**
 * The path the sidebar marks for a page with no link of its own: the one it's reached from. A connected household's
 * pages — its shelves and their items — belong under Lending → Borrowed, where that household is browsed from. (Its
 * feed settings, reached from Connections, already sit under Connections by their path.)
 */
export function navPath(path: string): string {
  if (/^\/households\/\d+(\/|$)/.test(path)) return '/borrowed';
  return path;
}

/**
 * Renders a full page (doctype + app shell). Partials use partial() below. A page that listed the shelves
 * itself passes that list as `shelves`, and the sidebar shows it rather than counting every item again (§16 #68) — only
 * a list read in this request after any write it made, so it is exactly what the sidebar would have read.
 * The whole tree renders inside the request's language (§16 #93): every component reads it with useI18n().
 */
export async function page(c: Context<AppEnv>, title: string, body: Child, shelves?: Awaited<ReturnType<typeof listLibraries>>) {
  const user = (c.get('user') as SessionUser | undefined) ?? null;
  const path = navPath(new URL(c.req.url).pathname);
  const libraries = user ? (shelves ?? (await listLibraries(c.env.DB))) : [];
  // Feed and Connections exist only on an instance with a federation key; only admins manage connections.
  const federation = !!user && !!(await loadIdentity(c.env.FEDERATION_PRIVATE_KEY));
  // One query, and only on an instance with connections: everything notified is about a connection.
  const unread = federation && user ? await unreadCounts(c.env.DB, user.id) : NONE_UNREAD;
  // signed in means the session secret is set: the cookie was verified with it
  const scanOwner = user && c.env.SESSION_SECRET ? await scanQueueOwner(c.env.SESSION_SECRET, user) : undefined;
  // the sidebar sections this device keeps open: a cookie app.js writes, read here so the first paint is right
  const navOpen = navCookieSections(getCookie(c, NAV_COOKIE));
  const i18n = await i18nOf(c);
  return c.html(
    `<!doctype html>${(
      <I18n.Provider value={i18n}>
        <Layout title={title} user={user} path={path} libraries={libraries} federation={federation} unread={unread} scanOwner={scanOwner} navOpen={navOpen}>
          {body}
        </Layout>
      </I18n.Provider>
    )}`,
  );
}

/** An htmx partial, rendered in the request's language as the page it lands in was (§16 #93). */
export function partial(c: Context<AppEnv>, body: Child) {
  return c.html(<I18n.Provider value={c.get('i18n')}>{body}</I18n.Provider>);
}
