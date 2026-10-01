// PUBLIC routes — no session. Every field rendered here must come through
// toPublicItem() (src/lib/share.ts). See ARCH.md §9 and CLAUDE.md privacy invariants.
import { Hono, type Context } from 'hono';
import type { Child, FC, PropsWithChildren } from 'hono/jsx';
import {
  getItem,
  getSeries,
  shareWithLocale,
  getSiteSettings,
  giftExtras,
  listItems,
  namedReviews,
  playCount,
  shareGuardFacts,
  wantedAmong,
  feedItems,
  wantFeedItems,
} from '../db/queries';
import type { Item, Share } from '../db/schema';
import type { AppEnv } from '../env';
import { atomFeed, entryHtml, FEED_ENTRIES, rfc3339, rssFeed, type FeedEntry } from '../lib/feeds';
import { formatSeriesNumber } from '../lib/series';
import { isRecord } from '../lib/condition';
import {
  isWantListShare,
  itemMatchesShare,
  shareFilters,
  toGiftItem,
  toPublicItem,
  previewText,
  type GiftItem,
  type LinkPreview,
  type PublicItem,
} from '../lib/share';
import { BggCredit, fromBgg } from '../views/attribution';
import { languageName } from '../lib/language';
import { BuyLinks, CustomProps, DetailsList, FormatPills, MEDIA_ICON, NotOwnedPill, Pagination, RecordDetails, stars, WantedPill } from '../views/components';
import { I18n, lengthUnit, mediaLabel, useI18n } from '../views/i18n';
import { i18nOf } from '../views/layout';
import { resolveLocale, translator, type Translator } from '../i18n';

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

/** The listing's page number from its query string — the one query parameter any share route reads. */
const pageOf = (c: Context<AppEnv>) => Number.parseInt(c.req.query('page') ?? '1', 10) || 1;

/** A listing: `/share/<token>` alone — the item pages and feeds hang below it, and none of them reads a query. */
const LISTING = /^\/share\/[^/]+\/?$/;

/**
 * The link's row, and the page's language with it (§16 #93): the household's, with its own translation, read in the
 * same call as the token and kept on the context, so renderShare() and the feed pay nothing more for it.
 */
async function shareFor(c: Context<AppEnv>, token: string): Promise<Share | null> {
  const { share, language, translation } = await shareWithLocale(c.env.DB, token);
  c.set('i18n', translator(resolveLocale(null, { language }), translation));
  return share;
}

/**
 * The cache key: the canonical path — with the host, since feeds and link previews write absolute URLs — plus the
 * page number on a listing, and nothing else. The routes read no other query parameter, so `?junk=1` is the same
 * page, not a slot of its own: keyed by the whole URL, two hundred variants of one token's address evicted every
 * real page in the isolate.
 */
function cacheKey(c: Context<AppEnv>): string {
  const url = new URL(c.req.url);
  return LISTING.test(url.pathname) ? `${url.origin}${url.pathname}?page=${pageOf(c)}` : `${url.origin}${url.pathname}`;
}

share.use('*', async (c, next) => {
  // search engines never index a share page or its feeds: the header says so where a feed has no <head> for the meta
  c.header('X-Robots-Tag', 'noindex');
  if (c.req.method !== 'GET') return next();
  const key = cacheKey(c);
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
 * kind of page it is, above its name — a gift list says so (§16 #53). The page is in the household's language (§16
 * #93): its own few strings translated, the item's data as it is, never a member's choice.
 */
const ShareLayout: FC<PropsWithChildren<{ title: string; shelf: string; bgg?: boolean; mark?: string; preview?: LinkPreview; feeds?: string }>> = ({
  title,
  shelf,
  bgg,
  mark,
  preview,
  feeds,
  children,
}) => {
  const i18n = useI18n();
  const { t } = i18n;
  return (
  <html lang={i18n.locale}>
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <meta name="robots" content="noindex" />
      <meta name="theme-color" content="#f6f2e7" media="(prefers-color-scheme: light)" />
      <meta name="theme-color" content="#171310" media="(prefers-color-scheme: dark)" />
      <title>{title}</title>
      {/* the link preview a chat app draws (§16 #71): what the page shows, nothing more; noindex above still holds */}
      {preview ? (
        <>
          <meta property="og:type" content="website" />
          <meta property="og:site_name" content="Nalanda" />
          <meta property="og:title" content={preview.title} />
          <meta property="og:description" content={preview.description} />
          <meta property="og:url" content={preview.url} />
          {preview.image ? <meta property="og:image" content={preview.image} /> : null}
          {preview.image && preview.imageAlt ? <meta property="og:image:alt" content={t('cover.alt', { title: preview.imageAlt })} /> : null}
          <meta name="twitter:card" content="summary" />
        </>
      ) : null}
      <link rel="icon" href="/logo.svg" type="image/svg+xml" />
      {/* the listing's feeds (§16 #86), for a reader to find */}
      {feeds ? (
        <>
          <link rel="alternate" type="application/atom+xml" title={`${title} — Atom`} href={`${feeds}/feed.atom`} />
          <link rel="alternate" type="application/rss+xml" title={`${title} — RSS`} href={`${feeds}/feed.rss`} />
        </>
      ) : null}
      <link rel="stylesheet" href="/app.css" />
      {/* a cover that fails to load falls back to its media icon */}
      <script src="/covers.js" defer></script>
    </head>
    <body>
      <main class="share-shell">
        <div class="share-head">
          <div>
            <div class="brand-rule"></div>
            <div class="share-mark">{mark ?? t('share.mark')}</div>
            <h1>{shelf}</h1>
          </div>
        </div>
        {children}
        <footer class="share-footer">
          <span>
            {t('share.footer')} ·{' '}
            <span lang="sa">नालन्दा</span>
          </span>
          {bgg ? <BggCredit /> : null}
        </footer>
      </main>
    </body>
  </html>
  );
};

const PublicCard: FC<{ item: PublicItem; token: string }> = ({ item, token }) => {
  const i18n = useI18n();
  const { t } = i18n;
  return (
  <a href={`/share/${token}/items/${item.id}`} class="item-card">
    <div class="item-cover">
      {item.coverKey ? (
        <img
          class="cover-img"
          src={`/covers/${item.coverKey}`}
          alt={t('cover.alt', { title: item.title })}
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
        <small class="muted">{mediaLabel(i18n, item.mediaType)}</small>
        {item.rating ? <span class="rating">{stars(item.rating)}</span> : null}
        {item.readCount ? <small class="mono muted">{t('share.read_times_short', { count: item.readCount })}</small> : null}
        {!item.inCollection ? <NotOwnedPill /> : null}
        {item.wanted ? <WantedPill /> : null}
      </span>
    </div>
  </a>
  );
};

/** The page in the household's language (§16 #93): the whole tree renders inside its translator, as app pages do. */
async function renderShare(
  c: Context<AppEnv>,
  title: string,
  shelf: string,
  body: Child,
  opts: { bgg?: boolean; mark?: string; preview?: LinkPreview; feeds?: string } = {},
) {
  const i18n = await i18nOf(c);
  return c.html(
    `<!doctype html>${(
      <I18n.Provider value={i18n}>
        <ShareLayout title={title} shelf={shelf} bgg={opts.bgg} mark={opts.mark} preview={opts.preview} feeds={opts.feeds}>
          {body}
        </ShareLayout>
      </I18n.Provider>
    )}`,
  );
}

// ---------- link previews (ARCH.md §16 #71) ----------

/** An absolute URL on this instance, as a preview needs: a chat app fetches it from elsewhere. */
const absolute = (c: Context<AppEnv>, path: string) => new URL(path, c.req.url).toString();

/** The first cover a listing shows, as the preview's picture, and whose it is; none when no item on the page has one. */
function firstCover(c: Context<AppEnv>, items: Array<{ coverKey: string | null; title: string }>): Pick<LinkPreview, 'image' | 'imageAlt'> {
  const first = items.find((i) => i.coverKey);
  return first?.coverKey ? { image: absolute(c, `/covers/${first.coverKey}`), imageAlt: first.title } : { image: null, imageAlt: null };
}

/** "12 items · a shared shelf from a Nalanda home library": the count the page's eyebrow shows, and what kind of page. */
const countLine = (i18n: Translator, total: number, kind: 'shelf' | 'tag' | 'want') =>
  i18n.t(`share.preview_${kind}`, { items: i18n.n('share.items', total) });

/** An item page's line: its creators and type, which page it's on, and the start of its description. */
function itemLine(i18n: Translator, item: { creators: string | null; mediaType: PublicItem['mediaType']; description: string | null }, on: string): string {
  const head = [item.creators, mediaLabel(i18n, item.mediaType), i18n.t('share.on_page', { name: on })].filter(Boolean).join(' · ');
  const more = previewText(item.description, 140);
  return more ? `${head} — ${more}` : head;
}

/** A gift list's title (§16 #53): its member's display name — only while names are on, as giftExtras() gives it — or none. */
const wantTitle = (i18n: Translator, owner: string | null) => (owner ? i18n.t('share.someones_want_list', { name: owner }) : i18n.t('share.want_list'));

// ---------- gift lists: a member's want list, published (ARCH.md §16 #53) ----------

/** A tag's link spans every shelf, so its pages don't call themselves a shelf. */
const shareMark = (i18n: Translator, view: Share) => (view.tag !== null ? i18n.t('share.mark_tag') : undefined);

const GiftCover: FC<{ item: GiftItem }> = ({ item }) =>
  item.coverKey ? (
    <img class="cover-img" src={`/covers/${item.coverKey}`} alt={useI18n().t('cover.alt', { title: item.title })} loading="lazy" data-fallback={MEDIA_ICON[item.mediaType]} />
  ) : (
    <div class="cover-fallback">{MEDIA_ICON[item.mediaType]}</div>
  );

/** An item already on the household's shelves: a giver can skip it. The derived boolean only — never a count. */
const OnShelvesPill: FC = () => <span class="pill">{useI18n().t('share.on_shelves')}</span>;

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
        <small class="muted">{mediaLabel(useI18n(), item.mediaType)}</small>
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
  const i18n = await i18nOf(c);
  const { t, n } = i18n;
  const gifts = items.map((i) => toGiftItem(i, links.get(i.id) ?? []));
  const title = wantTitle(i18n, owner);
  const preview: LinkPreview = {
    title,
    description: countLine(i18n, total, 'want'),
    ...firstCover(c, gifts),
    url: absolute(c, `/share/${token}`),
  };
  return renderShare(
    c,
    title,
    title,
    <>
      <p class="eyebrow">{n('share.items', total)}</p>
      {gifts.length ? (
        <ol class="want-list">
          {gifts.map((g) => (
            <GiftCard item={g} token={token} />
          ))}
        </ol>
      ) : (
        <p class="muted">{t('share.nothing_on_list')}</p>
      )}
      <Pagination page={current} pages={pages} makeHref={(p) => `/share/${token}?page=${p}`} />
    </>,
    { bgg: gifts.some(fromBgg), mark: t('share.mark_want'), preview, feeds: `/share/${token}` },
  );
}

/** One item on a gift list: what finding the right one takes, and where to buy it. */
async function giftItemPage(c: Context<AppEnv>, view: Share & { wantUserId: number }, token: string, item: Item) {
  const { owner, links } = await giftExtras(c.env.DB, view.wantUserId, [item.id]);
  const i18n = await i18nOf(c);
  const { t } = i18n;
  const gift = toGiftItem(item, links.get(item.id) ?? []);
  const title = wantTitle(i18n, owner);
  const preview: LinkPreview = {
    title: gift.title,
    description: itemLine(i18n, gift, title),
    image: gift.coverKey ? absolute(c, `/covers/${gift.coverKey}`) : null,
    imageAlt: gift.coverKey ? gift.title : null,
    url: absolute(c, `/share/${token}/items/${gift.id}`),
  };
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
          {gift.originalTitle ? <p class="original-title muted">{gift.originalTitle}</p> : null}
          {gift.creators ? <p>{gift.creators}</p> : null}
        </hgroup>
        <dl class="props">
          <dt>{t('item.type')}</dt>
          <dd>
            {mediaLabel(i18n, gift.mediaType)} <FormatPills formats={gift.formats} />
          </dd>
          {gift.language ? (
            <>
              <dt>{t('item.language')}</dt>
              <dd>{languageName(gift.language)}</dd>
            </>
          ) : null}
          {gift.inCollection ? (
            <>
              <dt>{t('item.holding')}</dt>
              <dd>
                <OnShelvesPill /> {t('share.already_on_shelves')}
              </dd>
            </>
          ) : null}
          {gift.published ? (
            <>
              <dt>{t('item.published')}</dt>
              <dd>{gift.published}</dd>
            </>
          ) : null}
          {gift.publisher ? (
            <>
              <dt>{t('item.publisher')}</dt>
              <dd>{gift.publisher}</dd>
            </>
          ) : null}
          {gift.length ? (
            <>
              <dt>{t('item.length')}</dt>
              <dd class="mono">
                {gift.length} {lengthUnit(i18n, gift.mediaType)}
              </dd>
            </>
          ) : null}
        </dl>
        {gift.description ? <p class="prewrap">{gift.description}</p> : null}
        {gift.purchaseLinks.length ? (
          <div class="detail-section">
            <p class="eyebrow">{t('share.where_to_buy')}</p>
            <BuyLinks links={gift.purchaseLinks} />
          </div>
        ) : null}
        <p class="back-link">
          <a href={`/share/${token}`}>{t('share.back_to', { name: title })}</a>
        </p>
      </div>
    </article>,
    { bgg: fromBgg(gift), mark: t('share.mark_want'), preview },
  );
}

/**
 * Any share URL that doesn't resolve — unknown or rotated token, an item outside the view, a mistyped path. One
 * fixed page for all of them: no share name, no shelf, no title, so it can't confirm what a link was or held.
 */
export async function shareNotFound(c: Context<AppEnv>) {
  c.status(404);
  const { t } = await i18nOf(c);
  return renderShare(c, t('share.not_found'), t('share.not_found'), <p class="muted">{t('share.not_found_text')}</p>);
}

share.get('/:token', async (c) => {
  const token = c.req.param('token');
  const view = await shareFor(c, token);
  if (!view) return c.notFound();
  const pageNum = pageOf(c);
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
  const i18n = await i18nOf(c);
  const publicItems = items.map((i) => toPublicItem(i, { wanted: wanted.has(i.id) }));
  const preview: LinkPreview = {
    title: view.name,
    description: countLine(i18n, total, view.tag !== null ? 'tag' : 'shelf'),
    ...firstCover(c, publicItems),
    url: absolute(c, `/share/${token}`),
  };

  return renderShare(
    c,
    view.name,
    view.name,
    <>
      <p class="eyebrow">{i18n.n('share.items', total)}</p>
      <div class="item-grid">
        {publicItems.map((item) => (
          <PublicCard item={item} token={token} />
        ))}
      </div>
      <Pagination page={current} pages={pages} makeHref={(p) => `/share/${token}?page=${p}`} />
    </>,
    { bgg: publicItems.some(fromBgg), mark: shareMark(i18n, view), preview, feeds: `/share/${token}` },
  );
});

/**
 * The link's feed (ARCH.md §16 #86), Atom or RSS: the newest additions among the items it exposes — for a gift list,
 * the newest wants — as the page shows them (toPublicItem, toGiftItem), each dated by when it was added or wanted,
 * never by a read. Cached with the pages (the middleware above), and gone with the token.
 */
async function feed(c: Context<AppEnv>, token: string, kind: 'atom' | 'rss') {
  const view = await shareFor(c, token);
  if (!view) return c.notFound();
  const gift = isWantListShare(view);
  const found = gift
    ? await wantFeedItems(c.env.DB, view.wantUserId, shareFilters(view), FEED_ENTRIES)
    : await feedItems(c.env.DB, view.libraryId, shareFilters(view), FEED_ENTRIES);
  const wanted = gift ? new Set<number>() : await wantedAmong(c.env.DB, found.filter((x) => x.item.copies === 0).map((x) => x.item.id));
  const i18n = await i18nOf(c); // the feed's own words in the household's language too (§16 #93)
  const title = gift ? wantTitle(i18n, (await giftExtras(c.env.DB, view.wantUserId, [])).owner) : view.name;
  // what a feed dates by (§16 #86): a shelf's entry by the day — never the time — its item was added; a gift list's
  // entries all by the day of the newest want, so one member's wanting is never dated item by item
  const newest = found[0]?.at;
  const entries: FeedEntry[] = found.map(({ item, at }) => {
    const pub = gift ? toGiftItem(item, []) : toPublicItem(item, { wanted: wanted.has(item.id) });
    const link = absolute(c, `/share/${token}/items/${pub.id}`);
    const image = pub.coverKey ? absolute(c, `/covers/${pub.coverKey}`) : null;
    const rating = 'rating' in pub ? pub.rating : null;
    const review = 'review' in pub ? pub.review : null;
    const summary = [pub.creators, rating !== null ? i18n.t('feed.rated', { rating }) : null].filter(Boolean).join(' · ');
    const updated = rfc3339(gift ? (newest ?? at) : at);
    return { id: link, title: pub.title, link, updated, summary, html: entryHtml({ image, title: pub.title, creators: pub.creators, rating, review }), image };
  });
  const meta = {
    title,
    link: absolute(c, `/share/${token}`),
    self: absolute(c, `/share/${token}/feed.${kind}`),
    updated: entries[0]?.updated ?? rfc3339(view.createdAt),
    description: gift ? i18n.t('feed.want_shared') : i18n.t('feed.shared'),
  };
  return c.body(kind === 'atom' ? atomFeed(meta, entries) : rssFeed(meta, entries), 200, {
    'content-type': kind === 'atom' ? 'application/atom+xml; charset=utf-8' : 'application/rss+xml; charset=utf-8',
  });
}

share.get('/:token/feed.atom', (c) => feed(c, c.req.param('token'), 'atom'));
share.get('/:token/feed.rss', (c) => feed(c, c.req.param('token'), 'rss'));

share.get('/:token/items/:id', async (c) => {
  const token = c.req.param('token');
  const view = await shareFor(c, token);
  if (!view) return c.notFound();
  // Past a live token, every answer does the same work — the item, its tags, its play count and the settings, all at
  // once — and only then decides. Stopping early on a missing item made "no such item" measurably faster than "an item
  // outside this view", so a link's holder could time which ids exist. A non-numeric id looks up 0, which never does.
  const raw = Number(c.req.param('id'));
  const id = Number.isSafeInteger(raw) && raw > 0 ? raw : 0;
  // Members' reviews are fetched here too, whatever the switch says, so a hit does no more work than a miss with names
  // on — the default for a new instance since §16 #49 — and are used only once the item is known to be in the view.
  // Its tags and who wants it (a gift list's guard, §16 #53) come in one call, for every id alike.
  // its tags, who wants it, and its shared quotes (§16 #77) come in one call, for every id alike
  const [item, { tags, wanters, quotes: shared, fields }, plays, settings, named] = await Promise.all([
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
  const i18n = await i18nOf(c);
  const { t } = i18n;
  // §16 #45: each member's rating and review, by display name, only while an admin has names on for share pages
  // §16 #52: its series name and number are public catalogue data, like the publisher — never the gaps or "next up"
  const series = item.seriesId !== null ? await getSeries(c.env.DB, item.seriesId) : null;
  const reviews = settings.namesOnShares ? named : undefined;
  // §16 #53: the "Wanted" badge, from the wanters the guard already read — a boolean, never whose
  // §16 #77: a shared quote is shown whatever the names switch says; its writer's name only while names are on
  const quotes = shared.map((q) => (settings.namesOnShares ? q : { ...q, by: null }));
  // §16 #95: the custom fields switched on for share pages, by name — the whitelist keeps the others back
  const pub = toPublicItem(item, { progress: settings.progressOnShares, reviews, plays, series, wanted: wanters.length > 0, quotes, customFields: fields });
  const preview: LinkPreview = {
    title: pub.title,
    description: itemLine(i18n, pub, view.name),
    image: pub.coverKey ? absolute(c, `/covers/${pub.coverKey}`) : null,
    imageAlt: pub.coverKey ? pub.title : null,
    url: absolute(c, `/share/${token}/items/${pub.id}`),
  };

  return renderShare(
    c,
    `${pub.title} · ${view.name}`,
    view.name,
    <article class="item-detail">
      <div class="item-detail-cover">
        {pub.coverKey ? (
          <img class="cover-img" src={`/covers/${pub.coverKey}`} alt={t('cover.alt', { title: pub.title })} data-fallback={MEDIA_ICON[pub.mediaType]} />
        ) : (
          <div class="cover-fallback">{MEDIA_ICON[pub.mediaType]}</div>
        )}
      </div>
      <div class="item-detail-body">
        <hgroup>
          <h1>{pub.title}</h1>
          {pub.originalTitle ? <p class="original-title muted">{pub.originalTitle}</p> : null}
          {pub.creators ? <p>{pub.creators}</p> : null}
        </hgroup>
        {tags.length ? (
          <p>
            {tags.map((tag) => (
              <span class="tag">{tag}</span>
            ))}
          </p>
        ) : null}
        <dl class="props">
          <dt>{t('item.type')}</dt>
          <dd>
            {mediaLabel(i18n, pub.mediaType)} <FormatPills formats={pub.formats} />
          </dd>
          {pub.language ? (
            <>
              <dt>{t('item.language')}</dt>
              <dd>{languageName(pub.language)}</dd>
            </>
          ) : null}
          {pub.series ? (
            <>
              <dt>{t('item.series')}</dt>
              <dd>
                {pub.series.name}
                {pub.series.number !== null ? <span class="mono">#{formatSeriesNumber(pub.series.number)}</span> : null}
              </dd>
            </>
          ) : null}
          {pub.progress ? (
            <>
              <dt>{t('share.reading')}</dt>
              <dd>
                <span class="mono">{t('share.page', { page: pub.progress.page })}</span>
                {pub.progress.length ? (
                  <>
                    {` ${t('share.of')} `}
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
              <dt>{t('item.holding')}</dt>
              <dd>
                <NotOwnedPill />
                {/* No status on share pages, so no claim it was read: a Goodreads to-read entry is Not owned too.
                    Wanted, it's on its way — or hoped to be (§16 #53). */}
                {pub.wanted ? (
                  <>
                    <WantedPill /> {t('share.wanted_not_here')}
                  </>
                ) : (
                  ` ${t('share.in_catalogue')}`
                )}
              </dd>
            </>
          ) : null}
          {pub.rating ? (
            <>
              <dt>{t('item.rating')}</dt>
              <dd>
                <span class="rating">{stars(pub.rating)}</span>
              </dd>
            </>
          ) : null}
          {pub.readCount ? (
            <>
              <dt>{t('share.read')}</dt>
              <dd class="mono">{t('share.read_times', { count: pub.readCount })}</dd>
            </>
          ) : null}
          {pub.playCount ? (
            <>
              {/* how many times, never when (§16 #54) */}
              <dt>{t('share.played')}</dt>
              <dd class="mono">{pub.playCount === 1 ? t('share.played_once') : t('share.played_times', { count: pub.playCount })}</dd>
            </>
          ) : null}
          {pub.published ? (
            <>
              <dt>{t('item.published')}</dt>
              <dd>{pub.published}</dd>
            </>
          ) : null}
          {pub.publisher ? (
            <>
              <dt>{t('item.publisher')}</dt>
              <dd>{pub.publisher}</dd>
            </>
          ) : null}
          {pub.length ? (
            <>
              <dt>{t('item.length')}</dt>
              <dd class="mono">
                {pub.length} {lengthUnit(i18n, pub.mediaType)}
              </dd>
            </>
          ) : null}
        </dl>
        {/* the custom fields an admin switched on for share pages (§16 #95), by name; the rest never reach here */}
        <CustomProps entries={pub.custom ?? []} />
        {pub.description ? <p class="prewrap">{pub.description}</p> : null}
        {/* a record's pressing and tracklist are public catalogue data (§9, §16 #55); its grades are not, and
            toPublicItem() never carries them */}
        {isRecord(pub.mediaType) ? (
          <RecordDetails details={pub.details} publicPage />
        ) : Object.keys(pub.details).length ? (
          <div class="detail-section">
            <p class="eyebrow">{t('share.details')}</p>
            <DetailsList details={pub.details} />
          </div>
        ) : null}
        {pub.reviews?.length ? (
          <div class="detail-section">
            <p class="eyebrow">{t('share.ratings_reviews')}</p>
            <ol class="member-reviews">
              {pub.reviews.map((r) => (
                <li>
                  {/* a display name, or unsigned: never a username */}
                  {/* every entry has a rating or words; each is signed, "A member" for someone without a display
                      name, as a connection's item page labels it */}
                  <p class="review-by">
                    <span class="reviewer">{r.by ?? t('share.a_member')}</span>
                    {r.rating ? <span class="rating">{stars(r.rating)}</span> : null}
                  </p>
                  {r.review ? <p class="prewrap">{r.review}</p> : null}
                </li>
              ))}
            </ol>
          </div>
        ) : pub.review ? (
          <div class="detail-section">
            <p class="eyebrow">{t('share.review')}</p>
            <p class="prewrap">{pub.review}</p>
          </div>
        ) : null}
        {pub.quotes?.length ? (
          <div class="detail-section">
            <p class="eyebrow">{t('share.quotes')}</p>
            <ol class="quotes">
              {pub.quotes.map((q) => (
                <li class="quote">
                  <blockquote class="quote-text prewrap">{q.text}</blockquote>
                  <p class="quote-by">
                    {/* a display name, or unsigned: never a username, never the reader's own note */}
                    <span class="reviewer">{q.by ?? t('share.a_member')}</span>
                    {q.page ? <span class="mono muted">{q.page}</span> : null}
                  </p>
                </li>
              ))}
            </ol>
          </div>
        ) : null}
        <p class="back-link">
          <a href={`/share/${token}`}>{t('share.back_to', { name: view.name })}</a>
        </p>
      </div>
    </article>,
    { bgg: fromBgg(pub), mark: shareMark(i18n, view), preview },
  );
});

// Anything else under /share — /share itself, a trailing slash, an extra path segment — is a dead link too. Without
// this it fell past the public routes into the session middleware and answered with a login redirect.
share.all('*', (c) => shareNotFound(c));

export default share;
