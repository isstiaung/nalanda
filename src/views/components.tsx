import type { FC } from 'hono/jsx';
import type { Item, ItemStatus, Library, MediaType, Share } from '../db/schema';
import { ITEM_STATUSES, MEDIA_TYPES } from '../db/schema';
import { progressPercent } from '../lib/progress';
import { ordinal, summarizeReads, type ReadDraft, type ReadRow } from '../lib/reads';
import { parseDetails } from '../lib/share';
import type { Candidate } from '../metadata';

export const MEDIA_LABEL: Record<MediaType, string> = {
  book: 'Book',
  boardgame: 'Board game',
  vinyl: 'Vinyl',
  movie: 'Movie',
  music: 'Music',
  videogame: 'Video game',
  other: 'Other',
};

/** Lowercase count nouns for inline breakdowns: "12 books · 3 board games · 5 vinyl". */
export const MEDIA_PLURAL: Record<MediaType, string> = {
  book: 'books',
  boardgame: 'board games',
  vinyl: 'vinyl',
  movie: 'movies',
  music: 'music',
  videogame: 'video games',
  other: 'other',
};

export const MEDIA_ICON: Record<MediaType, string> = {
  book: '📖',
  boardgame: '🎲',
  vinyl: '💿',
  movie: '🎬',
  music: '🎵',
  videogame: '🎮',
  other: '📦',
};

export const STATUS_LABEL: Record<ItemStatus, string> = {
  not_started: 'Not started',
  in_progress: 'In progress',
  completed: 'Completed',
  abandoned: 'Abandoned',
};

/** "Board games · In progress · Owned" — how a share view's captured filters read. */
export function shareScopeLabel(v: Share): string {
  const parts: string[] = [];
  if (v.tag) parts.push(`#${v.tag}`);
  if (v.mediaType) parts.push(MEDIA_LABEL[v.mediaType]);
  if (v.status) parts.push(STATUS_LABEL[v.status]);
  if (v.owned !== null) parts.push(v.owned ? 'Owned' : 'Not owned');
  return parts.length ? parts.join(' · ') : 'Whole shelf';
}

const STATUS_PILL_CLASS: Record<ItemStatus, string> = {
  not_started: 'pill',
  in_progress: 'pill progress',
  completed: 'pill done',
  abandoned: 'pill dropped',
};

/** rating is stored as half-stars 0–10, rendered as ★★★½ */
export function stars(rating: number | null | undefined): string {
  if (!rating) return '';
  return '★'.repeat(Math.floor(rating / 2)) + (rating % 2 ? '½' : '');
}

/** The registrar's accession number: № 000142 */
export function accNo(id: number): string {
  return `№ ${String(id).padStart(6, '0')}`;
}

/** First 4-digit year in a fuzzy published string, or the string itself if short. */
export function yearOf(published: string | null): string {
  if (!published) return '';
  const m = published.match(/\d{4}/);
  return m ? m[0] : published;
}

export const StatusPill: FC<{ status: ItemStatus }> = ({ status }) => (
  <span class={STATUS_PILL_CLASS[status]}>{STATUS_LABEL[status]}</span>
);

/** copies = 0: in the ledger, not on the shelf — a reading-log entry. */
export const NotOwnedPill: FC = () => <span class="pill ghost">Not owned</span>;

/**
 * A book finished before and being read again (§16 #41). It keeps its Completed status — nothing moves between
 * views — and this marks the open read wherever status shows.
 */
export const RereadingPill: FC = () => <span class="pill rereading">Re-reading</span>;

/** The status pill, and the re-reading marker beside it when there is one. */
export const StatusPills: FC<{ item: Pick<Item, 'status' | 'rereading'> }> = ({ item }) => (
  <>
    <StatusPill status={item.status} />
    {item.rereading ? (
      <>
        {' '}
        <RereadingPill />
      </>
    ) : null}
  </>
);

/**
 * The item page's status, in a span htmx can replace out of band: starting, finishing or stopping a read changes
 * it from inside the Reading section. `oob` renders it for that swap.
 */
export const ItemStatusPills: FC<{ item: Pick<Item, 'status' | 'rereading'>; oob?: boolean }> = ({ item, oob }) => (
  <span id="item-status" class="status-pills" hx-swap-oob={oob ? 'true' : undefined}>
    <StatusPills item={item} />
  </span>
);

type ReadingRead = ReadRow & { createdAt?: string; readerId: number | null };
type ReadingPage = { id: number; page: number; at: string; readId: number | null; addedBy: number | null };

/** Who is looking at a book's page: members change their own reading and review, admins anyone's (§16 #43). */
export type Viewer = { id: number; admin: boolean };
/** A member of the household, as the book's page names them. */
export type Person = { id: number; username: string };

/** A member's name, or how a member removed since reads. */
export const personName = (people: Person[], id: number | null): string =>
  (id !== null ? people.find((p) => p.id === id)?.username : undefined) ?? 'Former member';

const htmxTo = (url: string) => ({ 'hx-post': url, 'hx-target': '#reading', 'hx-swap': 'outerHTML' });

/** A read's dates as a span: "2019-03-01 → 2019-03-20", with what isn't known left as "?". */
const readSpan = (r: ReadDraft) =>
  r.beganOn === null && r.endedOn === null && r.status !== 'in_progress'
    ? 'dates not known'
    : `${r.beganOn ?? '?'} → ${r.status === 'in_progress' ? 'now' : (r.endedOn ?? '?')}`;

function outcome(r: ReadDraft, rereading: boolean, lastPage: number | null): string {
  if (r.status === 'completed') return 'finished';
  if (r.status === 'abandoned') return lastPage ? `stopped at p. ${lastPage}` : 'stopped';
  return rereading ? 're-reading' : 'reading';
}

const PageLog: FC<{ item: Item; entries: ReadingPage[]; removable: boolean }> = ({ item, entries, removable }) =>
  entries.length ? (
    <ol class="progress-log">
      {entries.map((e) => (
        <li>
          <span class="mono">p. {e.page}</span>
          <span class="mono muted">{e.at.slice(0, 10)}</span>
          {removable ? (
            <form method="post" action={`/items/${item.id}/progress/${e.id}/delete`} {...htmxTo(`/items/${item.id}/progress/${e.id}/delete`)}>
              <button type="submit" class="progress-delete" aria-label={`Remove page ${e.page}, ${e.at.slice(0, 10)}`}>
                Remove
              </button>
            </form>
          ) : null}
        </li>
      ))}
    </ol>
  ) : null;

/**
 * One person's reading of a book, worked out from their reads alone (§16 #43): what the summary line, the buttons
 * and the page field say to them. `summarizeReads` is the household's rule, and with one person's reads it is that
 * person's.
 */
function personalReading(item: Item, reads: ReadingRead[], entries: ReadingPage[], person: number | null) {
  const mine = reads.filter((r) => r.readerId === person);
  const ids = new Set(mine.map((r) => r.id));
  // summarizeReads takes insertion order, where a later read is a newer one
  const state = summarizeReads([...mine].sort((a, b) => a.id - b.id));
  const open = mine.find((r) => r.status === 'in_progress') ?? null;
  // pages of the open read, or — for someone with no reads at all — pages they recorded before reads existed
  const current = open
    ? entries.filter((e) => e.readId === open.id)
    : mine.length
      ? []
      : entries.filter((e) => e.readId === null && e.addedBy === person);
  const page = open ? (current.at(-1)?.page ?? null) : null;
  const pagesOf = (r: ReadingRead) => entries.filter((e) => e.readId === r.id);
  let summary: string;
  if (open) {
    const since = open.beganOn ? `since ${open.beganOn}` : 'start date not known';
    summary = state.rereading ? `Re-reading, ${since} · finished ${state.readCount === 1 ? 'once' : `${state.readCount} times`} before` : `Reading, ${since}`;
  } else if (state.readCount > 0) {
    summary = `Finished${state.completedOn ? ` ${state.completedOn}` : ', date not known'}${state.readCount > 1 ? ` · read ${state.readCount} times` : ''}`;
  } else if (mine.length) {
    summary = `Stopped${state.completedOn ? ` ${state.completedOn}` : ''}`;
  } else {
    summary = 'Not started.';
  }
  return { mine, ids, state, open, current, page, pagesOf, summary, percent: page ? progressPercent(page, item.length) : null };
}

/** Where a read in progress has got to: "p. 120 of 300 · 40%", and the bar. */
const ProgressLine: FC<{ page: number; length: number | null; percent: number | null }> = ({ page, length, percent }) => (
  <>
    <p>
      <span class="mono">p. {page}</span>
      {length ? (
        <>
          {' of '}
          <span class="mono">{length}</span>
        </>
      ) : null}
      {percent !== null ? (
        <>
          {' · '}
          <span class="mono">{percent}%</span>
        </>
      ) : null}
    </p>
    {percent !== null ? (
      <div class="progress-track" role="img" aria-label={`${percent}% read`}>
        <div class="progress-fill" style={`width:${percent}%`} />
      </div>
    ) : null}
  </>
);

/**
 * A read in a history: its number, dates and outcome, and — for whoever may change it — the forms to correct it,
 * delete it, and (admins only) move it to another member with its pages (§16 #43).
 */
const ReadLine: FC<{
  item: Item;
  read: ReadingRead;
  n: number;
  pages: ReadingPage[];
  rereading: boolean;
  editable: boolean;
  moveTo: Person[];
}> = ({ item, read: r, n, pages, rereading, editable, moveTo }) => {
  const base = `/items/${item.id}`;
  return (
    <li>
      <span class="mono">{ordinal(n)}</span>
      <span class="mono">{readSpan(r)}</span>
      <span>{outcome(r, rereading, pages.at(-1)?.page ?? null)}</span>
      {pages.length ? <span class="muted">{pages.length === 1 ? '1 page logged' : `${pages.length} pages logged`}</span> : null}
      {editable ? (
        <details class="read-edit">
          <summary>Edit</summary>
          <form method="post" action={`${base}/reads/${r.id}`} class="inline-form" {...htmxTo(`${base}/reads/${r.id}`)}>
            <select name="status" aria-label="Outcome">
              <option value="completed" selected={r.status === 'completed'}>
                Finished
              </option>
              <option value="abandoned" selected={r.status === 'abandoned'}>
                Stopped
              </option>
              <option value="in_progress" selected={r.status === 'in_progress'}>
                Reading now
              </option>
            </select>
            <input type="date" name="beganOn" value={r.beganOn ?? ''} aria-label="Began" class="mono" />
            <input type="date" name="endedOn" value={r.endedOn ?? ''} aria-label="Ended" class="mono" />
            <button type="submit">Save</button>
          </form>
          <form
            method="post"
            action={`${base}/reads/${r.id}/delete`}
            class="inline-form"
            {...htmxTo(`${base}/reads/${r.id}/delete`)}
            hx-confirm="Delete this read and the pages logged in it?"
          >
            <button type="submit" class="btn-danger">
              Delete this read{pages.length ? ' and its pages' : ''}
            </button>
          </form>
          {moveTo.length ? (
            <form method="post" action={`${base}/reads/${r.id}/move`} class="inline-form" {...htmxTo(`${base}/reads/${r.id}/move`)}>
              <select name="to" aria-label="Move this read to">
                {moveTo.map((p) => (
                  <option value={String(p.id)}>{p.username}</option>
                ))}
              </select>
              <button type="submit" class="btn">
                Move{pages.length ? ' with its pages' : ''}
              </button>
            </form>
          ) : null}
          {r.status !== 'in_progress' ? <PageLog item={item} entries={pages} removable={false} /> : null}
        </details>
      ) : null}
    </li>
  );
};

/**
 * A book's reading: where the viewer's current read has got to, the controls to start, finish or stop one, and every
 * read of theirs so far with its pages (§16 #41) — and, when anyone else has read it or the household has more than
 * one member (`grouped`), everyone else's reading under their name (§16 #43). Everyone sees everyone's; only its
 * reader or an admin gets the forms to change a read. Swaps itself on every change (hx-target on the section), and
 * the household's status pill above it out of band, so nothing on the page goes stale. Books only — pages mean
 * nothing for a record or a board game, whose reads the edit form keeps.
 */
export const ReadingSection: FC<{
  item: Item;
  reads: ReadingRead[];
  entries: ReadingPage[];
  today: string;
  viewer: Viewer;
  people: Person[];
  grouped: boolean;
  error?: string;
}> = ({ item, reads, entries, today, viewer, people, grouped, error }) => {
  const me = personalReading(item, reads, entries, viewer.id);
  const { mine, open } = me;
  const base = `/items/${item.id}`;
  // admins move a read to anyone but its reader
  const moveTargets = (readerId: number | null) => (viewer.admin ? people.filter((p) => p.id !== readerId) : []);

  // everyone else who has read it, by name, and a member removed since last
  const others = [...new Set(reads.map((r) => r.readerId).filter((id) => id !== viewer.id))].sort((a, b) =>
    a === null ? 1 : b === null ? -1 : personName(people, a).localeCompare(personName(people, b)),
  );

  const own = (
    <>
      <p class={mine.length ? 'reading-summary' : 'reading-summary muted'}>{me.summary}</p>

      {open && me.page ? <ProgressLine page={me.page} length={item.length} percent={me.percent} /> : null}

      {/* pages go to an open read; recording one on a book never started starts it (§16 #34) */}
      {open || !mine.length ? (
        <form method="post" action={`${base}/progress`} class="inline-form" {...htmxTo(`${base}/progress`)}>
          <input name="page" inputmode="numeric" pattern="[0-9]+" class="mono" size={6} placeholder="Page" aria-label="Page reached" required />
          {item.length ? <span class="muted">of {item.length}</span> : null}
          {/* each form's own action is primary (a plain submit); Stop is secondary (.btn), Delete a danger action */}
          <button type="submit">Record</button>
        </form>
      ) : null}

      {error ? <p class="error">{error}</p> : null}

      <PageLog item={item} entries={me.current} removable={true} />

      <div class="read-actions">
        {open ? (
          <>
            <form method="post" action={`${base}/reads/${open.id}/finish`} class="inline-form" {...htmxTo(`${base}/reads/${open.id}/finish`)}>
              <input type="date" name="date" value={today} aria-label="Finished on" class="mono" />
              <button type="submit">Finish</button>
            </form>
            <form method="post" action={`${base}/reads/${open.id}/stop`} class="inline-form" {...htmxTo(`${base}/reads/${open.id}/stop`)}>
              <button type="submit" class="btn">
                {me.state.rereading ? 'Stop re-reading' : 'Stop reading'}
              </button>
            </form>
          </>
        ) : (
          <form method="post" action={`${base}/reads/start`} class="inline-form" {...htmxTo(`${base}/reads/start`)}>
            <button type="submit">{me.state.readCount > 0 ? 'Read again' : mine.length ? 'Start again' : 'Start reading'}</button>
          </form>
        )}
      </div>

      {mine.length ? (
        <>
          <p class="eyebrow read-history-head">{grouped ? 'Your reads' : 'Reads'}</p>
          <ol class="read-history">
            {mine.map((r, i) => (
              <ReadLine
                item={item}
                read={r}
                n={i + 1}
                pages={me.pagesOf(r)}
                rereading={me.state.rereading}
                editable={true}
                moveTo={moveTargets(r.readerId)}
              />
            ))}
          </ol>
        </>
      ) : null}

      <details class="read-edit read-add">
        <summary>Add a past read</summary>
        <form method="post" action={`${base}/reads`} class="inline-form" {...htmxTo(`${base}/reads`)}>
          <select name="status" aria-label="Outcome">
            <option value="completed">Finished</option>
            <option value="abandoned">Stopped</option>
          </select>
          <input type="date" name="beganOn" aria-label="Began" class="mono" />
          <input type="date" name="endedOn" aria-label="Ended" class="mono" />
          <button type="submit">Add</button>
        </form>
      </details>
    </>
  );

  return (
    <div class="detail-section" id="reading">
      <p class="eyebrow">Reading</p>
      {grouped ? (
        <div class="reader reader-self">
          <p class="reader-name">
            You <span class="muted">· {personName(people, viewer.id)}</span>
          </p>
          {own}
        </div>
      ) : (
        own
      )}
      {others.map((id) => {
        const them = personalReading(item, reads, entries, id);
        const editable = viewer.admin;
        return (
          <div class="reader">
            <p class="reader-name">{personName(people, id)}</p>
            <p class="reading-summary">{them.summary}</p>
            {them.open && them.page ? <ProgressLine page={them.page} length={item.length} percent={them.percent} /> : null}
            {/* an admin can take out a mistyped page of anyone's; everyone else just sees where they are */}
            {editable ? <PageLog item={item} entries={them.current} removable={true} /> : null}
            <ol class="read-history">
              {them.mine.map((r, i) => (
                <ReadLine
                  item={item}
                  read={r}
                  n={i + 1}
                  pages={them.pagesOf(r)}
                  rereading={them.state.rereading}
                  editable={editable}
                  moveTo={moveTargets(r.readerId)}
                />
              ))}
            </ol>
          </div>
        );
      })}
    </div>
  );
};

/**
 * Everyone's reads of a record, a board game or anything else that isn't a book (§16 #43), under their names — once the
 * household has more than one member. Each person's own are kept from the edit form, as ever; here a read's reader or
 * an admin corrects or deletes it, and an admin moves it to another member, as on a book's page. No pages, no Read
 * again: those are for books. Swaps itself on every change, like the Reading section it stands in for.
 */
export const ReadsByPerson: FC<{ item: Item; reads: ReadingRead[]; viewer: Viewer; people: Person[]; error?: string }> = ({
  item,
  reads,
  viewer,
  people,
  error,
}) => {
  const readers = [...new Set(reads.map((r) => r.readerId))].sort((a, b) =>
    a === viewer.id ? -1 : b === viewer.id ? 1 : a === null ? 1 : b === null ? -1 : personName(people, a).localeCompare(personName(people, b)),
  );
  return (
    <div class="detail-section" id="reading">
      <p class="eyebrow">Reading</p>
      {error ? <p class="error">{error}</p> : null}
      {readers.map((id) => {
        const them = personalReading(item, reads, [], id);
        return (
          // the viewer's own reads lead, styled as on a book's page
          <div class={id === viewer.id ? 'reader reader-self' : 'reader'}>
            <p class="reader-name">
              {id === viewer.id ? (
                <>
                  You <span class="muted">· {personName(people, id)}</span>
                </>
              ) : (
                personName(people, id)
              )}
            </p>
            <p class="reading-summary">{them.summary}</p>
            <ol class="read-history">
              {them.mine.map((r, i) => (
                <ReadLine
                  item={item}
                  read={r}
                  n={i + 1}
                  pages={[]}
                  rereading={them.state.rereading}
                  editable={viewer.admin || id === viewer.id}
                  moveTo={viewer.admin ? people.filter((p) => p.id !== r.readerId) : []}
                />
              ))}
            </ol>
          </div>
        );
      })}
    </div>
  );
};

type ReviewLine = { id: number; userId: number | null; rating: number | null; review: string | null; reviewedAt: string | null };

/**
 * Everyone's ratings and reviews of an item, each under its writer's name (§16 #43) — inside the app only. The item's
 * own rating and review, the household's summary, are what share pages and connections see, with no name. A review's
 * writer and admins get Edit (rating and text, both empty deletes it) and Delete; admins also Move, to fix a review
 * credited to the wrong person. The viewer's own review is also what the edit form's rating and review fields hold.
 */
export const ReviewsSection: FC<{ item: Item; reviews: ReviewLine[]; viewer: Viewer; people: Person[] }> = ({ item, reviews, viewer, people }) => {
  const base = `/items/${item.id}`;
  const mineWritten = reviews.some((r) => r.userId === viewer.id);
  return (
    <div class="detail-section" id="reviews">
      <p class="eyebrow">Ratings and reviews</p>
      {reviews.length ? (
        <ol class="member-reviews">
          {reviews.map((r) => {
            const editable = viewer.admin || r.userId === viewer.id;
            const moveTo = viewer.admin ? people.filter((p) => p.id !== r.userId && !reviews.some((o) => o.userId === p.id)) : [];
            const who = r.userId === viewer.id ? `You · ${personName(people, r.userId)}` : personName(people, r.userId);
            return (
              <li>
                <p class="review-by">
                  <span class="reviewer">{who}</span>
                  {r.rating ? <span class="rating">{stars(r.rating)}</span> : null}
                  {r.reviewedAt ? <span class="mono muted">{r.reviewedAt.slice(0, 10)}</span> : null}
                </p>
                {r.review ? <p class="prewrap">{r.review}</p> : null}
                {editable ? (
                  <details class="read-edit">
                    <summary>Edit</summary>
                    <form method="post" action={`${base}/reviews/${r.id}`} class="review-form">
                      <RatingSelect value={r.rating} />
                      <textarea name="review" rows={3} aria-label="Review">
                        {r.review ?? ''}
                      </textarea>
                      <button type="submit">Save</button>
                    </form>
                    <form
                      method="post"
                      action={`${base}/reviews/${r.id}/delete`}
                      class="inline-form"
                      data-confirm={r.userId === viewer.id ? 'Delete your rating and review?' : `Delete ${personName(people, r.userId)}’s rating and review?`}
                    >
                      <button type="submit" class="btn-danger">
                        Delete
                      </button>
                    </form>
                    {moveTo.length ? (
                      <form method="post" action={`${base}/reviews/${r.id}/move`} class="inline-form">
                        <select name="to" aria-label="Move this review to">
                          {moveTo.map((p) => (
                            <option value={String(p.id)}>{p.username}</option>
                          ))}
                        </select>
                        <button type="submit" class="btn">
                          Move
                        </button>
                      </form>
                    ) : null}
                  </details>
                ) : null}
              </li>
            );
          })}
        </ol>
      ) : null}
      {!mineWritten ? (
        <p class="muted form-note">
          {reviews.length ? 'Add yours' : 'Rate or review it'} from <a href={`${base}/edit`}>Edit</a>.
        </p>
      ) : null}
    </div>
  );
};

/** Same as NotOwnedPill but clickable — one tap sets copies to 1 in place (htmx),
 *  swapping itself for a MarkNotOwnedButton. No edit form. Authenticated views
 *  only; share pages keep the plain NotOwnedPill. */
export const MarkOwnedButton: FC<{ id: number }> = ({ id }) => (
  <button
    type="button"
    class="pill ghost pill-btn"
    hx-post={`/items/${id}/mark-owned`}
    hx-swap="outerHTML"
    title="Mark as owned"
  >
    Not owned
  </button>
);

/** The reverse of MarkOwnedButton — one tap sets copies to 0 (a reading-log
 *  entry, same as the "Log — not owned" add action), swapping itself back for
 *  a MarkOwnedButton. Any copy count above 1 is not preserved by this quick
 *  toggle — same as MarkOwnedButton always landing on exactly 1, adjusting a
 *  specific copy count is still an edit-form job. Reuses the "done" treatment
 *  (same indigo as a Completed status pill) as the positive/success color —
 *  the palette has no green (CLAUDE.md). */
export const MarkNotOwnedButton: FC<{ id: number }> = ({ id }) => (
  <button
    type="button"
    class="pill done pill-btn"
    hx-post={`/items/${id}/mark-not-owned`}
    hx-swap="outerHTML"
    title="Mark as not owned"
  >
    Owned
  </button>
);

/** A real multi-copy count: shown, never toggled. The quick action only knows how
 *  to land on 0 or 1, so offering it here would silently discard a number someone
 *  recorded — and `copies` round-trips through /export.csv. Adjusting it stays an
 *  edit-form job. */
export const CopiesPill: FC<{ copies: number }> = ({ copies }) => (
  <span class="pill" title="Edit the item to change the copy count">
    {copies} copies
  </span>
);

/** The Holding column/row: whichever toggle button matches current copies, or a
 *  plain count for items held in more than one copy. */
export const HoldingPill: FC<{ item: Item }> = ({ item }) =>
  item.copies > 1 ? (
    <CopiesPill copies={item.copies} />
  ) : item.copies === 1 ? (
    <MarkNotOwnedButton id={item.id} />
  ) : (
    <MarkOwnedButton id={item.id} />
  );

export const Cover: FC<{ coverKey: string | null; title: string; mediaType: MediaType }> = ({
  coverKey,
  title,
  mediaType,
}) =>
  coverKey ? (
    <img class="cover-img" src={`/covers/${coverKey}`} alt={`Cover of ${title}`} loading="lazy" data-fallback={MEDIA_ICON[mediaType]} />
  ) : (
    <div class="cover-fallback" aria-hidden="true">
      {MEDIA_ICON[mediaType]}
    </div>
  );

export const ItemCard: FC<{ item: Item; onLoan?: boolean; href?: string }> = ({ item, onLoan, href }) => (
  <a href={href ?? `/items/${item.id}`} class="item-card">
    <div class="item-cover">
      <Cover coverKey={item.coverKey} title={item.title} mediaType={item.mediaType} />
    </div>
    <div class="item-meta">
      <strong>{item.title}</strong>
      {item.creators ? <small>{item.creators}</small> : null}
      <span class="mline">
        <small class="acc-no">{accNo(item.id)}</small>
        {item.rating ? <span class="rating">{stars(item.rating)}</span> : null}
        {item.rereading ? <RereadingPill /> : null}
        {item.copies === 0 ? <NotOwnedPill /> : null}
        {onLoan ? <span class="pill lent">Lent</span> : null}
      </span>
    </div>
  </a>
);

export const ItemGrid: FC<{ items: Item[]; onLoanIds?: Set<number> }> = ({ items, onLoanIds }) => (
  <div class="item-grid">
    {items.map((item) => (
      <ItemCard item={item} onLoan={onLoanIds?.has(item.id)} />
    ))}
  </div>
);

/**
 * Columns the reader can turn off. Title is deliberately absent — a row has to
 * stay identifiable. `key` doubles as the `col-*` cell class and the token stored
 * in localStorage, so nothing has to stay in sync by hand.
 */
export const TABLE_COLUMNS = [
  { key: 'type', label: 'Type' },
  { key: 'shelf', label: 'Shelf' },
  { key: 'year', label: 'Year' },
  { key: 'completed', label: 'Completed' },
  { key: 'rating', label: 'Rating' },
  { key: 'status', label: 'Status' },
  { key: 'holding', label: 'Holding' },
  { key: 'tags', label: 'Tags' },
  { key: 'acc', label: 'Accession no.' },
] as const;

export type ColumnKey = (typeof TABLE_COLUMNS)[number]['key'];

/**
 * The Columns dropdown. Checkboxes carry no `name`, so they never join the
 * surrounding GET filter form — this is a client-side display preference, not a
 * query. app.js reads them, writes localStorage, and flips `data-hide-cols` on
 * <html>; with JS off the menu simply does nothing and every column stays put.
 */
export const ColumnsMenu: FC<{ available: readonly ColumnKey[] }> = ({ available }) => (
  <details class="filter" id="columns-menu">
    <summary>Columns</summary>
    <div class="filter-menu">
      {TABLE_COLUMNS.filter((c) => available.includes(c.key)).map((c) => (
        <label>
          <input type="checkbox" data-col={c.key} checked />
          {c.label}
        </label>
      ))}
    </div>
  </details>
);

/** The default library view: a proper registry table. */
export const ItemTable: FC<{
  items: Item[];
  onLoanIds?: Set<number>;
  tagsMap?: Map<number, string[]>;
  libraryNames?: Map<number, string>;
}> = ({ items, onLoanIds, tagsMap, libraryNames }) => (
  <div class="data-table">
    <table>
      <thead>
        <tr>
          <th>Title</th>
          <th class="col-type">Type</th>
          {libraryNames ? <th class="hide-sm col-shelf">Shelf</th> : null}
          <th class="hide-sm col-year">Year</th>
          <th class="hide-sm col-completed">Completed</th>
          <th class="col-rating">Rating</th>
          <th class="col-status">Status</th>
          <th class="col-holding">Holding</th>
          {tagsMap ? <th class="hide-sm col-tags">Tags</th> : null}
          <th class="hide-sm col-acc">№</th>
        </tr>
      </thead>
      <tbody>
        {items.map((item) => (
          <tr>
            <td>
              <span class="cell-title">
                {item.coverKey ? (
                  <img class="thumb" src={`/covers/${item.coverKey}`} alt="" loading="lazy" data-fallback={MEDIA_ICON[item.mediaType]} />
                ) : (
                  <span class="thumb-fallback" aria-hidden="true">
                    {MEDIA_ICON[item.mediaType]}
                  </span>
                )}
                <span class="t">
                  <a href={`/items/${item.id}`} title={item.title}>
                    {item.title}
                  </a>
                  {item.creators ? <small>{item.creators}</small> : null}
                </span>
              </span>
            </td>
            <td class="num col-type">{MEDIA_LABEL[item.mediaType]}</td>
            {libraryNames ? <td class="num hide-sm col-shelf">{libraryNames.get(item.libraryId) ?? ''}</td> : null}
            <td class="num hide-sm col-year">{yearOf(item.published)}</td>
            <td class="date hide-sm col-completed">
              {item.completedOn ?? <span class="muted">—</span>}
              {/* the last finish, and how many there have been once there's more than one (§16 #41) */}
              {item.readCount > 1 ? <span class="muted read-count" title={`Finished ${item.readCount} times`}> ×{item.readCount}</span> : null}
            </td>
            <td class="col-rating">{item.rating ? <span class="rating">{stars(item.rating)}</span> : <span class="muted">—</span>}</td>
            <td class="col-status">
              <StatusPills item={item} />{' '}
              {onLoanIds?.has(item.id) ? <span class="pill lent">Lent</span> : null}
            </td>
            <td class="col-holding">
              <HoldingPill item={item} />
            </td>
            {tagsMap ? (
              <td class="hide-sm col-tags">
                {(tagsMap.get(item.id) ?? []).slice(0, 3).map((t) => (
                  <a href={`/tags/${encodeURIComponent(t)}`} class="tag">
                    {t}
                  </a>
                ))}
              </td>
            ) : null}
            <td class="hide-sm col-acc">
              <span class="acc-no">{accNo(item.id)}</span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);

export const Stat: FC<{ n: number | string; label: string; warn?: boolean; detail?: string }> = ({
  n,
  label,
  warn,
  detail,
}) => (
  <div class="stat">
    <div class={warn ? 'stat-n warn' : 'stat-n'}>{n}</div>
    <div class="stat-label">{label}</div>
    {detail ? <div class="stat-detail">{detail}</div> : null}
  </div>
);

const RatingSelect: FC<{ value: number | null | undefined }> = ({ value }) => (
  <select name="rating">
    <option value="" selected={!value}>
      No rating
    </option>
    {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => (
      <option value={String(n)} selected={value === n}>
        {stars(n)} ({n / 2})
      </option>
    ))}
  </select>
);

/**
 * Shared by manual add and edit. Its status, dates, rating and review are the person filling it in's own (§16 #43):
 * `item` carries theirs, not the household's. `perMember` — a household of more than one — says so on the labels.
 */
export const ItemForm: FC<{
  libraries: Library[];
  action: string;
  submitLabel: string;
  item?: Item | null;
  tags?: string[];
  selectedLibraryId?: number;
  error?: string;
  // what a refused form sends back, so nothing typed is lost
  coverUrl?: string;
  removeCover?: boolean;
  perMember?: boolean;
}> = ({ libraries, action, submitLabel, item, tags, selectedLibraryId, error, coverUrl, removeCover, perMember }) => {
  // a book being read again: status and dates describe its last finish, and the re-read is managed on its page
  const readingLocked = item?.mediaType === 'book' && !!item?.rereading;
  // A book finished before: the form edits that finish, so it offers Completed only — reading it again, or a stop, is
  // done on its page (the route refuses the rest). A book with reads can't be made not started from here either. The
  // status the form was sent with is always offered, so a refused form shows what was chosen.
  const shown = item?.status ?? 'not_started';
  const finishedBook = item?.mediaType === 'book' && (item?.readCount ?? 0) > 0;
  const offered = (st: ItemStatus) =>
    st === shown || (finishedBook ? st === 'completed' : st !== 'not_started' || shown === 'not_started' || item?.mediaType !== 'book');
  // reviewed_in gets its own field; the advanced JSON box shows everything else
  const details = parseDetails(item?.details);
  const reviewedIn = Array.isArray(details['reviewed_in']) ? (details['reviewed_in'] as string[]) : [];
  delete details['reviewed_in'];
  return (
  <form method="post" action={action} class="form-card">
    {error ? <p class="error">{error}</p> : null}
    <div class="grid">
      <label>
        Shelf
        <select name="libraryId" required>
          {libraries.map((l) => (
            <option value={String(l.id)} selected={(item?.libraryId ?? selectedLibraryId) === l.id}>
              {l.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        Type
        <select name="mediaType">
          {MEDIA_TYPES.map((t) => (
            <option value={t} selected={(item?.mediaType ?? 'book') === t}>
              {MEDIA_LABEL[t]}
            </option>
          ))}
        </select>
      </label>
    </div>
    <label>
      Title
      <input name="title" required value={item?.title ?? ''} />
    </label>
    <label>
      Creators <small>(authors / designers / artists)</small>
      <input name="creators" value={item?.creators ?? ''} />
    </label>
    <div class="grid">
      <label>
        ISBN-13 / EAN
        <input name="isbn13" value={item?.isbn13 ?? ''} inputmode="numeric" />
      </label>
      <label>
        ISBN-10 / UPC
        <input name="isbn10Upc" value={item?.isbn10Upc ?? ''} />
      </label>
    </div>
    <div class="grid">
      <label>
        Publisher / label
        <input name="publisher" value={item?.publisher ?? ''} />
      </label>
      <label>
        Published
        <input name="published" value={item?.published ?? ''} placeholder="2019 or 2019-05-01" />
      </label>
      <label>
        Length <small>(pages / minutes / tracks)</small>
        <input name="length" value={item?.length?.toString() ?? ''} inputmode="numeric" />
      </label>
    </div>
    <label>
      Description
      <textarea name="description" rows={4}>
        {item?.description ?? ''}
      </textarea>
    </label>
    <div class="grid">
      <label>
        {perMember ? 'Your status' : 'Status'}
        <select name="status" disabled={readingLocked}>
          {/* only what a read can become from here (`offered`, §16 #41) */}
          {ITEM_STATUSES.filter(offered).map((st) => (
            <option value={st} selected={(item?.status ?? 'not_started') === st}>
              {STATUS_LABEL[st]}
            </option>
          ))}
        </select>
      </label>
      <label>
        {perMember ? 'Your rating' : 'Rating'}
        <RatingSelect value={item?.rating} />
      </label>
      <label>
        Copies <small>(0 = not owned)</small>
        <input name="copies" value={item?.copies?.toString() ?? '1'} inputmode="numeric" />
      </label>
    </div>
    <div class="grid">
      <label>
        Began
        <input type="date" name="beganOn" value={item?.beganOn ?? ''} disabled={readingLocked} />
      </label>
      <label>
        Completed
        {/* an open read has no end: the date shown for a book in progress is always blank */}
        <input type="date" name="completedOn" value={item?.status === 'in_progress' ? '' : (item?.completedOn ?? '')} disabled={readingLocked} />
      </label>
    </div>
    {finishedBook && !readingLocked ? (
      <p class="muted form-note">
        Finished before: these are its last finished read's. To read it again, or to record a read you stopped, use the
        book's page.
      </p>
    ) : null}
    {readingLocked ? (
      <p class="muted form-note">
        Being read again now: these are its last finished read's, kept as they are. Every read — this one too — is
        started, finished, stopped and corrected on the book's page.
      </p>
    ) : null}
    {perMember ? (
      <p class="muted form-note">
        Status, dates, rating and review here are yours; everyone's show on the item's page.
      </p>
    ) : null}
    <label>
      Tags <small>(comma-separated)</small>
      <input name="tags" value={tags?.join(', ') ?? ''} />
    </label>
    <label>
      {perMember ? 'Your review' : 'Review'}
      <textarea name="review" rows={3}>
        {item?.review ?? ''}
      </textarea>
    </label>
    <label>
      Reviewed in <small>(blog post URLs, one per line — linked from share pages too)</small>
      <textarea name="reviewedIn" rows={2}>
        {reviewedIn.join('\n')}
      </textarea>
    </label>
    <label>
      Private notes <small>(never shown on share pages)</small>
      <textarea name="notes" rows={3}>
        {item?.notes ?? ''}
      </textarea>
    </label>
    <label>
      Cover image URL <small>(fetched once into storage on save)</small>
      <input name="coverUrl" placeholder="https://…" value={coverUrl ?? ''} />
    </label>
    {item?.coverKey ? (
      <label>
        <input type="checkbox" name="removeCover" value="1" checked={!!removeCover} /> Remove current cover
      </label>
    ) : null}
    <details>
      <summary>Advanced: details JSON</summary>
      <textarea name="details" rows={3}>
        {JSON.stringify(details)}
      </textarea>
    </details>
    <button type="submit">{submitLabel}</button>
  </form>
  );
};

/** A lookup result with a one-click "add to shelf" form. */
export const CandidateCard: FC<{ candidate: Candidate; libraries: Library[] }> = ({ candidate, libraries }) => (
  <article class="candidate">
    <div class="candidate-cover">
      {candidate.coverUrl ? (
        <img src={candidate.coverUrl} alt="" loading="lazy" data-fallback={MEDIA_ICON[candidate.mediaType]} />
      ) : (
        <div class="cover-fallback">{MEDIA_ICON[candidate.mediaType]}</div>
      )}
    </div>
    <div class="candidate-body">
      <strong>{candidate.title}</strong>
      {candidate.creators ? <div>{candidate.creators}</div> : null}
      <small class="muted">
        {MEDIA_LABEL[candidate.mediaType]}
        {candidate.published ? ` · ${candidate.published}` : ''}
        {candidate.publisher ? ` · ${candidate.publisher}` : ''}
        {' · via '}
        {candidate.provider}
      </small>
      <form method="post" action="/items" class="candidate-save">
        <input type="hidden" name="mediaType" value={candidate.mediaType} />
        <input type="hidden" name="title" value={candidate.title} />
        <input type="hidden" name="creators" value={candidate.creators ?? ''} />
        <input type="hidden" name="publisher" value={candidate.publisher ?? ''} />
        <input type="hidden" name="published" value={candidate.published ?? ''} />
        <input type="hidden" name="description" value={candidate.description ?? ''} />
        <input type="hidden" name="length" value={candidate.length?.toString() ?? ''} />
        <input type="hidden" name="isbn13" value={candidate.isbn13 ?? ''} />
        <input type="hidden" name="isbn10Upc" value={candidate.isbn10Upc ?? ''} />
        <input type="hidden" name="coverUrl" value={candidate.coverUrl ?? ''} />
        <input type="hidden" name="details" value={JSON.stringify(candidate.details)} />
        <select name="libraryId" aria-label="Shelf">
          {libraries.map((l) => (
            <option value={String(l.id)}>{l.name}</option>
          ))}
        </select>
        <button type="submit">Add to shelf</button>
        <button type="submit" name="logOnly" value="1" class="btn" title="Catalog as read/reviewed without owning a copy — opens the edit form for your rating and review">
          Log — not owned
        </button>
      </form>
    </div>
  </article>
);

export const Pagination: FC<{ page: number; pages: number; makeHref: (page: number) => string }> = ({
  page,
  pages,
  makeHref,
}) =>
  pages > 1 ? (
    <nav class="pagination">
      {page > 1 ? <a href={makeHref(page - 1)}>← Prev</a> : <span />}
      <span class="muted">
        {page} / {pages}
      </span>
      {page < pages ? <a href={makeHref(page + 1)}>Next →</a> : <span />}
    </nav>
  ) : null;

/** Human labels for well-known details keys (per-media conventions, ARCH.md §5). */
export const DETAIL_LABELS: Record<string, string> = {
  reviewed_in: 'Reviewed in',
  bgg_id: 'BGG ID',
  players_min: 'Min players',
  players_max: 'Max players',
  playtime_min: 'Min playtime',
  playtime_max: 'Max playtime',
  discogs_id: 'Discogs ID',
  format: 'Format',
  label: 'Label',
  catno: 'Catalog #',
  year: 'Year',
  genres: 'Genres',
  subtitle: 'Subtitle',
  series: 'Series',
};

const isUrl = (v: unknown): v is string => typeof v === 'string' && /^https?:\/\//.test(v);

/**
 * Details values render as text, except URLs (e.g. reviewed_in), which link out — but only for this
 * household's own details. Another household's are text: a link on a page inside this app carries this
 * app's trust, and a connection could plant any URL it liked.
 */
const DetailValue: FC<{ value: unknown; links: boolean }> = ({ value, links }) => (
  <>
    {(Array.isArray(value) ? value : [value]).map((p, i) => (
      <>
        {i > 0 ? ', ' : ''}
        {links && isUrl(p) ? (
          <a href={p} rel="noopener noreferrer">
            {p.replace(/^https?:\/\//, '')}
          </a>
        ) : (
          String(p)
        )}
      </>
    ))}
  </>
);

export const DetailsList: FC<{ details: Record<string, unknown>; fromConnection?: boolean }> = ({ details, fromConnection }) => {
  const entries = Object.entries(details).filter(([, v]) => v !== null && v !== undefined && v !== '');
  if (!entries.length) return null;
  return (
    <dl class="details-list">
      {entries.map(([k, v]) => (
        <>
          <dt>{DETAIL_LABELS[k] ?? k.replaceAll('_', ' ')}</dt>
          <dd>
            <DetailValue value={v} links={!fromConnection} />
          </dd>
        </>
      ))}
    </dl>
  );
};
