// PUBLIC routes — no session. Every field rendered here must come through
// toPublicItem() (src/lib/share.ts). See ARCH.md §9 and CLAUDE.md privacy invariants.
import { Hono, type Context } from 'hono';
import type { Child, FC, PropsWithChildren } from 'hono/jsx';
import {
  getItem,
  getSeries,
  getShareByToken,
  getSiteSettings,
  giftExtras,
  listItems,
  namedReviews,
  playCount,
  shareGuardFacts,
  wantedAmong,
} from '../db/queries';
import type { Item, Share } from '../db/schema';
import type { AppEnv } from '../env';
import { timesPlayed } from '../lib/plays';
import { formatSeriesNumber } from '../lib/series';
import { isRecord } from '../lib/condition';
import {
  isWantListShare,
  itemMatchesShare,
  shareFilters,
  toGiftItem,
  toPublicItem,
  wantListTitle,
  type GiftItem,
  type PublicItem,
} from '../lib/share';
import { BggCredit, fromBgg } from '../views/attribution';
import { BuyLinks, DetailsList, LENGTH_UNIT, MEDIA_ICON, MEDIA_LABEL, NotOwnedPill, Pagination, RecordDetails, stars, WantedPill } from '../views/components';

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

/**
 * `bgg`: the page shows a board game, so BoardGameGeek's logo is owed in the footer (ARCH.md §16 #44). `mark`: what
 * kind of page it is, above its name — a gift list says so (§16 #53).
 */
const ShareLayout: FC<PropsWithChildren<{ title: string; shelf: string; bgg?: boolean; mark?: string }>> = ({
  title,
  shelf,
  bgg,
  mark = 'Nalanda · shared shelf',
  children,
}) => (
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
            <div class="share-mark">{mark}</div>
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
        {item.wanted ? <WantedPill /> : null}
      </span>
    </div>
  </a>
);

function renderShare(c: Context<AppEnv>, title: string, shelf: string, body: Child, opts: { bgg?: boolean; mark?: string } = {}) {
  return c.html(`<!doctype html>${ShareLayout({ title, shelf, bgg: opts.bgg, mark: opts.mark, children: body })}`);
}

// ---------- gift lists: a member's want list, published (ARCH.md §16 #53) ----------

const GIFT_MARK = 'Nalanda · want list';

const GiftCover: FC<{ item: GiftItem }> = ({ item }) =>
  item.coverKey ? (
    <img class="cover-img" src={`/covers/${item.coverKey}`} alt={`Cover of ${item.title}`} loading="lazy" data-fallback={MEDIA_ICON[item.mediaType]} />
  ) : (
    <div class="cover-fallback">{MEDIA_ICON[item.mediaType]}</div>
  );

/** An item already on the household's shelves: a giver can skip it. The derived boolean only — never a count. */
const OnShelvesPill: FC = () => <span class="pill">On the shelves</span>;

const GiftCard: FC<{ item: GiftItem; token: string }> = ({ item, token }) => (
  <li class="want-card">
    <a href={`/share/${token}/items/${item.id}`} class="want-cover" tabindex={-1} aria-hidden="true">
      <GiftCover item={item} />
    </a>
    <div class="want-body">
      <a href={`/share/${token}/items/${item.id}`} class="want-title">
        {item.title}
      </a>
      {item.creators ? <small class="want-creators">{item.creators}</small> : null}
      <span class="mline">
        <small class="muted">{MEDIA_LABEL[item.mediaType]}</small>
        {item.inCollection ? <OnShelvesPill /> : null}
      </span>
      <BuyLinks links={item.purchaseLinks} />
    </div>
  </li>
);

/** A gift list: every item its member wants now, on any shelf, with the household's purchase links, and nothing else. */
async function giftListPage(c: Context<AppEnv>, view: Share & { wantUserId: number }, token: string, pageNum: number) {
  const { items, total, page: current, pages } = await listItems(c.env.DB, view.libraryId, { ...shareFilters(view), page: pageNum });
  // the page's links and the member's public name, in one call
  const { owner, links } = await giftExtras(
    c.env.DB,
    view.wantUserId,
    items.map((i) => i.id),
  );
  const gifts = items.map((i) => toGiftItem(i, links.get(i.id) ?? []));
  const title = wantListTitle(owner);
  return renderShare(
    c,
    title,
    title,
    <>
      <p class="eyebrow">
        {total} {total === 1 ? 'item' : 'items'}
      </p>
      {gifts.length ? (
        <ol class="want-list">
          {gifts.map((g) => (
            <GiftCard item={g} token={token} />
          ))}
        </ol>
      ) : (
        <p class="muted">Nothing on this list right now.</p>
      )}
      <Pagination page={current} pages={pages} makeHref={(p) => `/share/${token}?page=${p}`} />
    </>,
    { bgg: gifts.some(fromBgg), mark: GIFT_MARK },
  );
}

/** One item on a gift list: what finding the right one takes, and where to buy it. */
async function giftItemPage(c: Context<AppEnv>, view: Share & { wantUserId: number }, token: string, item: Item) {
  const { owner, links } = await giftExtras(c.env.DB, view.wantUserId, [item.id]);
  const gift = toGiftItem(item, links.get(item.id) ?? []);
  const title = wantListTitle(owner);
  return renderShare(
    c,
    `${gift.title} · ${title}`,
    title,
    <article class="item-detail">
      <div class="item-detail-cover">
        <GiftCover item={gift} />
      </div>
      <div class="item-detail-body">
        <hgroup>
          <h1>{gift.title}</h1>
          {gift.creators ? <p>{gift.creators}</p> : null}
        </hgroup>
        <dl class="props">
          <dt>Type</dt>
          <dd>{MEDIA_LABEL[gift.mediaType]}</dd>
          {gift.inCollection ? (
            <>
              <dt>Holding</dt>
              <dd>
                <OnShelvesPill /> already on these shelves
              </dd>
            </>
          ) : null}
          {gift.published ? (
            <>
              <dt>Published</dt>
              <dd>{gift.published}</dd>
            </>
          ) : null}
          {gift.publisher ? (
            <>
              <dt>Publisher</dt>
              <dd>{gift.publisher}</dd>
            </>
          ) : null}
          {gift.length ? (
            <>
              <dt>Length</dt>
              <dd class="mono">
                {gift.length} {LENGTH_UNIT[gift.mediaType] ?? ''}
              </dd>
            </>
          ) : null}
        </dl>
        {gift.description ? <p class="prewrap">{gift.description}</p> : null}
        {gift.purchaseLinks.length ? (
          <div class="detail-section">
            <p class="eyebrow">Where to buy</p>
            <BuyLinks links={gift.purchaseLinks} />
          </div>
        ) : null}
        <p class="back-link">
          <a href={`/share/${token}`}>← back to {title}</a>
        </p>
      </div>
    </article>,
    { bgg: fromBgg(gift), mark: GIFT_MARK },
  );
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
  if (isWantListShare(view)) return giftListPage(c, view, token, pageNum);
  const { items, total, page: current, pages } = await listItems(c.env.DB, view.libraryId, {
    ...shareFilters(view),
    page: pageNum,
  });
  // §16 #53: the "Wanted" badge — someone here wants it and it isn't owned; a boolean, never whose
  const wanted = await wantedAmong(
    c.env.DB,
    items.filter((i) => i.copies === 0).map((i) => i.id),
  );
  const publicItems = items.map((i) => toPublicItem(i, { wanted: wanted.has(i.id) }));

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
  // Members' reviews are fetched here too, whatever the switch says, so a hit does no more work than a miss with names
  // on — the default for a new instance since §16 #49 — and are used only once the item is known to be in the view.
  // Its tags and who wants it (a gift list's guard, §16 #53) come in one call, for every id alike.
  const [item, { tags, wanters }, plays, settings, named] = await Promise.all([
    getItem(c.env.DB, id),
    shareGuardFacts(c.env.DB, id),
    // counted for every id, played or not, so a hit and a miss still do the same work; the whitelist keeps it for games
    // and records only (§16 #54)
    playCount(c.env.DB, id),
    getSiteSettings(c.env.DB),
    namedReviews(c.env.DB, id),
  ]);
  if (!item || !itemMatchesShare(view, item, tags, wanters)) return c.notFound(); // token only unlocks its own view
  if (isWantListShare(view)) return giftItemPage(c, view, token, item);
  // §16 #45: each member's rating and review, by display name, only while an admin has names on for share pages
  // §16 #52: its series name and number are public catalogue data, like the publisher — never the gaps or "next up"
  const series = item.seriesId !== null ? await getSeries(c.env.DB, item.seriesId) : null;
  const reviews = settings.namesOnShares ? named : undefined;
  // §16 #53: the "Wanted" badge, from the wanters the guard already read — a boolean, never whose
  const pub = toPublicItem(item, { progress: settings.progressOnShares, reviews, plays, series, wanted: wanters.length > 0 });

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
                    <div class="progress-track" aria-hidden="true">
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
                <NotOwnedPill />
                {/* No status on share pages, so no claim it was read: a Goodreads to-read entry is Not owned too.
                    Wanted, it's on its way — or hoped to be (§16 #53). */}
                {pub.wanted ? (
                  <>
                    <WantedPill /> wanted, not on these shelves yet
                  </>
                ) : (
                  ' in the catalogue, not on these shelves'
                )}
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
              <dd class="mono">
                {pub.length} {LENGTH_UNIT[pub.mediaType] ?? ''}
              </dd>
            </>
          ) : null}
        </dl>
        {pub.description ? <p class="prewrap">{pub.description}</p> : null}
        {/* a record's pressing and tracklist are public catalogue data (§9, §16 #55); its grades are not, and
            toPublicItem() never carries them */}
        {isRecord(pub.mediaType) ? (
          <RecordDetails details={pub.details} publicPage />
        ) : Object.keys(pub.details).length ? (
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
        <p class="back-link">
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
