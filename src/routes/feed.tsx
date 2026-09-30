// The Feed page (docs/proposals/connections.md §8): what connected households have been reading, from
// the views this household follows. Stored entries render straight away; subscriptions past their
// pull interval refresh after the response, so the page never waits on another instance.
//
// Everything shown here came from another instance. It is re-validated as it is read back, rendered
// only as escaped text, and covers load only from the connection's own /covers/<uuid>. A page holds a
// bounded number of bytes of it, so what a connection sends can't push rendering past the CPU budget.
import { Hono } from 'hono';
import type { FC } from 'hono/jsx';
import {
  commentsOnTheirItems,
  countSubscriptions,
  feedPage,
  getFederationSettings,
  markFeedSeen,
  recentCommentsOnOurReviews,
  takeRemovedCount,
  type FeedCursor,
  type StoredEntry,
} from '../db/federation';
import { isGoalKind, type ActivityKind, type Comment, type GoalKind } from '../db/schema';
import type { AppEnv } from '../env';
import { refreshInBackground } from '../federation/background';
import { FEED_PAGE_BYTES, FEED_PAGE_ENTRIES, RECENT_COMMENT_DAYS } from '../federation/config';
import { coverUrl, parseFeedGoal, parseFeedItem, type FeedGoal, type FeedItem } from '../federation/items';
import { goalPercent } from '../lib/goals';
import { loadIdentity } from '../federation/keys';
import { MEDIA_ICON, stars } from '../views/components';
import { page } from '../views/layout';
import { CommentForm, CommentView } from './comments';

const feed = new Hono<AppEnv>();

/** Cards from one household this close together read as one burst — an import, say. */
const BURST_GAP_MINUTES = 60;
const BURST_MIN_CARDS = 6;

type Card = {
  type: 'item';
  connectionId: number;
  householdName: string;
  baseUrl: string;
  itemId: number; // their items id
  itemStamp: string; // and which of their books it means
  // §16 #45: which of them, by display name, when their household shares names — a card per person then
  by: string | null;
  item: FeedItem;
  kinds: Set<ActivityKind>;
  published: string;
  review: string | null;
  reviewTruncated: boolean;
  rating: number | null;
  // every progress update for the book in this page of the feed, newest first
  progress: { page: number; percent: number | null; published: string }[];
  // §16 #41: when its finish was, and how many finished reads each side says there are — null from an older sender
  finishedAt: string | null;
  finishedReadCount: number | null;
  progressReadCount: number | null; // on the newest progress entry
};

/**
 * A member's reading goal from a connected household (§16 #49): set, halfway, reached. No book, so no cover and no
 * thread — a slim card with the name, what happened and the count it carried.
 */
type GoalCard = {
  type: 'goal';
  connectionId: number;
  householdName: string;
  kind: GoalKind;
  goal: FeedGoal;
  published: string;
};

type AnyCard = Card | GoalCard;

/**
 * One card per book per household, newest first: "finished and reviewed" rather than two cards. Each
 * entry carries only its own kind's field, so the review comes from the `reviewed` entry and the rating
 * from the `rated` one. Progress entries stay separate entries, but gather in their book's card as a
 * timeline rather than each taking a card of its own.
 */
function toCards(entries: StoredEntry[]): AnyCard[] {
  const cards = new Map<string, AnyCard>();
  for (const e of entries) {
    if (isGoalKind(e.kind)) {
      // a goal entry reaches us through every view of theirs we follow that can hold books: one card, whichever
      const key = `goal:${e.connectionId}:${e.remoteId}`;
      if (cards.has(key)) continue;
      let goal: FeedGoal | null;
      try {
        goal = parseFeedGoal(JSON.parse(e.item));
      } catch {
        goal = null;
      }
      if (goal) cards.set(key, { type: 'goal', connectionId: e.connectionId, householdName: e.householdName, kind: e.kind, goal, published: e.publishedAt });
      continue;
    }
    const kind = e.kind as ActivityKind;
    let item: FeedItem | null;
    try {
      item = parseFeedItem(JSON.parse(e.item));
    } catch {
      item = null;
    }
    if (!item) continue;
    // one card per book per household — and per person, when the household names who did what (§16 #45)
    const key = `${e.connectionId}:${e.itemRemoteId}:${e.itemStamp}:${item.by ?? ''}`;
    let card = cards.get(key) as Card | undefined;
    if (!card) {
      card = {
        type: 'item',
        connectionId: e.connectionId,
        householdName: e.householdName,
        baseUrl: e.baseUrl,
        itemId: e.itemRemoteId,
        itemStamp: e.itemStamp,
        by: item.by ?? null,
        item,
        kinds: new Set(),
        published: e.publishedAt,
        review: null,
        reviewTruncated: false,
        rating: null,
        progress: [],
        finishedAt: null,
        finishedReadCount: null,
        progressReadCount: null,
      };
      cards.set(key, card);
    }
    card.kinds.add(kind);
    if (e.kind === 'reviewed' && card.review === null) {
      card.review = item.review;
      card.reviewTruncated = item.reviewTruncated;
    }
    if (e.kind === 'rated' && card.rating === null) card.rating = item.rating;
    if (e.kind === 'finished' && card.finishedAt === null) {
      card.finishedAt = e.publishedAt;
      card.finishedReadCount = item.readCount;
    }
    if (e.kind === 'progress' && item.progress) {
      if (!card.progress.length) card.progressReadCount = item.readCount;
      card.progress.push({ ...item.progress, published: e.publishedAt });
    }
  }
  return [...cards.values()];
}

const minutes = (sqlDatetime: string) => Date.parse(`${sqlDatetime.replace(' ', 'T')}Z`) / 60_000;

/** Consecutive cards from the same household, each within BURST_GAP_MINUTES of the one before. */
function runs(cards: AnyCard[]): AnyCard[][] {
  const out: AnyCard[][] = [];
  for (const card of cards) {
    const run = out[out.length - 1];
    const prev = run?.[run.length - 1];
    if (
      run &&
      prev &&
      prev.connectionId === card.connectionId &&
      minutes(prev.published) - minutes(card.published) <= BURST_GAP_MINUTES
    ) {
      run.push(card);
    } else {
      out.push([card]);
    }
  }
  return out;
}

const VERB_ORDER: ActivityKind[] = ['started', 'progress', 'finished', 'rated', 'reviewed'];
const VERB: Record<ActivityKind, string> = { started: 'started', progress: 'reading', finished: 'finished', rated: 'rated', reviewed: 'reviewed' };

/**
 * A book finished before and being read again (§16 #41): its newest page belongs to a read with a finished one
 * before it, and no finish has come since. Its earlier finish stays shared all the while — the book is still
 * Completed there — so without this the finish would hide the re-read.
 */
function rereading(card: Card): boolean {
  const newest = card.progress[0];
  return !!newest && (card.progressReadCount ?? 0) >= 1 && (card.finishedAt === null || newest.published > card.finishedAt);
}

function verbs(card: Card): string {
  const again = rereading(card);
  const list = VERB_ORDER.filter((k) => card.kinds.has(k))
    // once a book is finished its progress is the story of how, not what's happening now — unless it's a re-read,
    // when the earlier finish is the old news
    .filter((k) => !(k === 'progress' && card.kinds.has('finished') && !again) && !(k === 'finished' && again))
    // a start says less than the pages or the finish that followed it
    .filter((k) => !(k === 'started' && (card.kinds.has('progress') || card.kinds.has('finished'))))
    .map((k) =>
      k === 'progress' && again ? 're-reading' : k === 'finished' && (card.finishedReadCount ?? 0) >= 2 ? 'finished again' : VERB[k],
    );
  return list.length > 1 ? `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}` : (list[0] ?? '');
}

const PROGRESS_SHOWN = 5;

// `thread`: the item's comment thread, or null on a card that doesn't carry it — with names shared, several people's
// cards can review one book, and its one thread goes under the first of them only (§16 #45)
const FeedCard: FC<{ card: Card; showHousehold: boolean; thread: Comment[] | null }> = ({ card, showHousehold, thread }) => {
  const { item } = card;
  const cover = coverUrl(card.baseUrl, item.coverKey);
  const again = rereading(card);
  // a re-read's timeline is its own pages, not the earlier read's
  const timeline = again && card.finishedAt ? card.progress.filter((p) => p.published > card.finishedAt!) : card.progress;
  return (
    <article class="feed-card">
      <div class="feed-cover">
        {cover ? (
          <img
            class="cover-img"
            src={cover}
            alt={`Cover of ${item.title}`}
            loading="lazy"
            referrerpolicy="no-referrer"
            data-fallback={MEDIA_ICON[item.mediaType]}
          />
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
          {/* a name from another household: escaped text, like everything else here */}
          {card.by ? <span class="feed-by">{card.by} </span> : null}
          <span class="muted">{verbs(card)}</span> <strong>{item.title}</strong>
          {item.creators ? <small> · {item.creators}</small> : null}
          {/* their household wants it (§16 #53): a boolean from them, rendered as our own fixed text */}
          {item.wanted && !item.inCollection ? (
            <>
              {' '}
              <span class="pill wanted">Wanted</span>
            </>
          ) : null}
        </p>
        {card.rating ? <span class="rating">{stars(card.rating)}</span> : null}
        {timeline.length ? (
          <>
            {/* the bar says how far through a book they are — a finished book isn't partway through anything,
                but one being read again is */}
            {timeline[0]!.percent !== null && (!card.kinds.has('finished') || again) ? (
              <div class="progress-track" aria-hidden="true">
                <div class="progress-fill" style={`width:${timeline[0]!.percent}%`} />
              </div>
            ) : null}
            <ol class="progress-log feed-progress">
              {timeline.slice(0, PROGRESS_SHOWN).map((p) => (
                <li>
                  <span class="mono">{p.percent !== null ? `${p.percent}%` : '—'}</span>
                  <span class="mono">p. {p.page}</span>
                  <span class="mono muted">{p.published.slice(0, 10)}</span>
                </li>
              ))}
              {timeline.length > PROGRESS_SHOWN ? (
                <li class="muted">+{timeline.length - PROGRESS_SHOWN} earlier</li>
              ) : null}
            </ol>
          </>
        ) : null}
        {card.review ? (
          <p class="prewrap feed-review">
            {card.review}
            {card.reviewTruncated ? '…' : ''}
          </p>
        ) : null}
        {card.review && thread ? (
          <details class="thread" id={`thread-${card.connectionId}-${card.itemId}`} open={thread.length > 0}>
            <summary>{thread.length ? `Comments (${thread.length})` : 'Comment'}</summary>
            {thread.map((comment) => (
              <CommentView
                comment={comment}
                household={card.householdName}
                canDelete={comment.fromUs}
                back={`/feed#thread-${card.connectionId}-${card.itemId}`}
              />
            ))}
            <CommentForm
              action="/feed/comments"
              fields={{ connectionId: String(card.connectionId), itemId: String(card.itemId), stamp: card.itemStamp }}
              label="Send"
            />
            <small class="muted">Seen only by {card.householdName} and this library.</small>
          </details>
        ) : null}
      </div>
    </article>
  );
};

/** What a goal entry says happened, after the member's name. */
function goalVerb(kind: GoalKind, goal: FeedGoal): string {
  switch (kind) {
    case 'goal_set':
      return `set a goal of ${goal.target} ${goal.target === 1 ? 'book' : 'books'} for ${goal.year}`;
    case 'goal_halfway':
      return `is halfway to their ${goal.year} goal`;
    case 'goal_reached':
      return `reached their ${goal.year} goal`;
  }
}

// Everything here came from another instance: the name and the numbers render as escaped text, and the bar's width
// is a whole number worked out here from two checked integers — never a string of theirs.
const GoalFeedCard: FC<{ card: GoalCard; showHousehold: boolean }> = ({ card, showHousehold }) => {
  const { goal } = card;
  return (
    <article class="feed-card feed-goal">
      <div class="feed-body">
        <p class="eyebrow">
          {showHousehold ? `${card.householdName} · ` : ''}
          {card.published.slice(0, 10)}
        </p>
        <p class="feed-line">
          <span class="feed-by">{goal.by} </span>
          <span class="muted">{goalVerb(card.kind, goal)}</span>
        </p>
        <p class="goal-line">
          <span class="goal-count">
            {goal.count} of {goal.target}
          </span>{' '}
          <span class="muted mono">
            {goal.target === 1 ? 'book' : 'books'} in {goal.year}
          </span>
        </p>
        <div class="progress-track" role="img" aria-label={`${goal.count} of ${goal.target} books`}>
          <div class="progress-fill" style={`width:${goalPercent(goal.count, goal.target)}%`} />
        </div>
      </div>
    </article>
  );
};

const BEFORE = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})~(\d{1,15})$/;

function parseBefore(raw: string | undefined): FeedCursor | null {
  const m = raw ? BEFORE.exec(raw) : null;
  return m ? { publishedAt: m[1]!, id: Number(m[2]) } : null;
}

feed.get('/feed', async (c) => {
  const identity = await loadIdentity(c.env.FEDERATION_PRIVATE_KEY);
  if (!identity) return c.notFound();
  const user = c.get('user');
  const settings = await getFederationSettings(c.env.DB);
  const before = parseBefore(c.req.query('before'));
  const firstPage = before === null;

  // Before refreshInBackground starts writing: entries its pull brings in stay unread until a visit shows them.
  if (firstPage) await markFeedSeen(c.env.DB, user.id);
  const [{ entries, next }, subscriptions, removed] = settings
    ? await Promise.all([
        feedPage(c.env.DB, { before, maxEntries: FEED_PAGE_ENTRIES, maxBytes: FEED_PAGE_BYTES }),
        countSubscriptions(c.env.DB),
        firstPage ? takeRemovedCount(c.env.DB) : Promise.resolve(0),
      ])
    : [{ entries: [], next: null }, 0, 0];
  // Comments addressed to us arrive through connections' outboxes whether or not we follow anything.
  if (settings && firstPage) refreshInBackground(c, identity, settings, subscriptions > 0);
  const cards = toCards(entries);
  const [threadRows, recent] = await Promise.all([
    commentsOnTheirItems(
      c.env.DB,
      cards
        .filter((card): card is Card => card.type === 'item' && card.review !== null)
        .map((card): [number, number, string] => [card.connectionId, card.itemId, card.itemStamp]),
    ),
    settings && firstPage ? recentCommentsOnOurReviews(c.env.DB, RECENT_COMMENT_DAYS, 10) : Promise.resolve([]),
  ]);
  const threads = new Map<string, Comment[]>();
  for (const row of threadRows) {
    const key = `${row.connectionId}:${row.theirItemId}:${row.theirItemStamp}`;
    threads.set(key, [...(threads.get(key) ?? []), row]);
  }
  // one thread per book: under the first card that reviews it, never repeated under another person's card (§16 #45)
  const threadShown = new Set<string>();
  const threadOf = (card: Card): Comment[] | null => {
    const key = `${card.connectionId}:${card.itemId}:${card.itemStamp}`;
    if (card.review) {
      if (threadShown.has(key)) return null;
      threadShown.add(key);
    }
    return threads.get(key) ?? [];
  };
  const groups = runs(cards);

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
      {recent.length ? (
        <section>
          <p class="eyebrow">Comments on your reviews</p>
          <ul class="recent-comments">
            {recent.map((r) => (
              <li>
                <strong>{r.authorName}</strong> <span class="muted">({r.householdName})</span> on{' '}
                <a href={`/items/${r.itemId}#comments`}>{r.itemTitle}</a>{' '}
                <small class="muted mono">{r.createdAt.slice(0, 10)}</small>
              </li>
            ))}
          </ul>
        </section>
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
          {firstPage
            ? 'Nothing yet. New activity is fetched in the background whenever this page opens — check back in a moment.'
            : 'Nothing older.'}
        </p>
      ) : (
        <div class="feed">
          {groups.map((run) =>
            run.length >= BURST_MIN_CARDS ? (
              <details class="feed-burst">
                <summary>
                  <strong>{run[0]!.householdName}</strong>{' '}
                  <span class="mono">
                    · {run.length}{' '}
                    {run.every((card) => card.type === 'item' && card.item.mediaType === 'book')
                      ? 'books'
                      : run.some((card) => card.type === 'goal')
                        ? 'entries'
                        : 'items'}{' '}
                    ·{' '}
                    {run[0]!.published.slice(0, 10)}
                  </span>
                </summary>
                <div class="feed">
                  {run.map((card) =>
                    card.type === 'goal' ? (
                      <GoalFeedCard card={card} showHousehold={false} />
                    ) : (
                      <FeedCard card={card} showHousehold={false} thread={threadOf(card)} />
                    ),
                  )}
                </div>
              </details>
            ) : (
              run.map((card) =>
                card.type === 'goal' ? (
                  <GoalFeedCard card={card} showHousehold={true} />
                ) : (
                  <FeedCard card={card} showHousehold={true} thread={threadOf(card)} />
                ),
              )
            ),
          )}
        </div>
      )}
      {next ? (
        <nav class="pagination">
          <span />
          <span />
          <a href={`/feed?before=${encodeURIComponent(`${next.publishedAt}~${next.id}`)}`}>Older →</a>
        </nav>
      ) : null}
    </>,
  );
});

export default feed;
