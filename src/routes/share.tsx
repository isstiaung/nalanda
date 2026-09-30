// PUBLIC routes — no session. Every field rendered here must come through
// toPublicItem() (src/lib/share.ts). See ARCH.md §9 and CLAUDE.md privacy invariants.
import { Hono, type Context } from 'hono';
import type { Child, FC, PropsWithChildren } from 'hono/jsx';
import { getItem, getSeries, getShareByToken, getSiteSettings, listItems, namedReviews, playCount, tagsForItems } from '../db/queries';
import type { AppEnv } from '../env';
import { timesPlayed } from '../lib/plays';
import { formatSeriesNumber } from '../lib/series';
import { itemMatchesShare, shareFilters, toPublicItem, type PublicItem } from '../lib/share';
import { BggCredit, fromBgg } from '../views/attribution';
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

/** `bgg`: the page shows a board game, so BoardGameGeek's logo is owed in the footer (ARCH.md §16 #44). */
const ShareLayout: FC<PropsWithChildren<{ title: string; shelf: string; bgg?: boolean }>> = ({ title, shelf, bgg, children }) => (
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
      {/* a cover that fails to load falls back to its media icon */}
      <script src="/covers.js" defer></script>
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
          <span>
            Shared read-only from a Nalanda home library ·{' '}
            <span lang="sa">नालन्दा</span>
          </span>
          {bgg ? <BggCredit /> : null}
        </footer>
      </main>
    </body>
  </html>
);

const PublicCard: FC<{ item: PublicItem; token: string }> = ({ item, token }) => (
  <a href={`/share/${token}/items/${item.id}`} class="item-card">
    <div class="item-cover">
      {item.coverKey ? (
        <img
          class="cover-img"
          src={`/covers/${item.coverKey}`}
          alt={`Cover of ${item.title}`}
          loading="lazy"
          data-fallback={MEDIA_ICON[item.mediaType]}
        />
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
        {item.readCount ? <small class="mono muted">read {item.readCount}×</small> : null}
        {!item.inCollection ? <NotOwnedPill /> : null}
      </span>
    </div>
  </a>
);

function renderShare(c: Context<AppEnv>, title: string, shelf: string, body: Child, opts: { bgg?: boolean } = {}) {
  return c.html(`<!doctype html>${ShareLayout({ title, shelf, bgg: opts.bgg, children: body })}`);
}

/**
 * Any share URL that doesn't resolve — unknown or rotated token, an item outside the view, a mistyped path. One
 * fixed page for all of them: no share name, no shelf, no title, so it can't confirm what a link was or held.
 */
export function shareNotFound(c: Context<AppEnv>) {
  c.status(404);
  return renderShare(
    c,
    'Link not found',
    'Link not found',
    <p class="muted">This link has been changed or removed. Ask whoever sent it for a new one.</p>,
  );
}

share.get('/:token', async (c) => {
  const token = c.req.param('token');
  const view = await getShareByToken(c.env.DB, token);
  if (!view) return c.notFound();
  const pageNum = Number.parseInt(c.req.query('page') ?? '1', 10) || 1;
  const { items, total, page: current, pages } = await listItems(c.env.DB, view.libraryId, {
    ...shareFilters(view),
    page: pageNum,
  });
  const publicItems = items.map((i) => toPublicItem(i));

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
    { bgg: publicItems.some(fromBgg) },
  );
});

share.get('/:token/items/:id', async (c) => {
  const token = c.req.param('token');
  const view = await getShareByToken(c.env.DB, token);
  if (!view) return c.notFound();
  // Past a live token, every answer does the same work — the item, its tags, its play count and the settings, all at
  // once — and only then decides. Stopping early on a missing item made "no such item" measurably faster than "an item
  // outside this view", so a link's holder could time which ids exist. A non-numeric id looks up 0, which never does.
  const raw = Number(c.req.param('id'));
  const id = Number.isSafeInteger(raw) && raw > 0 ? raw : 0;
  const [item, tagMap, plays, settings] = await Promise.all([
    getItem(c.env.DB, id),
    tagsForItems(c.env.DB, [id]),
    // counted for every id, played or not, so a hit and a miss still do the same work; the whitelist keeps it for games
    // and records only (§16 #54)
    playCount(c.env.DB, id),
    getSiteSettings(c.env.DB),
  ]);
  const tags = tagMap.get(id) ?? [];
  if (!item || !itemMatchesShare(view, item, tags)) return c.notFound(); // token only unlocks its own view
  // §16 #45: each member's rating and review, by display name, only while an admin has names on for share pages
  // §16 #52: its series name and number are public catalogue data, like the publisher — never the gaps or "next up"
  const [reviews, series] = await Promise.all([
    settings.namesOnShares ? namedReviews(c.env.DB, item.id) : undefined,
    item.seriesId !== null ? getSeries(c.env.DB, item.seriesId) : null,
  ]);
  const pub = toPublicItem(item, { progress: settings.progressOnShares, reviews, plays, series });

  return renderShare(
    c,
    `${pub.title} · ${view.name}`,
    view.name,
    <article class="item-detail">
      <div class="item-detail-cover">
        {pub.coverKey ? (
          <img class="cover-img" src={`/covers/${pub.coverKey}`} alt={`Cover of ${pub.title}`} data-fallback={MEDIA_ICON[pub.mediaType]} />
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
          {pub.series ? (
            <>
              <dt>Series</dt>
              <dd>
                {pub.series.name}
                {pub.series.number !== null ? <span class="mono">#{formatSeriesNumber(pub.series.number)}</span> : null}
              </dd>
            </>
          ) : null}
          {pub.progress ? (
            <>
              <dt>Reading</dt>
              <dd>
                <span class="mono">p. {pub.progress.page}</span>
                {pub.progress.length ? (
                  <>
                    {' of '}
                    <span class="mono">{pub.progress.length}</span>
                  </>
                ) : null}
                {pub.progress.percent !== null ? (
                  <>
                    {' · '}
                    <span class="mono">{pub.progress.percent}%</span>
                    <div class="progress-track" role="img" aria-label={`${pub.progress.percent}% read`}>
                      <div class="progress-fill" style={`width:${pub.progress.percent}%`} />
                    </div>
                  </>
                ) : null}
              </dd>
            </>
          ) : null}
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
          {pub.readCount ? (
            <>
              <dt>Read</dt>
              <dd class="mono">{pub.readCount} times</dd>
            </>
          ) : null}
          {pub.playCount ? (
            <>
              {/* how many times, never when (§16 #54) */}
              <dt>Played</dt>
              <dd class="mono">{timesPlayed(pub.playCount)}</dd>
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
        {pub.reviews?.length ? (
          <div class="detail-section">
            <p class="eyebrow">Ratings and reviews</p>
            <ol class="member-reviews">
              {pub.reviews.map((r) => (
                <li>
                  {/* a display name, or unsigned: never a username */}
                  {/* every entry has a rating or words; each is signed, "A member" for someone without a display
                      name, as a connection's item page labels it */}
                  <p class="review-by">
                    <span class="reviewer">{r.by ?? 'A member'}</span>
                    {r.rating ? <span class="rating">{stars(r.rating)}</span> : null}
                  </p>
                  {r.review ? <p class="prewrap">{r.review}</p> : null}
                </li>
              ))}
            </ol>
          </div>
        ) : pub.review ? (
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
    { bgg: fromBgg(pub) },
  );
});

// Anything else under /share — /share itself, a trailing slash, an extra path segment — is a dead link too. Without
// this it fell past the public routes into the session middleware and answered with a login redirect.
share.all('*', (c) => shareNotFound(c));

export default share;
