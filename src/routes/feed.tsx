// The Feed page (docs/proposals/connections.md §8): what connected households have been reading, from
// the views this household follows. Stored entries render straight away; subscriptions past their
// pull interval refresh after the response, so the page never waits on another instance.
//
// Everything shown here came from another instance. It is re-validated as it is read back, rendered
// only as escaped text, and covers load only from the connection's own /covers/<uuid>.
import { Hono } from 'hono';
import type { FC } from 'hono/jsx';
import { countSubscriptions, feedEntries, getFederationSettings, takeRemovedCount, type StoredEntry } from '../db/federation';
import type { ActivityKind } from '../db/schema';
import type { AppEnv } from '../env';
import { refreshDue } from '../federation/feed';
import { coverUrl, parseFeedItem, type FeedItem } from '../federation/items';
import { loadIdentity } from '../federation/keys';
import { MEDIA_ICON, stars } from '../views/components';
import { page } from '../views/layout';

const feed = new Hono<AppEnv>();

const ENTRIES_SHOWN = 300;
/** Cards from one household this close together read as one burst — an import, say. */
const BURST_GAP_MINUTES = 60;
const BURST_MIN_CARDS = 6;

type Card = {
  connectionId: number;
  householdName: string;
  baseUrl: string;
  item: FeedItem;
  kinds: Set<ActivityKind>;
  published: string;
};

/** One card per book per household, newest first: "finished and reviewed" rather than two cards. */
function toCards(entries: StoredEntry[]): Card[] {
  const cards = new Map<string, Card>();
  for (const e of entries) {
    let item: FeedItem | null;
    try {
      item = parseFeedItem(JSON.parse(e.item));
    } catch {
      item = null;
    }
    if (!item) continue;
    const cardKey = `${e.connectionId}:${item.id}`;
    const existing = cards.get(cardKey);
    if (existing) {
      existing.kinds.add(e.kind);
      continue;
    }
    cards.set(cardKey, {
      connectionId: e.connectionId,
      householdName: e.householdName,
      baseUrl: e.baseUrl,
      item,
      kinds: new Set([e.kind]),
      published: e.publishedAt,
    });
  }
  return [...cards.values()];
}

const minutes = (sqlDatetime: string) => Date.parse(`${sqlDatetime.replace(' ', 'T')}Z`) / 60_000;

/** Consecutive cards from the same household, each within BURST_GAP_MINUTES of the one before. */
function runs(cards: Card[]): Card[][] {
  const out: Card[][] = [];
  for (const card of cards) {
    const run = out[out.length - 1];
    const prev = run?.[run.length - 1];
    if (run && prev && prev.connectionId === card.connectionId && minutes(prev.published) - minutes(card.published) <= BURST_GAP_MINUTES) {
      run.push(card);
    } else {
      out.push([card]);
    }
  }
  return out;
}

const VERB_ORDER: ActivityKind[] = ['finished', 'rated', 'reviewed'];

function verbs(kinds: Set<ActivityKind>): string {
  const list = VERB_ORDER.filter((k) => kinds.has(k));
  return list.length > 1 ? `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}` : (list[0] ?? '');
}

const FeedCard: FC<{ card: Card; showHousehold: boolean }> = ({ card, showHousehold }) => {
  const { item } = card;
  const cover = coverUrl(card.baseUrl, item.coverKey);
  return (
    <article class="feed-card">
      <div class="feed-cover">
        {cover ? (
          <img class="cover-img" src={cover} alt={`Cover of ${item.title}`} loading="lazy" referrerpolicy="no-referrer" />
        ) : (
          <div class="cover-fallback" aria-hidden="true">
            {MEDIA_ICON[item.mediaType]}
          </div>
        )}
      </div>
      <div class="feed-body">
        <p class="eyebrow">
          {showHousehold ? `${card.householdName} · ` : ''}
          {card.published.slice(0, 10)}
        </p>
        <p class="feed-line">
          <span class="muted">{verbs(card.kinds)}</span> <strong>{item.title}</strong>
          {item.creators ? <small> · {item.creators}</small> : null}
        </p>
        {item.rating && card.kinds.has('rated') ? <span class="rating">{stars(item.rating)}</span> : null}
        {item.review && card.kinds.has('reviewed') ? (
          <p class="prewrap feed-review">
            {item.review}
            {item.reviewTruncated ? '…' : ''}
          </p>
        ) : null}
      </div>
    </article>
  );
};

feed.get('/feed', async (c) => {
  const identity = await loadIdentity(c.env.FEDERATION_PRIVATE_KEY);
  if (!identity) return c.notFound();
  const user = c.get('user');
  const settings = await getFederationSettings(c.env.DB);
  const [entries, subscriptions, removed] = settings
    ? await Promise.all([feedEntries(c.env.DB, ENTRIES_SHOWN), countSubscriptions(c.env.DB), takeRemovedCount(c.env.DB)])
    : [[], 0, 0];
  if (settings && subscriptions > 0) {
    c.executionCtx.waitUntil(refreshDue(c.env.DB, identity, settings).catch((err) => console.error('feed refresh failed', err)));
  }
  const groups = runs(toCards(entries));

  return page(
    c,
    'Feed',
    <>
      <div class="page-head">
        <div>
          <h1>Feed</h1>
          <span class="sub">FROM THE HOUSEHOLDS YOU FOLLOW</span>
        </div>
      </div>
      {removed > 0 ? (
        <article class="notice">
          {removed === 1 ? '1 entry was' : `${removed} entries were`} removed because the households that shared them no
          longer do.
        </article>
      ) : null}
      {!settings ? (
        <p class="muted">
          Connections aren’t set up on this library yet.
          {user.role === 'admin' ? (
            <>
              {' '}
              Start on the <a href="/connections">Connections</a> page.
            </>
          ) : null}
        </p>
      ) : subscriptions === 0 ? (
        <p class="muted">
          {user.role === 'admin' ? (
            <>
              You don’t follow anything yet. On <a href="/connections">Connections</a>, choose <strong>Feed</strong> next to a
              connected household to see the views they share.
            </>
          ) : (
            'Nothing is followed yet. An admin can follow the views connected households share, from the Connections page.'
          )}
        </p>
      ) : groups.length === 0 ? (
        <p class="muted">
          Nothing yet. New activity is fetched in the background whenever this page opens — check back in a moment.
        </p>
      ) : (
        <div class="feed">
          {groups.map((run) =>
            run.length >= BURST_MIN_CARDS ? (
              <details class="feed-burst">
                <summary>
                  <strong>{run[0]!.householdName}</strong> · {run.length}{' '}
                  {run.every((card) => card.item.mediaType === 'book') ? 'books' : 'items'} · {run[0]!.published.slice(0, 10)}
                </summary>
                <div class="feed">
                  {run.map((card) => (
                    <FeedCard card={card} showHousehold={false} />
                  ))}
                </div>
              </details>
            ) : (
              run.map((card) => <FeedCard card={card} showHousehold={true} />)
            ),
          )}
        </div>
      )}
    </>,
  );
});

export default feed;
