import { Hono, type Context } from 'hono';
import type { Item, ItemStatus, MediaType, NewItem } from '../db/schema';
import { ITEM_STATUSES, MEDIA_TYPES } from '../db/schema';
import {
  activeLoansForItem,
  addPastRead,
  addProgress,
  closeRead,
  createItemWithTags,
  deleteItem,
  deleteProgress,
  deleteRead,
  deleteReview,
  getItem,
  getLibrary,
  getProgressEntry,
  getRead,
  getReview,
  listLibraries,
  listPeople,
  moveRead,
  moveReview,
  pastLoansForItem,
  readingLog,
  startRead,
  tagsForItem,
  updateItem,
  updateItemWithTags,
  updateRead,
  updateReview,
  type Actor,
  type ReadEntry,
  type ReviewEntry,
} from '../db/queries';
import type { AppEnv } from '../env';
import { deleteCover, storeCover } from '../lib/covers';
import { MAX_PROGRESS_PAGE } from '../lib/progress';
import { isReadStatus, readDateProblem, summarizeReads, todayUtc, type ReadDraft } from '../lib/reads';
import { reviewText } from '../lib/reviews';
import { parseDetails } from '../lib/share';
import {
  accNo,
  CopiesPill,
  Cover,
  DetailsList,
  HoldingPill,
  ItemForm,
  MarkNotOwnedButton,
  MarkOwnedButton,
  ItemStatusPills,
  LendingHistory,
  MEDIA_LABEL,
  ReadingSection,
  ReadsByPerson,
  ReviewsSection,
  stars,
  type Person,
  type Viewer,
} from '../views/components';
import { page } from '../views/layout';
import { BggAttribution, fromBgg } from '../views/attribution';
import { itemComments } from './comments';

const items = new Hono<AppEnv>();

/** The signed-in person, as the reading and review routes check them: their own, or anyone's for an admin (§16 #43). */
function viewerOf(c: Context<AppEnv>): Viewer & Actor {
  const user = c.get('user');
  return { id: user.id, admin: user.role === 'admin' };
}

/**
 * Whether the book's page shows people: once the household has more than one member, or anyone but the viewer has
 * read or reviewed it (a member removed since, say). A household of one sees the page as it always was.
 */
const showsPeople = (people: Person[], viewer: Viewer, log: { reads: ReadEntry[]; reviews: ReviewEntry[] }) =>
  people.length > 1 || log.reads.some((r) => r.readerId !== viewer.id) || log.reviews.some((r) => r.userId !== viewer.id);

/**
 * The item as one person's edit form shows it (§16 #43): their reading — the status and dates of their read that
 * decides their status, their finishes, whether they're reading it again — and their rating and review, over the
 * household's item. The form edits exactly these, whoever else has read or reviewed it.
 */
function personalItem(item: Item, log: { reads: ReadEntry[]; reviews: ReviewEntry[] }, person: number): Item {
  // summarizeReads takes reads in insertion order
  const mine = log.reads.filter((r) => r.readerId === person).sort((a, b) => a.id - b.id);
  const review = log.reviews.find((r) => r.userId === person);
  return { ...item, ...summarizeReads(mine), rating: review?.rating ?? null, review: review?.review ?? null };
}

/**
 * What's wrong with the form's status and dates, or null (§16 #41). They describe the editor's read that decides
 * their status (§16 #43) — `existing` is the item as personalItem() shows it to them — so: a book not started has no
 * dates, one in progress no completion date, and a book they've read can't be made not started from here — their
 * reads are deleted on its page. A book they're reading again has its reading fields locked (see `rereadLocked`):
 * they describe their last finish, and changing them here would rewrite that.
 */
function formReadProblem(existing: Item | null, v: { status: ItemStatus; beganOn: string | null; completedOn: string | null }): string | null {
  if (v.status === 'not_started') {
    // a book's reads are deleted on its page, one by one; anything else has no such page, so the form clears them
    if (existing && existing.status !== 'not_started' && existing.mediaType === 'book') {
      return 'This book has reads. To make it not started, delete them on its page.';
    }
    return v.beganOn || v.completedOn ? 'A book not started has no reading dates: choose a status, or clear the dates.' : null;
  }
  if (v.status === 'in_progress' && v.completedOn) return 'A book in progress has no completion date: clear it, or choose Completed.';
  // A finished book's status here edits its last finish. "In progress" would reopen that finish and "Abandoned" relabel
  // it a stop — the old way of saying "reading it again", which now loses a read. Its page has the controls for both.
  if (existing?.mediaType === 'book' && existing.readCount > 0) {
    if (v.status === 'in_progress') return 'This book has been finished. To read it again, use Read again on its page.';
    if (v.status === 'abandoned') {
      return 'This book has been finished. To record a read you stopped, use its page: Read again, then Stop — or correct a read there.';
    }
  }
  // Not dead code: the guard above is for books. A record or game has no Reading section, but it can hold a finish
  // and an open read: from a Nalanda re-import, or a re-read book whose type was changed to a record. The database
  // already refuses a second open read (formReadStatements), so without this the form would answer "saved" and drop
  // the status change silently. This says why instead.
  if (v.status === 'in_progress' && existing?.rereading) return 'It already has a read in progress: choose Not started to clear its reads.';
  return readDateProblem({ status: v.status, beganOn: v.beganOn, endedOn: v.status === 'in_progress' ? null : v.completedOn });
}

type ParsedForm = {
  values: Omit<NewItem, 'libraryId'> & { libraryId: number };
  tags: string[];
  coverUrl: string;
  removeCover: boolean;
};

/** A rating from a form: half-stars 1–10, or none. */
const formRating = (raw: unknown): number | null => {
  const n = Number.parseInt(typeof raw === 'string' ? raw.trim() : '', 10);
  return Number.isFinite(n) && n >= 1 && n <= 10 ? n : null;
};

function parseItemForm(body: Record<string, string | File>): ParsedForm | null {
  const str = (k: string) => {
    const v = body[k];
    return typeof v === 'string' ? v.trim() : '';
  };
  const orNull = (v: string) => (v === '' ? null : v);

  const title = str('title');
  const libraryId = Number.parseInt(str('libraryId'), 10);
  if (!title || !Number.isInteger(libraryId)) return null;

  const mediaType = (MEDIA_TYPES as readonly string[]).includes(str('mediaType'))
    ? (str('mediaType') as MediaType)
    : 'other';
  const status = (ITEM_STATUSES as readonly string[]).includes(str('status'))
    ? (str('status') as ItemStatus)
    : 'not_started';
  const lengthNum = Number.parseInt(str('length').replace(/\D/g, ''), 10);
  const copiesNum = Number.parseInt(str('copies').replace(/\D/g, ''), 10);

  // keep details lossless: invalid JSON from the advanced box is discarded, not saved broken
  const detailsObj = parseDetails(str('details') || '{}');
  // the dedicated "Reviewed in" field owns reviewed_in — blank field clears it
  delete detailsObj['reviewed_in'];
  const reviewedIn = str('reviewedIn')
    .split(/[\n,]+/)
    .map((u) => u.trim())
    .filter((u) => /^https?:\/\//.test(u));
  if (reviewedIn.length) detailsObj['reviewed_in'] = reviewedIn;
  const details = JSON.stringify(detailsObj);

  return {
    values: {
      libraryId,
      mediaType,
      title,
      creators: orNull(str('creators')),
      isbn13: orNull(str('isbn13').replace(/\D/g, '')),
      isbn10Upc: orNull(str('isbn10Upc')),
      publisher: orNull(str('publisher')),
      published: orNull(str('published')),
      description: orNull(str('description')),
      length: Number.isFinite(lengthNum) && lengthNum > 0 ? lengthNum : null,
      status,
      rating: formRating(body['rating']),
      review: orNull(str('review')),
      notes: orNull(str('notes')),
      copies: Number.isFinite(copiesNum) && copiesNum >= 0 ? copiesNum : 1, // 0 = cataloged, not owned
      beganOn: orNull(str('beganOn')),
      completedOn: orNull(str('completedOn')),
      details,
    },
    tags: str('tags').split(',').map((t) => t.trim()).filter(Boolean),
    coverUrl: str('coverUrl'),
    removeCover: str('removeCover') === '1',
  };
}

/** The form's status and dates, as the read they describe. */
const readFields = (v: ParsedForm['values']) => ({ status: v.status ?? 'not_started', beganOn: v.beganOn ?? null, completedOn: v.completedOn ?? null });

/** What a refused form shows again: what was submitted, over the item as it stands (or nothing, for a new one). */
const formItem = (existing: Item | null, v: ParsedForm['values']): Item =>
  ({ ...(existing ?? { id: 0, coverKey: null, readCount: 0, rereading: false }), ...v }) as Item;

/**
 * A book the editor is reading again: their form's status and dates describe their last finish, and are shown
 * locked — the re-read is started, finished and corrected on the book's page. A form that sends them anyway (opened
 * before the re-read began) may only send them unchanged. `item` is the editor's view (personalItem).
 */
const rereadLocked = (item: Item) => item.mediaType === 'book' && item.rereading;

const LENGTH_UNIT: Partial<Record<MediaType, string>> = {
  book: 'pages',
  boardgame: 'min play time',
  vinyl: 'tracks',
  movie: 'min',
  music: 'tracks',
  videogame: 'hours',
};

items.post('/items', async (c) => {
  const body = await c.req.parseBody();
  const parsed = parseItemForm(body);
  if (!parsed) return c.text('Title and shelf are required.', 400);
  const lib = await getLibrary(c.env.DB, parsed.values.libraryId);
  if (!lib) return c.text('No such shelf.', 400);

  // "Log — not owned" on scan/search results: a copies=0 reading-log entry,
  // landing on the edit form so rating/review/status go in immediately.
  const logOnly = body['logOnly'] === '1';
  if (logOnly) parsed.values.copies = 0;

  const problem = formReadProblem(null, readFields(parsed.values));
  if (problem) {
    const [libs, people] = await Promise.all([listLibraries(c.env.DB), listPeople(c.env.DB)]);
    c.status(400);
    return page(
      c,
      'Add item',
      <>
        <div class="page-head">
          <h1>Add item</h1>
        </div>
        <ItemForm
          libraries={libs}
          action="/items"
          submitLabel="Add item"
          item={formItem(null, parsed.values)}
          tags={parsed.tags}
          coverUrl={parsed.coverUrl}
          error={problem}
          perMember={people.length > 1}
        />
      </>,
    );
  }

  const coverKey = await storeCover(c.env.COVERS, parsed.coverUrl);
  let id: number;
  try {
    // its status, dates, rating and review become the adder's read and review (added_by)
    id = await createItemWithTags(c.env.DB, { ...parsed.values, coverKey, addedBy: c.get('user').id }, parsed.tags);
  } catch (err) {
    c.executionCtx.waitUntil(deleteCover(c.env.COVERS, coverKey)); // nothing points at it
    throw err;
  }
  return c.redirect(logOnly ? `/items/${id}/edit` : `/items/${id}`);
});

/** The item page. `reviewError` says why a change to a review from this page was refused. */
async function itemPage(c: Context<AppEnv>, id: number, reviewError?: string) {
  const item = await getItem(c.env.DB, id);
  if (!item) return c.notFound();
  const viewer = viewerOf(c);
  const [lib, tags, loans, people, log, lent] = await Promise.all([
    getLibrary(c.env.DB, item.libraryId),
    tagsForItem(c.env.DB, id),
    activeLoansForItem(c.env.DB, id),
    listPeople(c.env.DB),
    readingLog(c.env.DB, id),
    pastLoansForItem(c.env.DB, id),
  ]);
  const addedBy = item.addedBy ? (people.find((p) => p.id === item.addedBy) ?? null) : null;
  const grouped = showsPeople(people, viewer, log);
  const ratings = log.reviews.filter((r) => r.rating !== null).length;
  const today = new Date().toISOString().slice(0, 10);
  const isOverdue = (l: { dueOn: string | null }) => !!(l.dueOn && l.dueOn < today);
  const overdue = loans.some(isOverdue);
  const loan = loans[0] ?? null; // for the status pill: lent at all, and overdue if any is
  const copyFree = item.copies > loans.length;
  const details = parseDetails(item.details);
  const discussion = await itemComments(c, item); // null unless connections are enabled and someone commented

  return page(
    c,
    item.title,
    <article class="item-detail">
      <div class="item-detail-cover">
        <Cover coverKey={item.coverKey} title={item.title} mediaType={item.mediaType} />
      </div>
      <div class="item-detail-body">
        <hgroup>
          <h1>{item.title}</h1>
          {item.creators ? <p>{item.creators}</p> : null}
        </hgroup>
        {tags.length ? (
          <p>
            {tags.map((t) => (
              <a href={`/tags/${encodeURIComponent(t)}`} class="tag">
                {t}
              </a>
            ))}
          </p>
        ) : null}

        <dl class="props">
          <dt>Accession</dt>
          <dd class="mono">{accNo(item.id)}</dd>
          <dt>Shelf</dt>
          <dd>{lib ? <a href={`/libraries/${lib.id}`}>{lib.name}</a> : '—'}</dd>
          <dt>Type</dt>
          <dd>{MEDIA_LABEL[item.mediaType]}</dd>
          <dt>Status</dt>
          <dd>
            <ItemStatusPills item={item} />
            {loan ? <span class={overdue ? 'pill overdue' : 'pill lent'}>{overdue ? 'Overdue' : 'Lent'}</span> : null}
          </dd>
          <dt>Holding</dt>
          <dd>
            <HoldingPill item={item} />
          </dd>
          {item.rating ? (
            <>
              <dt>Rating</dt>
              <dd>
                <span class="rating">{stars(item.rating)}</span>
                {/* the household's: everyone's ratings averaged, as share pages and connections see it */}
                {grouped && ratings > 1 ? <span class="muted rating-note"> average of {ratings}</span> : null}
              </dd>
            </>
          ) : null}
          {item.published ? (
            <>
              <dt>Published</dt>
              <dd>{item.published}</dd>
            </>
          ) : null}
          {item.publisher ? (
            <>
              <dt>Publisher</dt>
              <dd>{item.publisher}</dd>
            </>
          ) : null}
          {item.length ? (
            <>
              <dt>Length</dt>
              <dd class="mono">
                {item.length} {LENGTH_UNIT[item.mediaType] ?? ''}
              </dd>
            </>
          ) : null}
          {item.isbn13 ? (
            <>
              <dt>ISBN-13</dt>
              <dd class="mono">{item.isbn13}</dd>
            </>
          ) : null}
          {item.isbn10Upc ? (
            <>
              <dt>ISBN-10 / UPC</dt>
              <dd class="mono">{item.isbn10Upc}</dd>
            </>
          ) : null}
          {item.copies > 1 ? (
            <>
              <dt>Copies</dt>
              <dd class="mono">{item.copies}</dd>
            </>
          ) : null}
          {/* a book's dates are its reads, in the Reading section below */}
          {item.beganOn && item.mediaType !== 'book' ? (
            <>
              <dt>Began</dt>
              <dd class="mono">{item.beganOn}</dd>
            </>
          ) : null}
          {item.completedOn && item.mediaType !== 'book' ? (
            <>
              <dt>Completed</dt>
              <dd class="mono">{item.completedOn}</dd>
            </>
          ) : null}
          <dt>Added</dt>
          <dd class="mono">
            {item.addedAt.slice(0, 10)}
            {addedBy ? ` · ${addedBy.username}` : ''}
          </dd>
        </dl>

        {item.description ? <p class="prewrap">{item.description}</p> : null}

        {Object.keys(details).length ? (
          <div class="detail-section">
            <p class="eyebrow">Details</p>
            <DetailsList details={details} />
          </div>
        ) : null}
        {fromBgg(item) ? <BggAttribution /> : null}

        {grouped ? (
          <>
            {reviewError ? <p class="error">{reviewError}</p> : null}
            <ReviewsSection item={item} reviews={log.reviews} viewer={viewer} people={people} />
          </>
        ) : item.review ? (
          <div class="detail-section">
            <p class="eyebrow">Review</p>
            <p class="prewrap">{item.review}</p>
          </div>
        ) : null}

        {item.mediaType === 'book' ? (
          <ReadingSection
            item={item}
            reads={log.reads}
            entries={log.entries}
            today={todayUtc()}
            viewer={viewer}
            people={people}
            grouped={grouped}
          />
        ) : grouped && log.reads.length ? (
          // a record's or game's reads are kept from the edit form; with more than one person, here is whose they are
          <ReadsByPerson item={item} reads={log.reads} viewer={viewer} people={people} />
        ) : null}

        {discussion}

        {item.notes ? (
          <div class="detail-section">
            <p class="eyebrow">Private notes — never on share pages</p>
            <p class="prewrap">{item.notes}</p>
          </div>
        ) : null}

        <div class={loan ? 'circulation' : 'circulation free'}>
          <p class="eyebrow">Circulation</p>
          {item.copies === 0 && !loans.length ? (
            <p class="muted">Not in the physical collection — nothing to lend.</p>
          ) : null}
          {/* every open loan: with two copies out, both borrowers show, each with its own return */}
          {loans.map((l) => (
            <form method="post" action={`/loans/${l.id}/return`} class="inline-form">
              <span class={isOverdue(l) ? 'error' : undefined}>
                Lent to <strong>{l.borrower}</strong> on <span class="mono">{l.loanedOn}</span>
                {l.dueOn ? (
                  <>
                    , due <span class="mono">{l.dueOn}</span>
                  </>
                ) : null}
              </span>
              <button type="submit" class="btn">
                Mark returned
              </button>
            </form>
          ))}
          {copyFree ? (
            <form method="post" action={`/items/${item.id}/loan`} class="inline-form">
              <input name="borrower" placeholder="Borrower" required />
              <input name="contact" placeholder="Contact (optional)" />
              <input type="date" name="dueOn" aria-label="Due date" />
              <button type="submit">Lend</button>
            </form>
          ) : null}
        </div>

        <LendingHistory loans={lent.loans} total={lent.total} />

        <div class="actions">
          <a href={`/items/${item.id}/edit`} role="button">
            Edit
          </a>
          <form
            method="post"
            action={`/items/${item.id}/delete`}
            class="inline"
            onsubmit="return confirm('Delete this item?')"
          >
            <button type="submit" class="btn-danger">
              Delete
            </button>
          </form>
        </div>
      </div>
    </article>,
  );
}

items.get('/items/:id', (c) => itemPage(c, Number(c.req.param('id'))));

items.get('/items/:id/edit', async (c) => {
  const id = Number(c.req.param('id'));
  const item = await getItem(c.env.DB, id);
  if (!item) return c.notFound();
  const [libs, tags, log, people] = await Promise.all([
    listLibraries(c.env.DB),
    tagsForItem(c.env.DB, id),
    readingLog(c.env.DB, id),
    listPeople(c.env.DB),
  ]);
  return page(
    c,
    `Edit · ${item.title}`,
    <>
      <div class="page-head">
        <div>
          <h1>Edit item</h1>
          <span class="sub mono">{accNo(item.id)}</span>
        </div>
      </div>
      <ItemForm
        libraries={libs}
        action={`/items/${id}`}
        submitLabel="Save changes"
        item={personalItem(item, log, c.get('user').id)}
        tags={tags}
        perMember={people.length > 1}
      />
    </>,
  );
});

// Quick actions from the shelf table / item page: flip copies 0 ↔ 1 in place,
// no edit form. htmx-only — each swaps the clicked button (hx-swap="outerHTML")
// for the other direction's button, so the toggle round-trips.
/**
 * The Reading section after a change, with the status pill above it swapped out of band — starting, finishing or
 * stopping a read changes that too. Without htmx the form posts and lands back on the item page. The change is
 * already saved when this reads it back, so a failed read-back reloads the page rather than failing the request:
 * a retry would record the page, or add the read, twice (§16 #39).
 */
async function readingResponse(c: Context<AppEnv>, id: number, error?: string) {
  if (!c.req.header('HX-Request')) return c.redirect(`/items/${id}`);
  let item: Item | null;
  let log: Awaited<ReturnType<typeof readingLog>>;
  let people: Person[];
  try {
    [item, log, people] = await Promise.all([getItem(c.env.DB, id), readingLog(c.env.DB, id), listPeople(c.env.DB)]);
  } catch {
    c.header('HX-Redirect', `/items/${id}`);
    return c.body(null, 200);
  }
  if (!item) return c.notFound();
  const viewer = viewerOf(c);
  return c.html(
    <>
      {item.mediaType === 'book' ? (
        <ReadingSection
          item={item}
          reads={log.reads}
          entries={log.entries}
          today={todayUtc()}
          viewer={viewer}
          people={people}
          grouped={showsPeople(people, viewer, log)}
          error={error}
        />
      ) : (
        <ReadsByPerson item={item} reads={log.reads} viewer={viewer} people={people} error={error} />
      )}
      <ItemStatusPills item={item} oob={true} />
    </>,
  );
}

/** A change to someone else's reading or review, refused (§16 #43). The page never offers one; a hand-made request gets this. */
const notYours = (c: Context<AppEnv>, what: string) => c.text(`That ${what} is someone else’s: only they or an admin can change it.`, 403);

/**
 * The book a reading route is for, or null: starting a read, adding a past one and pages are for books (the edit
 * form covers the rest). Correcting, closing, deleting and moving a read work for any item (`anyType`): a record's or
 * game's reads are someone's too, and an admin fixes them from its page (§16 #43).
 */
async function bookFor(c: Context<AppEnv>, anyType = false): Promise<Item | null> {
  const item = await getItem(c.env.DB, Number(c.req.param('id')));
  return item && (anyType || item.mediaType === 'book') ? item : null;
}

const formDate = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);

/**
 * Records a page, in the signed-in person's own open read. A bad number re-renders the section with the reason, and
 * htmx swaps the section either way; without htmx the form posts and lands back on the item page (the browser's
 * pattern check stops most junk before it's sent).
 */
items.post('/items/:id/progress', async (c) => {
  const id = Number(c.req.param('id'));
  const item = await getItem(c.env.DB, id);
  if (!item) return c.notFound();
  if (item.mediaType !== 'book') return c.text('Reading progress is for books', 400);

  const raw = ((await c.req.parseBody())['page'] ?? '').toString().trim();
  const page = Number(raw);
  const invalid = !/^\d+$/.test(raw) || !Number.isSafeInteger(page) || page < 1 || page > MAX_PROGRESS_PAGE;
  // a finished or stopped book has no open read to record into: reading it again starts with "Read again"
  const recorded = !invalid && (await addProgress(c.env.DB, id, page, c.get('user').id));
  return readingResponse(
    c,
    id,
    invalid
      ? 'Give a whole page number, from 1 to 100,000.'
      : !recorded
        ? 'This book isn’t being read now. Start a new read first, then record its pages.'
        : undefined,
  );
});

/** Removes a page: its reader's, or anyone's for an admin. */
items.post('/items/:id/progress/:entryId/delete', async (c) => {
  const id = Number(c.req.param('id'));
  const item = await getItem(c.env.DB, id);
  if (!item) return c.notFound();
  const viewer = viewerOf(c);
  const entry = await getProgressEntry(c.env.DB, id, Number(c.req.param('entryId')));
  if (entry && !viewer.admin && entry.ownerId !== viewer.id) return notYours(c, 'page');
  if (entry) await deleteProgress(c.env.DB, id, entry.id, viewer);
  return readingResponse(c, id);
});

// ---------- reads (ARCH.md §16 #41, #43) ----------

/**
 * Starts a read of the signed-in person's own: their first, or "Read again" on a book they've finished — which stays
 * Completed, marked re-reading. Someone else reading it doesn't stop them.
 */
items.post('/items/:id/reads/start', async (c) => {
  const item = await bookFor(c);
  if (!item) return c.notFound();
  const beganOn = formDate((await c.req.parseBody())['date']) ?? todayUtc();
  const problem = readDateProblem({ status: 'in_progress', beganOn, endedOn: null });
  if (problem) return readingResponse(c, item.id, problem);
  const started = await startRead(c.env.DB, item.id, beganOn, c.get('user').id);
  return readingResponse(
    c,
    item.id,
    started ? undefined : 'A read is already open — finish or stop it first — or this book has as many reads as it can hold.',
  );
});

/**
 * The read a route names, when the signed-in person may change it: 'missing' when there's no such read of this book,
 * 'refused' when it's someone else's and they aren't an admin.
 */
async function readFor(c: Context<AppEnv>, item: Item): Promise<ReadEntry | 'missing' | 'refused'> {
  const read = await getRead(c.env.DB, item.id, Number(c.req.param('readId')));
  if (!read) return 'missing';
  const viewer = viewerOf(c);
  return viewer.admin || read.readerId === viewer.id ? read : 'refused';
}

/** Finishes or stops an open read, on the date given or today — the reader's own, or anyone's for an admin. */
for (const [action, status] of [
  ['finish', 'completed'],
  ['stop', 'abandoned'],
] as const) {
  items.post(`/items/:id/reads/:readId/${action}`, async (c) => {
    const item = await bookFor(c, true);
    if (!item) return c.notFound();
    const read = await readFor(c, item);
    if (read === 'refused') return notYours(c, 'read');
    const endedOn = formDate((await c.req.parseBody())['date']) ?? todayUtc();
    const problem = readDateProblem({ status, beganOn: null, endedOn });
    if (problem) return readingResponse(c, item.id, problem);
    const closed = read !== 'missing' && (await closeRead(c.env.DB, item.id, read.id, status, endedOn, viewerOf(c)));
    return readingResponse(c, item.id, closed ? undefined : 'That read isn’t open any more, or began after that date.');
  });
}

/** A read of the signed-in person's from before, finished or stopped: "I also read this in 2010". */
items.post('/items/:id/reads', async (c) => {
  const item = await bookFor(c);
  if (!item) return c.notFound();
  const body = await c.req.parseBody();
  const status = body['status'] === 'abandoned' ? 'abandoned' : 'completed';
  const read: ReadDraft = { status, beganOn: formDate(body['beganOn']), endedOn: formDate(body['endedOn']) };
  const problem = readDateProblem(read);
  if (problem) return readingResponse(c, item.id, problem);
  const added = await addPastRead(c.env.DB, item.id, read, c.get('user').id);
  return readingResponse(c, item.id, added ? undefined : 'This book has as many reads as it can hold.');
});

/** Corrects one read's outcome and dates — the reader's own, or anyone's for an admin. */
items.post('/items/:id/reads/:readId', async (c) => {
  const item = await bookFor(c, true);
  if (!item) return c.notFound();
  const found = await readFor(c, item);
  if (found === 'refused') return notYours(c, 'read');
  const body = await c.req.parseBody();
  if (!isReadStatus(body['status'])) return readingResponse(c, item.id, 'Choose how that read went.');
  const read: ReadDraft = {
    status: body['status'],
    beganOn: formDate(body['beganOn']),
    endedOn: body['status'] === 'in_progress' ? null : formDate(body['endedOn']),
  };
  const problem = readDateProblem(read);
  if (problem) return readingResponse(c, item.id, problem);
  const updated = found !== 'missing' && (await updateRead(c.env.DB, item.id, found.id, read, viewerOf(c)));
  return readingResponse(c, item.id, updated ? undefined : 'Another read is open. Finish or stop it before reopening this one.');
});

/** Deletes a read and the pages logged in it — the reader's own, or anyone's for an admin. */
items.post('/items/:id/reads/:readId/delete', async (c) => {
  const item = await bookFor(c, true);
  if (!item) return c.notFound();
  const read = await readFor(c, item);
  if (read === 'refused') return notYours(c, 'read');
  if (read !== 'missing') await deleteRead(c.env.DB, item.id, read.id, viewerOf(c));
  return readingResponse(c, item.id);
});

/** The member a move names, when there is one. */
async function moveTarget(c: Context<AppEnv>): Promise<Person | null> {
  const raw = (await c.req.parseBody())['to'];
  const to = typeof raw === 'string' && /^\d{1,15}$/.test(raw) ? Number(raw) : 0;
  return (await listPeople(c.env.DB)).find((p) => p.id === to) ?? null;
}

/**
 * Moves a read, with its pages, to another member — admins only, to fix history credited to the wrong person, such
 * as everything the upgrade to 1.3.0 gave the first admin (§16 #43).
 */
items.post('/items/:id/reads/:readId/move', async (c) => {
  const item = await bookFor(c, true);
  if (!item) return c.notFound();
  const viewer = viewerOf(c);
  if (!viewer.admin) return c.text('Only an admin can move a read to someone else.', 403);
  const read = await getRead(c.env.DB, item.id, Number(c.req.param('readId')));
  const to = await moveTarget(c);
  if (!read || !to) return readingResponse(c, item.id, 'Choose a member to move that read to.');
  if (read.readerId === to.id) return readingResponse(c, item.id, `That read is ${to.username}’s already.`);
  const moved = await moveRead(c.env.DB, item.id, read.id, to.id, viewer);
  return readingResponse(
    c,
    item.id,
    moved
      ? undefined
      : read.status === 'in_progress'
        ? `${to.username} is reading this book now. Finish or stop that read first, then move this one.`
        : `${to.username} has as many reads of this book as it can hold.`,
  );
});

// ---------- reviews (ARCH.md §16 #43) ----------

/** The review a route names, when the signed-in person may change it — as readFor. */
async function reviewFor(c: Context<AppEnv>, itemId: number): Promise<ReviewEntry | 'missing' | 'refused'> {
  const review = await getReview(c.env.DB, itemId, Number(c.req.param('reviewId')));
  if (!review) return 'missing';
  const viewer = viewerOf(c);
  return viewer.admin || review.userId === viewer.id ? review : 'refused';
}

/** Edits a review from the item page — the writer's own, or anyone's for an admin. Both fields empty deletes it. */
items.post('/items/:id/reviews/:reviewId', async (c) => {
  const id = Number(c.req.param('id'));
  if (!(await getItem(c.env.DB, id))) return c.notFound();
  const found = await reviewFor(c, id);
  if (found === 'refused') return notYours(c, 'review');
  if (found === 'missing') return itemPage(c, id, 'That review isn’t there any more.');
  const body = await c.req.parseBody();
  await updateReview(c.env.DB, id, found.id, { rating: formRating(body['rating']), review: reviewText(String(body['review'] ?? '').trim()) }, viewerOf(c));
  return c.redirect(`/items/${id}#reviews`);
});

/** Deletes a review — the writer's own, or anyone's for an admin. */
items.post('/items/:id/reviews/:reviewId/delete', async (c) => {
  const id = Number(c.req.param('id'));
  if (!(await getItem(c.env.DB, id))) return c.notFound();
  const found = await reviewFor(c, id);
  if (found === 'refused') return notYours(c, 'review');
  if (found !== 'missing') await deleteReview(c.env.DB, id, found.id, viewerOf(c));
  return c.redirect(`/items/${id}#reviews`);
});

/** Moves a review to another member — admins only, as a read. One review each: a member who has one must lose it first. */
items.post('/items/:id/reviews/:reviewId/move', async (c) => {
  const id = Number(c.req.param('id'));
  if (!(await getItem(c.env.DB, id))) return c.notFound();
  const viewer = viewerOf(c);
  if (!viewer.admin) return c.text('Only an admin can move a review to someone else.', 403);
  const review = await getReview(c.env.DB, id, Number(c.req.param('reviewId')));
  const to = await moveTarget(c);
  if (!review || !to) return itemPage(c, id, 'Choose a member to move that review to.');
  if (review.userId === to.id) return itemPage(c, id, `That review is ${to.username}’s already.`);
  if (!(await moveReview(c.env.DB, id, review.id, to.id, viewer))) {
    c.status(409);
    return itemPage(c, id, `${to.username} has a review of this already: delete one of the two first, then move.`);
  }
  return c.redirect(`/items/${id}#reviews`);
});

items.post('/items/:id/mark-owned', async (c) => {
  const id = Number(c.req.param('id'));
  const item = await getItem(c.env.DB, id);
  if (!item) return c.notFound();
  if (item.copies === 0) await updateItem(c.env.DB, id, { copies: 1 });
  return c.html(<MarkNotOwnedButton id={id} />);
});

items.post('/items/:id/mark-not-owned', async (c) => {
  const id = Number(c.req.param('id'));
  const item = await getItem(c.env.DB, id);
  if (!item) return c.notFound();
  // Only the single copy the toggle knows how to restore. A real count (2+) is
  // left alone even for a hand-rolled POST — zeroing it would silently discard a
  // number that round-trips through /export.csv.
  if (item.copies > 1) return c.html(<CopiesPill copies={item.copies} />);
  if (item.copies === 1) await updateItem(c.env.DB, id, { copies: 0 });
  return c.html(<MarkOwnedButton id={id} />);
});

items.post('/items/:id', async (c) => {
  const id = Number(c.req.param('id'));
  const existing = await getItem(c.env.DB, id);
  if (!existing) return c.notFound();
  const body = await c.req.parseBody();
  const parsed = parseItemForm(body);
  if (!parsed) return c.text('Title and shelf are required.', 400);
  const [lib, log, people] = await Promise.all([getLibrary(c.env.DB, parsed.values.libraryId), readingLog(c.env.DB, id), listPeople(c.env.DB)]);
  if (!lib) return c.text('No such shelf.', 400);
  const user = c.get('user');
  // the form's reading, rating and review are the editor's own (§16 #43)
  const mine = personalItem(existing, log, user.id);
  const locked = rereadLocked(mine);
  const sent = readFields(parsed.values);
  const unchanged =
    sent.status === mine.status && sent.beganOn === (mine.beganOn || null) && sent.completedOn === (mine.completedOn || null);
  const problem = locked
    ? 'status' in body && !unchanged
      ? 'This book is being read again: its reads are started, finished and corrected on its page, not here.'
      : null
    : formReadProblem(mine, sent);
  if (problem) {
    const libs = await listLibraries(c.env.DB);
    c.status(400);
    return page(
      c,
      `Edit · ${existing.title}`,
      <>
        <div class="page-head">
          <div>
            <h1>Edit item</h1>
            <span class="sub mono">{accNo(existing.id)}</span>
          </div>
        </div>
        <ItemForm
          libraries={libs}
          action={`/items/${id}`}
          submitLabel="Save changes"
          item={formItem(mine, locked ? { ...parsed.values, status: mine.status, beganOn: mine.beganOn, completedOn: mine.completedOn } : parsed.values)}
          tags={parsed.tags}
          coverUrl={parsed.coverUrl}
          removeCover={parsed.removeCover}
          error={problem}
          perMember={people.length > 1}
        />
      </>,
    );
  }

  let coverKey = existing.coverKey;
  if (parsed.removeCover) coverKey = null;
  if (parsed.coverUrl) coverKey = (await storeCover(c.env.COVERS, parsed.coverUrl)) ?? coverKey;

  try {
    await updateItemWithTags(
      c.env.DB,
      id,
      { ...parsed.values, coverKey },
      parsed.tags,
      locked ? undefined : { ...sent, clearReads: existing.mediaType !== 'book' },
      user.id,
      { rating: parsed.values.rating ?? null, review: reviewText(parsed.values.review) },
    );
  } catch (err) {
    if (coverKey !== existing.coverKey) c.executionCtx.waitUntil(deleteCover(c.env.COVERS, coverKey)); // the new one: unused
    throw err;
  }
  // Only now is the old cover unreferenced. Deleted before the save, as it was, a failed save left the item
  // pointing at a cover that was gone.
  if (coverKey !== existing.coverKey) c.executionCtx.waitUntil(deleteCover(c.env.COVERS, existing.coverKey));
  return c.redirect(`/items/${id}`);
});

items.post('/items/:id/delete', async (c) => {
  const id = Number(c.req.param('id'));
  const item = await getItem(c.env.DB, id);
  if (!item) return c.notFound();
  await deleteItem(c.env.DB, id);
  c.executionCtx.waitUntil(deleteCover(c.env.COVERS, item.coverKey));
  return c.redirect(`/libraries/${item.libraryId}`);
});

export default items;
