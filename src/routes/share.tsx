// PUBLIC routes — no session. Every field rendered here must come through
// toPublicItem() (src/lib/share.ts). See ARCH.md §9 and CLAUDE.md privacy invariants.
import { Hono, type Context } from 'hono';
import type { Child, FC, PropsWithChildren } from 'hono/jsx';
import { getItem, getShareByToken, listItems, tagsForItems } from '../db/queries';
import type { AppEnv } from '../env';
import { itemMatchesShare, toPublicItem, type PublicItem } from '../lib/share';
import { DetailsList, MEDIA_ICON, MEDIA_LABEL, NotOwnedPill, Pagination, stars } from '../views/components';

const share = new Hono<AppEnv>();

/**
 * The public pages are the app's many-readers surface, and D1's read quota is
 * shared with the authenticated app — so rendered share HTML is served from a
 * per-isolate memory cache. Memory (not the edge Cache API) because the Cache
 * API is a no-op on workers.dev domains; this shields bursts on any domain,
 * per colo isolate. Every successful mutation anywhere in the app clears this
 * isolate's cache (see index.ts), so the household's own edits go public
 * immediately; isolates the mutation never reached converge within the TTL or
 * on isolate eviction, whichever comes first. Consequence of the long TTL:
 * a ROTATED/REMOVED link can keep serving from an untouched isolate for up to
 * an hour (ARCH.md §16 #19). Only 200s are cached; entries are capped and
 * evicted oldest-first.
 */
const PAGE_TTL_MS = 60 * 60_000; // 1 hour
const PAGE_CACHE_MAX = 200;
const pageCache = new Map<string, { body: string; headers: [string, string][]; expires: number }>();

/** Called after any successful mutation — the "force cache update" hook. */
export function clearSharePageCache(): void {
  pageCache.clear();
}

share.use('*', async (c, next) => {
  if (c.req.method !== 'GET') return next();
  const key = c.req.url;
  const hit = pageCache.get(key);
  if (hit && hit.expires > Date.now()) {
    return new Response(hit.body, { headers: [...hit.headers, ['x-cache', 'hit']] });
  }
  await next();
  if (c.res.status === 200) {
    const headers: [string, string][] = [...c.res.headers.entries()];
    const body = await c.res.text();
    if (pageCache.size >= PAGE_CACHE_MAX) {
      const oldest = pageCache.keys().next().value;
      if (oldest !== undefined) pageCache.delete(oldest);
    }
    pageCache.set(key, { body, headers, expires: Date.now() + PAGE_TTL_MS });
    c.res = new Response(body, { headers: [...headers, ['x-cache', 'miss']] });
  }
});

const ShareLayout: FC<PropsWithChildren<{ title: string; shelf: string }>> = ({ title, shelf, children }) => (
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <meta name="robots" content="noindex" />
      <meta name="theme-color" content="#f6f2e7" media="(prefers-color-scheme: light)" />
      <meta name="theme-color" content="#171310" media="(prefers-color-scheme: dark)" />
      <title>{title}</title>
      <link rel="icon" href="/logo.svg" type="image/svg+xml" />
      <link rel="stylesheet" href="/app.css" />
    </head>
    <body>
      <main class="share-shell">
        <div class="share-head">
          <div>
            <div class="brand-rule"></div>
            <div class="share-mark">Nalanda · shared shelf</div>
            <h1>{shelf}</h1>
          </div>
        </div>
        {children}
        <footer class="share-footer">
          Shared read-only from a Nalanda home library ·{' '}
          <span lang="sa">नालन्दा</span>
        </footer>
      </main>
    </body>
  </html>
);

const PublicCard: FC<{ item: PublicItem; token: string }> = ({ item, token }) => (
  <a href={`/share/${token}/items/${item.id}`} class="item-card">
    <div class="item-cover">
      {item.coverKey ? (
        <img class="cover-img" src={`/covers/${item.coverKey}`} alt={`Cover of ${item.title}`} loading="lazy" />
      ) : (
        <div class="cover-fallback">{MEDIA_ICON[item.mediaType]}</div>
      )}
    </div>
    <div class="item-meta">
      <strong>{item.title}</strong>
      {item.creators ? <small>{item.creators}</small> : null}
      <span class="mline">
        <small class="muted">{MEDIA_LABEL[item.mediaType]}</small>
        {item.rating ? <span class="rating">{stars(item.rating)}</span> : null}
        {!item.inCollection ? <NotOwnedPill /> : null}
      </span>
    </div>
  </a>
);

function renderShare(c: Context<AppEnv>, title: string, shelf: string, body: Child) {
  return c.html(`<!doctype html>${ShareLayout({ title, shelf, children: body })}`);
}

share.get('/:token', async (c) => {
  const token = c.req.param('token');
  const view = await getShareByToken(c.env.DB, token);
  if (!view) return c.notFound();
  const pageNum = Number.parseInt(c.req.query('page') ?? '1', 10) || 1;
  const { items, total, page: current, pages } = await listItems(c.env.DB, view.libraryId, {
    mediaType: view.mediaType ?? undefined,
    status: view.status ?? undefined,
    owned: view.owned ?? undefined,
    sort: view.sort,
    page: pageNum,
  });
  const publicItems = items.map(toPublicItem);

  return renderShare(
    c,
    view.name,
    view.name,
    <>
      <p class="eyebrow">
        {total} {total === 1 ? 'item' : 'items'}
      </p>
      <div class="item-grid">
        {publicItems.map((item) => (
          <PublicCard item={item} token={token} />
        ))}
      </div>
      <Pagination page={current} pages={pages} makeHref={(p) => `/share/${token}?page=${p}`} />
    </>,
  );
});

share.get('/:token/items/:id', async (c) => {
  const token = c.req.param('token');
  const view = await getShareByToken(c.env.DB, token);
  if (!view) return c.notFound();
  const item = await getItem(c.env.DB, Number(c.req.param('id')));
  if (!item || !itemMatchesShare(view, item)) return c.notFound(); // token only unlocks its own view
  const pub = toPublicItem(item);
  const tags = (await tagsForItems(c.env.DB, [item.id])).get(item.id) ?? [];

  return renderShare(
    c,
    `${pub.title} · ${view.name}`,
    view.name,
    <article class="item-detail">
      <div class="item-detail-cover">
        {pub.coverKey ? (
          <img class="cover-img" src={`/covers/${pub.coverKey}`} alt={`Cover of ${pub.title}`} />
        ) : (
          <div class="cover-fallback">{MEDIA_ICON[pub.mediaType]}</div>
        )}
      </div>
      <div class="item-detail-body">
        <hgroup>
          <h1>{pub.title}</h1>
          {pub.creators ? <p>{pub.creators}</p> : null}
        </hgroup>
        {tags.length ? (
          <p>
            {tags.map((t) => (
              <span class="tag">{t}</span>
            ))}
          </p>
        ) : null}
        <dl class="props">
          <dt>Type</dt>
          <dd>{MEDIA_LABEL[pub.mediaType]}</dd>
          {!pub.inCollection ? (
            <>
              <dt>Holding</dt>
              <dd>
                <NotOwnedPill /> read, not on these shelves
              </dd>
            </>
          ) : null}
          {pub.rating ? (
            <>
              <dt>Rating</dt>
              <dd>
                <span class="rating">{stars(pub.rating)}</span>
              </dd>
            </>
          ) : null}
          {pub.published ? (
            <>
              <dt>Published</dt>
              <dd>{pub.published}</dd>
            </>
          ) : null}
          {pub.publisher ? (
            <>
              <dt>Publisher</dt>
              <dd>{pub.publisher}</dd>
            </>
          ) : null}
          {pub.length ? (
            <>
              <dt>Length</dt>
              <dd class="mono">{pub.length}</dd>
            </>
          ) : null}
        </dl>
        {pub.description ? <p class="prewrap">{pub.description}</p> : null}
        {Object.keys(pub.details).length ? (
          <div class="detail-section">
            <p class="eyebrow">Details</p>
            <DetailsList details={pub.details} />
          </div>
        ) : null}
        {pub.review ? (
          <div class="detail-section">
            <p class="eyebrow">Review</p>
            <p class="prewrap">{pub.review}</p>
          </div>
        ) : null}
        <p>
          <a href={`/share/${token}`}>← back to {view.name}</a>
        </p>
      </div>
    </article>,
  );
});

export default share;
