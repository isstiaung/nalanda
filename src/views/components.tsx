import type { FC } from 'hono/jsx';
import type { PastLoan } from '../db/queries';
import type { Item, ItemStatus, Library, MediaType, Share } from '../db/schema';
import { ITEM_STATUSES, MEDIA_GRADES, MEDIA_TYPES, SLEEVE_GRADES } from '../db/schema';
import { GRADE_NAME, isRecord } from '../lib/condition';
import { releaseIdOf, splitPressing, trackCount, type Track } from '../lib/pressing';
import { goalPace, goalPercent, paceLabel, pacePercent } from '../lib/goals';
import { currencyDigits, formatCount, formatMoney, isStoredPrice, minorToDecimal, type CurrencyTotal } from '../lib/money';
import { progressPercent } from '../lib/progress';
import { linkHost } from '../lib/links';
import { isPlayable, playDate } from '../lib/plays';
import { latestReadDate, ordinal, summarizeReads, todayUtc, type ReadDraft, type ReadRow } from '../lib/reads';
import { formatSeriesNumber } from '../lib/series';
import { parseDetails } from '../lib/share';
import type { Candidate } from '../metadata';
import { DiscogsAttribution, DiscogsCredit, discogsLink, discogsUrl } from './attribution';

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

/**
 * "Board games · In progress · Owned" — how a share view's captured filters read. A gift list reads as its member's
 * want list: `wantOf` is their username, for the admin's own pages inside the app — never a public one.
 */
export function shareScopeLabel(v: Share, wantOf?: string | null): string {
  if (v.wantUserId !== null) return `Want list · ${wantOf ?? 'a member'}`;
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

/** A refused form's fields point at the message that says why (aria-describedby), and are marked invalid. */
export const invalid = (error: string | undefined | false, id: string) =>
  error ? { 'aria-invalid': 'true' as const, 'aria-describedby': id } : {};

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

/** Someone in the household wants it, and it isn't owned (§16 #53): beside "Not owned", never saying whose want. */
export const WantedPill: FC = () => <span class="pill wanted">Wanted</span>;

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

/**
 * Finish (on a date) and Stop for an open read — the reader's own, or, for an admin, anyone's (§16 #43): the routes
 * allow both to them, so the page offers both. Each form's own action is primary; Stop is secondary.
 */
const CloseReadForms: FC<{ item: Item; read: ReadingRead; today: string; rereading: boolean }> = ({ item, read, today, rereading }) => {
  const base = `/items/${item.id}`;
  return (
    <>
      <form method="post" action={`${base}/reads/${read.id}/finish`} class="inline-form" {...htmxTo(`${base}/reads/${read.id}/finish`)}>
        <input type="date" name="date" value={today} aria-label="Finished on" class="mono" />
        <button type="submit">Finish</button>
      </form>
      <form method="post" action={`${base}/reads/${read.id}/stop`} class="inline-form" {...htmxTo(`${base}/reads/${read.id}/stop`)}>
        <button type="submit" class="btn">
          {rereading ? 'Stop re-reading' : 'Stop reading'}
        </button>
      </form>
    </>
  );
};

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
      <div class="progress-track" aria-hidden="true">
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
          {/* the id: htmx puts focus back on the page field after the section swaps (anything else, app.js) */}
          <input id="reading-page" name="page" inputmode="numeric" pattern="[0-9]+" class="mono" size={6} placeholder="Page" aria-label="Page reached" required />
          {item.length ? <span class="muted">of {item.length}</span> : null}
          {/* each form's own action is primary (a plain submit); Stop is secondary (.btn), Delete a danger action */}
          <button type="submit">Record</button>
        </form>
      ) : null}

      {error ? (
        <p class="error" role="alert">
          {error}
        </p>
      ) : null}

      <PageLog item={item} entries={me.current} removable={true} />

      <div class="read-actions">
        {open ? (
          <CloseReadForms item={item} read={open} today={today} rereading={me.state.rereading} />
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
            {/* an admin can take out a mistyped page of anyone's, and finish or stop their read; everyone else just sees */}
            {editable ? <PageLog item={item} entries={them.current} removable={true} /> : null}
            {editable && them.open ? (
              <div class="read-actions">
                <CloseReadForms item={item} read={them.open} today={today} rereading={them.state.rereading} />
              </div>
            ) : null}
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
      {error ? (
        <p class="error" role="alert">
          {error}
        </p>
      ) : null}
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
            {them.open && (viewer.admin || id === viewer.id) ? (
              <div class="read-actions">
                <CloseReadForms item={item} read={them.open} today={todayUtc()} rereading={them.state.rereading} />
              </div>
            ) : null}
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

// ---------- plays (ARCH.md §16 #54) ----------

type PlayLine = { id: number; playedOn: string; loggedBy: number | null };

/**
 * Plays as a list, newest first: each date, who logged it (for an admin, once the household has more than one member —
 * the logger is kept for auditing, not shown as anyone's history), and Remove for whoever may: the play's logger, or an
 * admin. `year` drops the year from dates in it, under a year heading; otherwise it shows only outside `today`'s.
 * `htmx` swaps the item page's Plays section on a removal; without it, the form posts and comes back to `back`.
 */
const PlayList: FC<{ item: Item; plays: PlayLine[]; today: string; viewer: Viewer; people: Person[]; back?: string }> = ({
  item,
  plays,
  today,
  viewer,
  people,
  back,
}) => {
  const base = `/items/${item.id}`;
  const showLogger = viewer.admin && people.length > 1;
  return (
    <ol class="play-log">
      {plays.map((p) => {
        const when = playDate(p.playedOn, today);
        const action = `${base}/plays/${p.id}/delete${back ? `?back=${encodeURIComponent(back)}` : ''}`;
        return (
          <li>
            <time class="mono" datetime={p.playedOn}>
              {when}
            </time>
            {showLogger ? <span class="muted play-by">{p.loggedBy === viewer.id ? 'you' : personName(people, p.loggedBy)}</span> : null}
            {viewer.admin || (p.loggedBy !== null && p.loggedBy === viewer.id) ? (
              <form method="post" action={action} {...(back ? {} : { 'hx-post': action, 'hx-target': '#plays', 'hx-swap': 'outerHTML' })}>
                <button type="submit" class="progress-delete" aria-label={`Remove the play of ${when}`}>
                  Remove
                </button>
              </form>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
};

/**
 * A board game's play log or a record's listening log (§16 #54): how many times the household has played it and when
 * last, "Played" — today, or on the date picked beside it — and the most recent plays. A play is the household's, so
 * there is one count and one list, whoever pressed the button. Swaps itself on every change. An item of another type
 * that has plays (its type changed since) keeps the list, so they can still be seen and removed, but gets no button.
 */
export const PlaysSection: FC<{ item: Item; count: number; plays: PlayLine[]; today: string; viewer: Viewer; people: Person[]; error?: string }> = ({
  item,
  count,
  plays,
  today,
  viewer,
  people,
  error,
}) => {
  const base = `/items/${item.id}`;
  const last = plays[0];
  return (
    <div class="detail-section" id="plays">
      <p class="eyebrow">{item.mediaType === 'vinyl' ? 'Listening log' : 'Play log'}</p>
      {count && last ? (
        <p class="reading-summary">
          {/* the figure in mono, as every count; the words in the running text */}
          Played{' '}
          {count === 1 ? (
            'once'
          ) : (
            <>
              <span class="mono">{count}</span> times
            </>
          )}{' '}
          · last on{' '}
          <time class="mono" datetime={last.playedOn}>
            {playDate(last.playedOn, today)}
          </time>
        </p>
      ) : (
        <p class="reading-summary muted">Not played yet.</p>
      )}
      {error ? <p class="error" role="alert">{error}</p> : null}
      {isPlayable(item.mediaType) ? (
        // pressing Played sends today's date, already in the field; picking another logs that day instead
        <form method="post" action={`${base}/plays`} class="inline-form play-form" hx-post={`${base}/plays`} hx-target="#plays" hx-swap="outerHTML" hx-disabled-elt="find button">
          <button type="submit">Played</button>
          <label>
            <span class="muted">on</span>
            <input type="date" name="date" value={today} max={latestReadDate()} aria-label="Played on" class="mono" required />
          </label>
        </form>
      ) : null}
      {plays.length ? <PlayList item={item} plays={plays} today={today} viewer={viewer} people={people} /> : null}
      {count > plays.length ? (
        <p class="play-more">
          <a href={`${base}/plays`}>All {count} plays</a>
        </p>
      ) : null}
    </div>
  );
};

/** Every play of an item, a page at a time, under a heading per year — the plays page, where any play can be removed. */
export const AllPlays: FC<{ item: Item; plays: PlayLine[]; viewer: Viewer; people: Person[]; page: number }> = ({ item, plays, viewer, people, page }) => {
  const years: Array<{ year: string; plays: PlayLine[] }> = [];
  for (const p of plays) {
    const year = p.playedOn.slice(0, 4);
    const group = years.at(-1);
    if (group && group.year === year) group.plays.push(p);
    else years.push({ year, plays: [p] });
  }
  const back = page > 1 ? `plays?page=${page}` : 'plays';
  return (
    <div id="plays">
      {years.map((g) => (
        <div class="detail-section">
          <p class="eyebrow mono">{g.year}</p>
          {/* a date in its own year's list needs no year */}
          <PlayList item={item} plays={g.plays} today={`${g.year}-01-01`} viewer={viewer} people={people} back={back} />
        </div>
      ))}
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
            const mine = r.userId === viewer.id;
            return (
              <li>
                <p class="review-by">
                  {/* as the Reading section names its readers: "You", in the accent, then the username */}
                  <span class={mine ? 'reviewer reviewer-self' : 'reviewer'}>
                    {mine ? (
                      <>
                        You <span class="muted">· {personName(people, r.userId)}</span>
                      </>
                    ) : (
                      personName(people, r.userId)
                    )}
                  </span>
                  {r.rating ? <span class="rating">{stars(r.rating)}</span> : null}
                  {r.reviewedAt ? <span class="mono muted">{r.reviewedAt.slice(0, 10)}</span> : null}
                </p>
                {r.review ? <p class="prewrap">{r.review}</p> : null}
                {editable ? (
                  <details class="read-edit">
                    <summary>Edit</summary>
                    <form method="post" action={`${base}/reviews/${r.id}`} class="review-form">
                      <RatingSelect value={r.rating} label="Rating" />
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
    id={`holding-${id}`}
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
    id={`holding-${id}`}
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

/** A plain calendar day as UTC milliseconds, or null — "2026-02-30" too, which Date.UTC would roll into March. */
function utcDay(value: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return null;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return new Date(t).toISOString().slice(0, 10) === value ? t : null;
}

/** Whole days from lending to return — 0 for a book back the same day — or null when a date isn't a plain day. */
export function loanDays(loanedOn: string, returnedOn: string): number | null {
  const [a, b] = [utcDay(loanedOn), utcDay(returnedOn)];
  if (a === null || b === null) return null;
  const days = Math.round((b - a) / 86_400_000);
  return days >= 0 ? days : null;
}

const loanLength = (days: number | null) => (days === null ? '—' : days === 0 ? 'same day' : days === 1 ? '1 day' : `${days} days`);

/** A past loan's borrower: "household (their member)" for a loan to a connection, else as it was lent. */
const pastBorrower = (l: PastLoan) => (l.household && l.member ? `${l.household} (${l.member})` : l.borrower);

/**
 * "Lent before" on an item's page: its returned loans, newest first, the longest history cut to its latest few
 * with the rest counted. Loans still out stay in the Circulation box above. Nothing at all without a past loan.
 * In-app only: loans and borrowers are never on share pages or sent to connections (ARCH.md §9).
 */
export const LendingHistory: FC<{ loans: PastLoan[]; total: number }> = ({ loans, total }) => {
  if (!loans.length) return null;
  const earlier = total - loans.length;
  return (
    <div class="detail-section lending-history">
      <p class="eyebrow">Lent before</p>
      <ol class="loan-history">
        {loans.map((l) => (
          <li>
            <strong>{pastBorrower(l)}</strong>
            <span class="mono">
              {l.loanedOn} → {l.returnedOn}
            </span>
            <span class="mono muted">{loanLength(loanDays(l.loanedOn, l.returnedOn))}</span>
          </li>
        ))}
      </ol>
      {earlier > 0 ? <p class="muted loan-history-more">and {earlier} earlier</p> : null}
    </div>
  );
};

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

export const ItemCard: FC<{ item: Item; onLoan?: boolean; href?: string; wanted?: boolean }> = ({ item, onLoan, href, wanted }) => (
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
        {item.copies === 0 && wanted ? <WantedPill /> : null}
        {onLoan ? <span class="pill lent">Lent</span> : null}
      </span>
    </div>
  </a>
);

/**
 * The Overview's "Read next" card (ARCH.md §16 #46): one book the signed-in member hasn't finished and isn't reading,
 * or a line saying there's none. "Start reading" is the book page's own start route, posted without htmx, so it opens
 * the member's read and lands on the book. "Another" asks the Overview for a new pick without this one; htmx swaps the
 * card inside #read-next, and puts focus back on the new "Another" by its id. Without htmx it reloads the Overview.
 */
export const ReadNextCard: FC<{ pick: (Pick<Item, 'id' | 'title' | 'creators' | 'coverKey' | 'copies' | 'mediaType'> & { wanted?: boolean }) | null }> = ({
  pick,
}) =>
  pick ? (
    <div class="panel read-next">
      {/* the title below is the link a reader or keyboard uses; the cover is a second, larger target for a pointer */}
      <a href={`/items/${pick.id}`} class="read-next-cover" tabindex={-1} aria-hidden="true">
        <Cover coverKey={pick.coverKey} title={pick.title} mediaType={pick.mediaType} />
      </a>
      <div class="read-next-body">
        <a href={`/items/${pick.id}`} class="read-next-title">
          {pick.title}
        </a>
        {pick.creators ? <p class="read-next-by">{pick.creators}</p> : null}
        <p class="read-next-line">
          <small class="acc-no">{accNo(pick.id)}</small>
          {pick.copies === 0 ? <NotOwnedPill /> : null}
          {pick.copies === 0 && pick.wanted ? <WantedPill /> : null}
        </p>
        <div class="read-actions">
          <form method="post" action={`/items/${pick.id}/reads/start`}>
            <button type="submit">Start reading</button>
          </form>
          <form method="get" action="/" hx-get="/" hx-target="#read-next" hx-swap="innerHTML">
            <input type="hidden" name="not" value={String(pick.id)} />
            <button type="submit" class="btn" id="read-next-another">
              Another
            </button>
          </form>
        </div>
      </div>
    </div>
  ) : (
    <p class="muted read-next-empty">Nothing to suggest: you’ve finished or are reading every book in the catalog.</p>
  );

/**
 * The covers view. `selectable` gives each card a checkbox for bulk edit (§16 #47), beside the card's link rather than
 * inside it — an input inside an <a> is invalid HTML — and a "select all on this page" line above the grid.
 */
export const ItemGrid: FC<{ items: Item[]; onLoanIds?: Set<number>; wantedIds?: Set<number>; selectable?: boolean }> = ({
  items,
  onLoanIds,
  wantedIds,
  selectable,
}) =>
  selectable ? (
    <>
      <PickAll label />
      <div class="item-grid">
        {items.map((item) => (
          <div class="pick-cell">
            <ItemCard item={item} onLoan={onLoanIds?.has(item.id)} wanted={wantedIds?.has(item.id)} />
            {/* the label is the bigger tap target; its words are the ones the box is named by */}
            <label class="pick">
              <PickBox id={item.id} title={item.title} />
              <span class="sr-only">Select {item.title}</span>
            </label>
          </div>
        ))}
      </div>
    </>
  ) : (
    <div class="item-grid">
      {items.map((item) => (
        <ItemCard item={item} onLoan={onLoanIds?.has(item.id)} wanted={wantedIds?.has(item.id)} />
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

// ---- bulk edit's selection (ARCH.md §16 #47; the bar itself is in views/bulk.tsx) ----

/** The id of the bar's form, which every checkbox names. */
export const BULK_FORM = 'bulk';

/** One item's checkbox. */
export const PickBox: FC<{ id: number; title: string }> = ({ id, title }) => (
  <input type="checkbox" class="bulk-pick" name="id" value={String(id)} form={BULK_FORM} aria-label={`Select ${title}`} />
);

/** Select all on this page. It needs JavaScript, so it stays hidden until app.js shows it. */
export const PickAll: FC<{ label?: boolean }> = ({ label }) =>
  label ? (
    <label class="bulk-all" hidden>
      <input type="checkbox" data-bulk-all />
      Select all on this page
    </label>
  ) : (
    <input type="checkbox" data-bulk-all aria-label="Select all on this page" hidden />
  );

/** The default library view: a proper registry table. */
export const ItemTable: FC<{
  items: Item[];
  onLoanIds?: Set<number>;
  wantedIds?: Set<number>;
  tagsMap?: Map<number, string[]>;
  libraryNames?: Map<number, string>;
  /** A checkbox per row, and select-all in the header, for bulk edit (§16 #47). */
  selectable?: boolean;
}> = ({ items, onLoanIds, wantedIds, tagsMap, libraryNames, selectable }) => (
  <div class="data-table">
    <table>
      <thead>
        <tr>
          {selectable ? (
            <th class="col-pick">
              <PickAll />
            </th>
          ) : null}
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
            {selectable ? (
              <td class="col-pick">
                <PickBox id={item.id} title={item.title} />
              </td>
            ) : null}
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
              {item.copies === 0 && wantedIds?.has(item.id) ? (
                <>
                  {' '}
                  <WantedPill />
                </>
              ) : null}
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

/**
 * A reading goal where it stands (§16 #49): "14 of 24", its pace — on track, N behind, reached — and a bar with a tick
 * where linear pace stands today. Counts are the registrar's voice, so monospace; the pace is a pill.
 */
export const GoalMeter: FC<{ count: number; target: number; year: number; today: string }> = ({ count, target, year, today }) => {
  const pace = goalPace(count, target, year, today);
  const tick = pace.state === 'reached' ? null : pacePercent(year, today);
  const pill = pace.state === 'reached' ? 'pill reached' : pace.state === 'on_track' ? 'pill done' : pace.state === 'behind' ? 'pill behind' : 'pill';
  return (
    <div class="goal-meter">
      <p class="goal-line">
        <span class="goal-count">
          {count} of {target}
        </span>{' '}
        <span class="muted mono">{target === 1 ? 'book' : 'books'}</span> <span class={pill}>{paceLabel(pace)}</span>
      </p>
      {/* the count and the pace are in words just above */}
      <div class="goal-track" aria-hidden="true">
        <div class="progress-track">
          <div class="progress-fill" style={`width:${goalPercent(count, target)}%`} />
        </div>
        {tick !== null ? <span class="goal-pace" style={`left:${tick}%`} title="Where an even pace would be today" /> : null}
      </div>
    </div>
  );
};

export const Stat: FC<{ n: number | string; label: string; warn?: boolean; detail?: string }> = ({
  n,
  label,
  warn,
  detail,
}) => (
  <div class="stat">
    <div class={warn ? 'stat-n warn' : 'stat-n'}>{typeof n === 'number' ? formatCount(n) : n}</div>
    <div class="stat-label">{label}</div>
    {detail ? <div class="stat-detail">{detail}</div> : null}
  </div>
);

/** `label` names it where no <label> wraps it (a review's own Edit form). */
const RatingSelect: FC<{ value: number | null | undefined; label?: string }> = ({ value, label }) => (
  <select name="rating" aria-label={label}>
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
  // the item's series as the form shows it — typed text, so a refused form gives back what was sent (§16 #52)
  series?: { name: string; number: string } | null;
  // every series' name, offered as the series field is typed
  seriesNames?: string[];
  // the purchase price field (§16 #61): the household's currency (null: none set yet) and whether the viewer can set one
  money?: PriceFieldProps;
}> = ({ libraries, action, submitLabel, item, tags, selectedLibraryId, error, coverUrl, removeCover, perMember, series, seriesNames, money }) => {
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
    {/* the form refuses only a read that doesn't add up: status and dates point at the reason */}
    {error ? (
      <p class="error" role="alert" id="item-form-error">
        {error}
      </p>
    ) : null}
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
    <div class="grid series-fields">
      <label>
        Series <small>(optional)</small>
        <input name="seriesName" value={series?.name ?? ''} list="series-names" autocomplete="off" placeholder="The Expanse" />
      </label>
      <label>
        Number in series
        <input
          name="seriesNumber"
          value={series?.number ?? ''}
          inputmode="decimal"
          pattern="#?\s*\d{1,4}(\.\d{1,2})?"
          title="A number: 3, or 2.5 for a book between two others"
          placeholder="3"
        />
      </label>
    </div>
    {seriesNames?.length ? (
      <datalist id="series-names">
        {seriesNames.map((n) => (
          <option value={n} />
        ))}
      </datalist>
    ) : null}
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
        <select name="status" disabled={readingLocked} {...invalid(error, 'item-form-error')}>
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
        <input type="date" name="beganOn" value={item?.beganOn ?? ''} disabled={readingLocked} {...invalid(error, 'item-form-error')} />
      </label>
      <label>
        Completed
        {/* an open read has no end: the date shown for a book in progress is always blank */}
        <input
          type="date"
          name="completedOn"
          value={item?.status === 'in_progress' ? '' : (item?.completedOn ?? '')}
          disabled={readingLocked}
          {...invalid(error, 'item-form-error')}
        />
      </label>
    </div>
    {finishedBook && !readingLocked ? (
      <p class="muted form-note">
        Finished before: these are the dates of its last finished read. To read it again, or to record a read you
        stopped, use the book's page.
      </p>
    ) : null}
    {readingLocked ? (
      <p class="muted form-note">
        Being read again now: these are the dates of its last finished read, kept as they are. Every read — this one
        too — is started, finished, stopped and corrected on the book's page.
      </p>
    ) : null}
    {perMember ? (
      <p class="muted form-note">
        Status, dates, rating and review here are yours; everyone's show on the item's page.
      </p>
    ) : null}
    {isRecord(item?.mediaType) ? <GradeFields media={item?.mediaCondition ?? null} sleeve={item?.sleeveCondition ?? null} /> : null}
    <label>
      Tags <small>(comma-separated)</small>
      <input name="tags" value={tags?.join(', ') ?? ''} />
    </label>
    <label>
      Location <small>(where it lives — never shown on share pages)</small>
      <input name="location" value={item?.location ?? ''} placeholder="Study, 2nd shelf" autocomplete="off" />
    </label>
    {money ? <PriceField {...money} item={item} /> : null}
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
      <textarea name="details" rows={3} aria-label="Details JSON">
        {JSON.stringify(details)}
      </textarea>
    </details>
    <button type="submit">{submitLabel}</button>
  </form>
  );
};

/** What a candidate's save form posts to POST /items: its details as the provider gave them. */
const CandidateFields: FC<{ candidate: Candidate }> = ({ candidate }) => (
  <>
    <input type="hidden" name="mediaType" value={candidate.mediaType} />
    <input type="hidden" name="title" value={candidate.title} />
    <input type="hidden" name="creators" value={candidate.creators ?? ''} />
    <input type="hidden" name="publisher" value={candidate.publisher ?? ''} />
    <input type="hidden" name="published" value={candidate.published ?? ''} />
    <input type="hidden" name="description" value={candidate.description ?? ''} />
    <input type="hidden" name="length" value={candidate.length?.toString() ?? ''} />
    <input type="hidden" name="isbn13" value={candidate.isbn13 ?? ''} />
    <input type="hidden" name="isbn10Upc" value={candidate.isbn10Upc ?? ''} />
    <input type="hidden" name="seriesName" value={candidate.series?.name ?? ''} />
    <input type="hidden" name="seriesNumber" value={candidate.series?.number != null ? formatSeriesNumber(candidate.series.number) : ''} />
    <input type="hidden" name="coverUrl" value={candidate.coverUrl ?? ''} />
    <input type="hidden" name="details" value={JSON.stringify(candidate.details)} />
    {/* a Discogs result's release is fetched once on save, for its tracklist and full pressing (§16 #55) */}
    {candidate.provider === 'discogs' ? <input type="hidden" name="source" value="discogs" /> : null}
  </>
);

const ShelfSelect: FC<{ libraries: Library[] }> = ({ libraries }) => (
  <select name="libraryId" aria-label="Shelf">
    {libraries.map((l) => (
      <option value={String(l.id)}>{l.name}</option>
    ))}
  </select>
);

const CandidateCover: FC<{ candidate: Candidate }> = ({ candidate }) => (
  <div class="candidate-cover">
    {candidate.coverUrl ? (
      <img src={candidate.coverUrl} alt="" loading="lazy" data-fallback={MEDIA_ICON[candidate.mediaType]} />
    ) : (
      <div class="cover-fallback">{MEDIA_ICON[candidate.mediaType]}</div>
    )}
  </div>
);

/** A metadata source as people know it — "Open Library", not the provider's id; a merged result names both. */
const PROVIDER_NAMES: Record<string, string> = {
  openlibrary: 'Open Library',
  googlebooks: 'Google Books',
  bgg: 'BoardGameGeek',
  discogs: 'Discogs',
};
const providerName = (id: string): string =>
  id
    .split('+')
    .map((p) => PROVIDER_NAMES[p] ?? p)
    .join(' + ');

const CandidateSummary: FC<{ candidate: Candidate }> = ({ candidate }) => (
  <>
    <strong>{candidate.title}</strong>
    {candidate.creators ? <div>{candidate.creators}</div> : null}
    <small class="muted">
      {MEDIA_LABEL[candidate.mediaType]}
      {candidate.published ? ` · ${candidate.published}` : ''}
      {candidate.publisher ? ` · ${candidate.publisher}` : ''}
      {' · via '}
      {providerName(candidate.provider)}
    </small>
    {/* §16 #63: Discogs' data carries its credit, linked to the release it came from */}
    {candidate.provider === 'discogs' ? (
      <small class="candidate-credit">
        <DiscogsCredit href={discogsUrl(releaseIdOf(candidate.details))} />
      </small>
    ) : null}
    {candidate.series ? (
      <small class="muted candidate-series">
        {candidate.series.name}
        {candidate.series.number !== null ? <span class="mono"> #{formatSeriesNumber(candidate.series.number)}</span> : null}
      </small>
    ) : null}
  </>
);

/** A lookup result with a one-click "add to shelf" form. */
export const CandidateCard: FC<{ candidate: Candidate; libraries: Library[] }> = ({ candidate, libraries }) => (
  <article class="candidate">
    <CandidateCover candidate={candidate} />
    <div class="candidate-body">
      <CandidateSummary candidate={candidate} />
      <form method="post" action="/items" class="candidate-save">
        <CandidateFields candidate={candidate} />
        <ShelfSelect libraries={libraries} />
        <button type="submit">Add to shelf</button>
        <button type="submit" name="logOnly" value="1" class="btn" title="Catalog as read/reviewed without owning a copy — opens the edit form for your rating and review">
          Log — not owned
        </button>
        {/* §16 #53: onto your want list, as "Not owned" — or, when the catalog already has this ISBN, that item */}
        <button
          type="submit"
          name="want"
          value="1"
          class="btn"
          title="Put it on your want list — added as Not owned, or the copy already in the catalog if there is one"
        >
          {wantLabel(candidate.mediaType)}
        </button>
      </form>
    </div>
  </article>
);

/** When the device says a held scan was made: an ISO timestamp in UTC, or it isn't shown. */
export const SCANNED_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?Z$/;

/**
 * One scan held on the device while offline, looked up now that it's back (ARCH.md §16 #48). The Add page's review
 * list shows one per held barcode, and nothing is added until someone presses Add here or "Add all". The form carries
 * `scanOwner`, the stamp of whoever it was rendered for, so POST /items refuses it once someone else is signed in.
 * The scan time shows in UTC until scan-review.js rewrites it in the device's own time.
 */
export const ReviewEntry: FC<{
  barcode: string;
  scannedAt: string | null;
  candidate: Candidate | null;
  notices: string[];
  libraries: Library[];
  scanOwner: string;
}> = ({ barcode, scannedAt, candidate, notices, libraries, scanOwner }) => {
  const drop = (
    <button type="button" class="btn" data-review-drop>
      Drop
    </button>
  );
  return (
    <article class="candidate review-entry" data-barcode={barcode}>
      {candidate ? (
        <CandidateCover candidate={candidate} />
      ) : (
        <div class="candidate-cover">
          <div class="cover-fallback" aria-hidden="true">
            ?
          </div>
        </div>
      )}
      <div class="candidate-body">
        <small class="review-scan">
          {barcode}
          {scannedAt ? (
            <>
              {' · scanned '}
              <time datetime={scannedAt}>{`${scannedAt.slice(0, 16).replace('T', ' ')} UTC`}</time>
            </>
          ) : null}
        </small>
        {candidate ? (
          <>
            <CandidateSummary candidate={candidate} />
            {libraries.length ? (
              <form method="post" action="/items" class="candidate-save" data-review-add>
                <CandidateFields candidate={candidate} />
                <input type="hidden" name="scanOwner" value={scanOwner} />
                <ShelfSelect libraries={libraries} />
                <button type="submit">Add to shelf</button>
                {drop}
              </form>
            ) : (
              <>
                <p class="notice">
                  There's no shelf to add it to yet — make one on the <a href="/">Overview</a> first.
                </p>
                <div class="candidate-save">{drop}</div>
              </>
            )}
          </>
        ) : (
          <>
            <strong>No match</strong>
            {notices.map((n) => (
              <div class="muted">{n}</div>
            ))}
            <div class="candidate-save">
              <button type="button" class="btn" data-review-retry>
                Look up again
              </button>
              {drop}
            </div>
          </>
        )}
      </div>
    </article>
  );
};

/** What POST /items answers the review list with: the entry, now added. */
export const ReviewAdded: FC<{ id: number; title: string; shelf: string }> = ({ id, title, shelf }) => (
  <article class="notice review-entry" data-added>
    Added <a href={`/items/${id}`}>{title}</a> to {shelf}.
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
  playtime_min: 'Min playtime (minutes)',
  playtime_max: 'Max playtime (minutes)',
  weight: 'Weight (1–5)', // BGG's complexity rating (§16 #60)
  discogs_id: 'Discogs ID',
  format: 'Format',
  label: 'Label',
  catno: 'Catalog #',
  country: 'Country',
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

// ---------- a record's condition and pressing (ARCH.md §16 #55) ----------

/**
 * The edit form's grades: media and sleeve, each on Discogs' scale, blank for not graded. Only a record's form has
 * them; the route validates what comes back against the same fixed lists.
 */
export const GradeFields: FC<{ media: string | null; sleeve: string | null }> = ({ media, sleeve }) => (
  <>
    <div class="grid">
      <label>
        Media grade
        <select name="mediaCondition">
          <option value="" selected={!media}>
            Not graded
          </option>
          {MEDIA_GRADES.map((g) => (
            <option value={g} selected={media === g}>
              {GRADE_NAME[g]}
            </option>
          ))}
        </select>
      </label>
      <label>
        Sleeve grade
        <select name="sleeveCondition">
          <option value="" selected={!sleeve}>
            Not graded
          </option>
          {SLEEVE_GRADES.map((g) => (
            <option value={g} selected={sleeve === g}>
              {GRADE_NAME[g]}
            </option>
          ))}
        </select>
      </label>
    </div>
    <p class="muted form-note">Your copy's condition, on the Goldmine scale Discogs uses — never on share pages or to connections.</p>
  </>
);

export type PriceFieldProps = {
  household: string | null;
  admin: boolean;
  item?: Item | null;
  // what a refused form sent, so nothing typed is lost, and why it was refused — tied to the field
  sent?: { amount: string; currency: string };
  error?: string | null;
};

/**
 * What was paid (§16 #61): an amount in a currency the form shows beside it and in its label. The currency is the
 * household's — or, for a price entered before the household changed currency, the one it was entered in, offered
 * beside the household's. With no household currency and no price there is no field, only where to set one: the
 * form never guesses a currency.
 */
export const PriceField: FC<PriceFieldProps> = ({ household, admin, item, sent, error }) => {
  const own = isStoredPrice(item?.purchasePrice, item?.purchaseCurrency) ? item!.purchaseCurrency : null;
  const choices = [...new Set([own, household].filter((c): c is string => !!c))];
  if (!choices.length) {
    return (
      <p class="muted form-note">
        Purchase price:{' '}
        {admin ? (
          <>
            <a href="/settings/users#currency">set the household currency</a> first — prices are entered in it.
          </>
        ) : (
          'an admin sets the household currency first, under Members — prices are entered in it.'
        )}
      </p>
    );
  }
  const currency = sent && choices.includes(sent.currency) ? sent.currency : (own ?? household)!;
  const value = sent ? sent.amount : own ? minorToDecimal(item!.purchasePrice!, own) : '';
  const described = [choices.length > 1 ? 'purchase-price-note' : null, error ? 'purchase-price-error' : null].filter(Boolean).join(' ');
  return (
    <div class="money-field">
      <label for="purchase-price">
        Purchase price{' '}
        <small>
          ({choices.length > 1 ? 'what you paid' : `what you paid, in ${currency}`} — never on share pages)
        </small>
      </label>
      <div class="money-input">
        {choices.length > 1 ? (
          <select name="purchaseCurrency" aria-label="Currency it was paid in">
            {choices.map((c) => (
              <option value={c} selected={c === currency}>
                {c}
              </option>
            ))}
          </select>
        ) : (
          <>
            <span class="money-code" aria-hidden="true">
              {currency}
            </span>
            <input type="hidden" name="purchaseCurrency" value={currency} />
          </>
        )}
        <input
          id="purchase-price"
          name="purchasePrice"
          value={value}
          inputmode="decimal"
          autocomplete="off"
          placeholder={currencyDigits(currency) ? '0.00' : '0'}
          aria-invalid={error ? 'true' : undefined}
          aria-describedby={described || undefined}
        />
      </div>
      {choices.length > 1 ? (
        <p class="muted form-note" id="purchase-price-note">
          Entered in {own} before the household's currency became {household}. It stays in {own} unless you choose {household}.
        </p>
      ) : null}
      {error ? (
        <p class="field-error" id="purchase-price-error">
          {error}
        </p>
      ) : null}
    </div>
  );
};

/** What was paid for an item, on its page (§16 #61). */
export const Money: FC<{ minor: number | string; currency: string }> = ({ minor, currency }) => (
  <span class="money">{formatMoney(minor, currency)}</span>
);

/** "records", "board game", "items": the word for what a shelf holds, by its one type when it holds only one. */
export function shelfWord(byType: Array<{ mediaType: MediaType; count: number }>, n: number): string {
  const types = [...new Set(byType.filter((t) => t.count > 0).map((t) => (t.mediaType === 'music' ? 'vinyl' : t.mediaType)))];
  const only = types.length === 1 ? types[0]! : null;
  const plural = only === 'vinyl' ? 'records' : only && only !== 'other' ? MEDIA_PLURAL[only] : 'items';
  const single = only === 'vinyl' ? 'record' : only && only !== 'other' ? MEDIA_LABEL[only].toLowerCase() : 'item';
  return n === 1 ? single : plural;
}

/** "12 records", "3 board games", "1,040 items": what a shelf holds, its count grouped. */
export function shelfNoun(byType: Array<{ mediaType: MediaType; count: number }>, n: number): string {
  return `${formatCount(n)} ${shelfWord(byType, n)}`;
}

/**
 * A shelf's totals (§16 #61): "Paid ₹30,200 for 9 · US$45 for 2, in USD — of 12 records on this shelf". One sum per
 * currency, never added across currencies, the household's first. Nothing at all while nothing on it has a price.
 */
export const PaidTotals: FC<{ totals: { items: number; byType: Array<{ mediaType: MediaType; count: number }>; paid: CurrencyTotal[] }; household: string | null }> = ({
  totals,
  household,
}) => {
  if (!totals.paid.length) return null;
  const ordered = [...totals.paid].sort((a, b) =>
    a.currency === household ? -1 : b.currency === household ? 1 : a.currency.localeCompare(b.currency),
  );
  return (
    <p class="paid-totals">
      <span class="eyebrow">Paid</span>{' '}
      {ordered.map((t, i) => (
        <>
          {i ? <span class="muted"> · </span> : null}
          <span class="money">{formatMoney(t.total, t.currency)}</span>{' '}
          <span class="muted">
            {/* counts are data: monospace, grouped as the amounts are */}
            for <span class="mono">{formatCount(t.count)}</span>
            {household && t.currency !== household ? `, in ${t.currency}` : ''}
          </span>
        </>
      ))}{' '}
      <span class="muted">
        — of <span class="mono">{formatCount(totals.items)}</span> {shelfWord(totals.byType, totals.items)} on this shelf
      </span>
    </p>
  );
};

/** One grade on the item page: its code in a mono pill, Discogs' wording beside it. */
export const Grade: FC<{ grade: string }> = ({ grade }) => {
  const name = GRADE_NAME[grade as keyof typeof GRADE_NAME] ?? grade;
  // "Very Good Plus (VG+)" → "Very Good Plus": the pill already says VG+
  const words = name.replace(/\s*\([^)]*\)$/, '');
  return (
    <>
      <span class="pill grade">{grade}</span>
      {words !== grade ? <span class="muted">{words}</span> : null}
    </>
  );
};

/** A record's tracklist, folded: a long one shouldn't push the rest of the page off a phone. */
export const Tracklist: FC<{ tracks: Track[] }> = ({ tracks }) => {
  if (!tracks.length) return null;
  const n = trackCount(tracks);
  return (
    <details class="tracklist">
      <summary>
        Tracklist <span class="mono muted">· {n === 1 ? '1 track' : `${n} tracks`}</span>
      </summary>
      <ol class="tracks">
        {tracks.map((t) =>
          'heading' in t ? (
            <li class="track-heading">{t.heading}</li>
          ) : (
            <li>
              <span class="track-pos mono">{t.position ?? ''}</span>
              <span class="track-title">
                {t.title}
                {t.artist ? <span class="track-artist muted"> — {t.artist}</span> : null}
              </span>
              <span class="track-time mono">{t.duration ?? ''}</span>
            </li>
          ),
        )}
      </ol>
    </details>
  );
};

/**
 * A record's pressing — label, catalogue number, country, year, format — and its tracklist, then whatever else its
 * details hold, as the plain list every item page has. Used by the item page and the share page alike: pressing
 * details are public catalogue data (§9). `after` sits between the pressing and the rest (the Refresh button).
 * Discogs' credit (§16 #63) goes right below the pressing it credits — or, for a record whose only Discogs data is
 * in the plain list (its genres), below that — when `discogsLink()` says the record owes one.
 */
export const RecordDetails: FC<{ details: Record<string, unknown>; after?: unknown; publicPage?: boolean }> = ({
  details,
  after,
  publicPage,
}) => {
  const { pressing, tracklist, rest } = splitPressing(details);
  const empty = !pressing.length && !tracklist.length;
  const discogs = discogsLink({ mediaType: 'vinyl', details }); // only ever called for a record
  return (
    <>
      {empty && publicPage ? null : (
        <div class="detail-section" id="pressing">
          <p class="eyebrow">Pressing</p>
          {pressing.length ? <DetailsList details={Object.fromEntries(pressing)} /> : null}
          {empty ? <p class="muted">No pressing details yet.</p> : null}
          <Tracklist tracks={tracklist} />
          {discogs && !empty ? <DiscogsAttribution href={discogs} /> : null}
          {after}
        </div>
      )}
      {Object.keys(rest).length ? (
        <div class="detail-section">
          <p class="eyebrow">Details</p>
          <DetailsList details={rest} />
        </div>
      ) : null}
      {discogs && empty ? <DiscogsAttribution href={discogs} /> : null}
    </>
  );
};
// ---------- want lists and purchase links (ARCH.md §16 #53) ----------

/** What the toggle says: a book is read; a record or a game is only wanted. */
export const wantLabel = (mediaType: MediaType) => (mediaType === 'book' ? 'Want to read' : 'Want');

/**
 * Purchase links as a list of outbound links. Every URL here was checked as http(s) on the way in and again on the
 * way out of a share page; each opens a new tab with `noopener noreferrer`, so the page it opens can't reach back into
 * this one and is never told where it came from — a share page's token stays out of every shop's logs.
 */
export const BuyLinks: FC<{ links: Array<{ label: string; url: string }> }> = ({ links }) =>
  links.length ? (
    <ul class="buy-links">
      {links.map((l) => (
        <li>
          <a href={l.url} target="_blank" rel="noopener noreferrer" class="buy-link">
            <span>{l.label}</span>
            <small class="mono">{linkHost(l.url)} ↗</small>
          </a>
        </li>
      ))}
    </ul>
  ) : null;

/**
 * The item page's want-list bar: the signed-in member's own toggle, and who else in the household wants it. htmx swaps
 * the bar in place; without it the form posts and lands back on the item page.
 */
export const WantBar: FC<{
  item: Pick<Item, 'id' | 'mediaType'>;
  wanters: Array<{ id: number; username: string }>;
  viewer: { id: number };
}> = ({ item, wanters, viewer }) => {
  const mine = wanters.some((w) => w.id === viewer.id);
  const others = wanters.filter((w) => w.id !== viewer.id);
  return (
    <div class="want-bar" id="want-bar">
      <form method="post" action={`/items/${item.id}/want`} hx-post={`/items/${item.id}/want`} hx-target="#want-bar" hx-swap="outerHTML" class="inline">
        <input type="hidden" name="want" value={mine ? '0' : '1'} />
        <button type="submit" class={mine ? 'want-toggle on' : 'want-toggle'} aria-pressed={mine ? 'true' : 'false'}>
          <span aria-hidden="true">{mine ? '✓' : '+'}</span> {wantLabel(item.mediaType)}
        </button>
      </form>
      {mine ? (
        <a href="/wants" class="muted want-note">
          on your want list
        </a>
      ) : null}
      {others.length ? (
        <small class="muted want-note">
          {mine ? 'also wanted by ' : 'wanted by '}
          {others.map((w) => w.username).join(', ')}
        </small>
      ) : null}
    </div>
  );
};

/**
 * The item page's purchase links, with a form to add one and a Remove on each — the household's, so any member may.
 * htmx swaps the section in place; `error` says why a link was refused.
 */
export const BuySection: FC<{
  itemId: number;
  links: Array<{ id: number; label: string; url: string }>;
  error?: string;
  label?: string;
  url?: string;
}> = ({ itemId, links, error, label, url }) => (
  <div class="detail-section buy-section" id="buy">
    <p class="eyebrow">Where to buy</p>
    {error ? <p class="error" role="alert">{error}</p> : null}
    {links.length ? (
      <ul class="buy-links editable">
        {links.map((l) => (
          <li>
            <a href={l.url} target="_blank" rel="noopener noreferrer" class="buy-link">
              <span>{l.label}</span>
              <small class="mono">{linkHost(l.url)} ↗</small>
            </a>
            <form
              method="post"
              action={`/items/${itemId}/links/${l.id}/delete`}
              hx-post={`/items/${itemId}/links/${l.id}/delete`}
              hx-target="#buy"
              hx-swap="outerHTML"
              class="inline"
            >
              <button type="submit" class="progress-delete" aria-label={`Remove the link ${l.label}`}>
                Remove
              </button>
            </form>
          </li>
        ))}
      </ul>
    ) : (
      <p class="muted form-note">No links yet. Paste one from a shop — it shows on a gift list of anyone who wants this.</p>
    )}
    <details class="read-add" open={!!error}>
      <summary>Add a link</summary>
      <form method="post" action={`/items/${itemId}/links`} hx-post={`/items/${itemId}/links`} hx-target="#buy" hx-swap="outerHTML" class="inline-form buy-form">
        <input name="label" placeholder="Label, e.g. Bookshop" maxlength={60} value={label ?? ''} aria-label="Label" />
        <input name="url" type="url" placeholder="https://…" required inputmode="url" value={url ?? ''} aria-label="Address" />
        <button type="submit">Add link</button>
      </form>
    </details>
  </div>
);
