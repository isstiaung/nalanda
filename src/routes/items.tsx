import { Hono } from 'hono';
import type { ItemStatus, MediaType, NewItem } from '../db/schema';
import { ITEM_STATUSES, MEDIA_TYPES } from '../db/schema';
import {
  activeLoansForItem,
  addProgress,
  createItemWithTags,
  deleteItem,
  deleteProgress,
  getItem,
  getLibrary,
  getUserById,
  listLibraries,
  listProgress,
  tagsForItem,
  updateItem,
  updateItemWithTags,
} from '../db/queries';
import type { AppEnv } from '../env';
import { deleteCover, storeCover } from '../lib/covers';
import { MAX_PROGRESS_PAGE } from '../lib/progress';
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
  MEDIA_LABEL,
  ReadingProgressSection,
  StatusPill,
  stars,
} from '../views/components';
import { page } from '../views/layout';
import { itemComments } from './comments';

const items = new Hono<AppEnv>();

type ParsedForm = {
  values: Omit<NewItem, 'libraryId'> & { libraryId: number };
  tags: string[];
  coverUrl: string;
  removeCover: boolean;
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
  const ratingNum = Number.parseInt(str('rating'), 10);
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
      rating: Number.isFinite(ratingNum) && ratingNum >= 1 && ratingNum <= 10 ? ratingNum : null,
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

  const coverKey = await storeCover(c.env.COVERS, parsed.coverUrl);
  let id: number;
  try {
    id = await createItemWithTags(c.env.DB, { ...parsed.values, coverKey, addedBy: c.get('user').id }, parsed.tags);
  } catch (err) {
    c.executionCtx.waitUntil(deleteCover(c.env.COVERS, coverKey)); // nothing points at it
    throw err;
  }
  return c.redirect(logOnly ? `/items/${id}/edit` : `/items/${id}`);
});

items.get('/items/:id', async (c) => {
  const id = Number(c.req.param('id'));
  const item = await getItem(c.env.DB, id);
  if (!item) return c.notFound();
  const [lib, tags, loans, addedBy, progress] = await Promise.all([
    getLibrary(c.env.DB, item.libraryId),
    tagsForItem(c.env.DB, id),
    activeLoansForItem(c.env.DB, id),
    item.addedBy ? getUserById(c.env.DB, item.addedBy) : Promise.resolve(null),
    item.mediaType === 'book' ? listProgress(c.env.DB, id) : Promise.resolve([]),
  ]);
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
            <StatusPill status={item.status} />
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
          {item.beganOn ? (
            <>
              <dt>Began</dt>
              <dd class="mono">{item.beganOn}</dd>
            </>
          ) : null}
          {item.completedOn ? (
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

        {item.review ? (
          <div class="detail-section">
            <p class="eyebrow">Review</p>
            <p class="prewrap">{item.review}</p>
          </div>
        ) : null}

        {item.mediaType === 'book' ? <ReadingProgressSection item={item} entries={progress} /> : null}

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
});

items.get('/items/:id/edit', async (c) => {
  const id = Number(c.req.param('id'));
  const item = await getItem(c.env.DB, id);
  if (!item) return c.notFound();
  const [libs, tags] = await Promise.all([listLibraries(c.env.DB), tagsForItem(c.env.DB, id)]);
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
      <ItemForm libraries={libs} action={`/items/${id}`} submitLabel="Save changes" item={item} tags={tags} />
    </>,
  );
});

// Quick actions from the shelf table / item page: flip copies 0 ↔ 1 in place,
// no edit form. htmx-only — each swaps the clicked button (hx-swap="outerHTML")
// for the other direction's button, so the toggle round-trips.
/**
 * Records a page. A bad number re-renders the section with the reason, and htmx swaps the section
 * either way; without htmx the form posts and lands back on the item page (the browser's pattern check
 * stops most junk before it's sent).
 */
items.post('/items/:id/progress', async (c) => {
  const id = Number(c.req.param('id'));
  const item = await getItem(c.env.DB, id);
  if (!item) return c.notFound();
  if (item.mediaType !== 'book') return c.text('Reading progress is for books', 400);

  const raw = ((await c.req.parseBody())['page'] ?? '').toString().trim();
  const page = Number(raw);
  const invalid = !/^\d+$/.test(raw) || !Number.isSafeInteger(page) || page < 1 || page > MAX_PROGRESS_PAGE;
  if (!invalid) await addProgress(c.env.DB, id, page, c.get('user').id);

  if (!c.req.header('HX-Request')) return c.redirect(`/items/${id}`);
  const [fresh, entries] = await Promise.all([getItem(c.env.DB, id), listProgress(c.env.DB, id)]);
  return c.html(
    <ReadingProgressSection
      item={fresh ?? item}
      entries={entries}
      error={invalid ? 'Give a whole page number, from 1 to 100,000.' : undefined}
    />,
  );
});

items.post('/items/:id/progress/:entryId/delete', async (c) => {
  const id = Number(c.req.param('id'));
  const item = await getItem(c.env.DB, id);
  if (!item) return c.notFound();
  await deleteProgress(c.env.DB, id, Number(c.req.param('entryId')));

  if (!c.req.header('HX-Request')) return c.redirect(`/items/${id}`);
  const [fresh, entries] = await Promise.all([getItem(c.env.DB, id), listProgress(c.env.DB, id)]);
  return c.html(<ReadingProgressSection item={fresh ?? item} entries={entries} />);
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
  const parsed = parseItemForm(await c.req.parseBody());
  if (!parsed) return c.text('Title and shelf are required.', 400);
  if (!(await getLibrary(c.env.DB, parsed.values.libraryId))) return c.text('No such shelf.', 400);

  let coverKey = existing.coverKey;
  if (parsed.removeCover) coverKey = null;
  if (parsed.coverUrl) coverKey = (await storeCover(c.env.COVERS, parsed.coverUrl)) ?? coverKey;

  try {
    await updateItemWithTags(c.env.DB, id, { ...parsed.values, coverKey }, parsed.tags);
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
