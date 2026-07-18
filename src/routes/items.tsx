import { Hono } from 'hono';
import type { ItemStatus, MediaType, NewItem } from '../db/schema';
import { ITEM_STATUSES, MEDIA_TYPES } from '../db/schema';
import {
  activeLoanForItem,
  createItem,
  deleteItem,
  getItem,
  getLibrary,
  getUserById,
  listLibraries,
  setItemTags,
  tagsForItem,
  updateItem,
} from '../db/queries';
import type { AppEnv } from '../env';
import { deleteCover, storeCover } from '../lib/covers';
import { parseDetails } from '../lib/share';
import {
  accNo,
  Cover,
  DetailsList,
  ItemForm,
  MEDIA_LABEL,
  NotOwnedPill,
  StatusPill,
  stars,
} from '../views/components';
import { page } from '../views/layout';

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
  const details = JSON.stringify(parseDetails(str('details') || '{}'));

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
  const parsed = parseItemForm(await c.req.parseBody());
  if (!parsed) return c.text('Title and shelf are required.', 400);
  const lib = await getLibrary(c.env.DB, parsed.values.libraryId);
  if (!lib) return c.text('No such shelf.', 400);

  const coverKey = await storeCover(c.env.COVERS, parsed.coverUrl);
  const item = await createItem(c.env.DB, {
    ...parsed.values,
    coverKey,
    addedBy: c.get('user').id,
  });
  if (parsed.tags.length) await setItemTags(c.env.DB, item.id, parsed.tags);
  return c.redirect(`/items/${item.id}`);
});

items.get('/items/:id', async (c) => {
  const id = Number(c.req.param('id'));
  const item = await getItem(c.env.DB, id);
  if (!item) return c.notFound();
  const [lib, tags, loan, addedBy] = await Promise.all([
    getLibrary(c.env.DB, item.libraryId),
    tagsForItem(c.env.DB, id),
    activeLoanForItem(c.env.DB, id),
    item.addedBy ? getUserById(c.env.DB, item.addedBy) : Promise.resolve(null),
  ]);
  const today = new Date().toISOString().slice(0, 10);
  const overdue = !!(loan?.dueOn && loan.dueOn < today);
  const details = parseDetails(item.details);

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
            {item.copies === 0 ? <NotOwnedPill /> : null}
            {loan ? <span class={overdue ? 'pill overdue' : 'pill lent'}>{overdue ? 'Overdue' : 'Lent'}</span> : null}
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

        {item.notes ? (
          <div class="detail-section">
            <p class="eyebrow">Private notes — never on share pages</p>
            <p class="prewrap">{item.notes}</p>
          </div>
        ) : null}

        <div class={loan ? 'circulation' : 'circulation free'}>
          <p class="eyebrow">Circulation</p>
          {item.copies === 0 && !loan ? (
            <p class="muted">Not in the physical collection — nothing to lend.</p>
          ) : loan ? (
            <form method="post" action={`/loans/${loan.id}/return`} class="inline-form">
              <span class={overdue ? 'error' : undefined}>
                Lent to <strong>{loan.borrower}</strong> on <span class="mono">{loan.loanedOn}</span>
                {loan.dueOn ? (
                  <>
                    , due <span class="mono">{loan.dueOn}</span>
                  </>
                ) : null}
              </span>
              <button type="submit" class="btn">
                Mark returned
              </button>
            </form>
          ) : (
            <form method="post" action={`/items/${item.id}/loan`} class="inline-form">
              <input name="borrower" placeholder="Borrower" required />
              <input name="contact" placeholder="Contact (optional)" />
              <input type="date" name="dueOn" aria-label="Due date" />
              <button type="submit" class="btn">
                Lend
              </button>
            </form>
          )}
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

items.post('/items/:id', async (c) => {
  const id = Number(c.req.param('id'));
  const existing = await getItem(c.env.DB, id);
  if (!existing) return c.notFound();
  const parsed = parseItemForm(await c.req.parseBody());
  if (!parsed) return c.text('Title and shelf are required.', 400);

  let coverKey = existing.coverKey;
  if (parsed.removeCover) {
    c.executionCtx.waitUntil(deleteCover(c.env.COVERS, existing.coverKey));
    coverKey = null;
  }
  if (parsed.coverUrl) {
    const newKey = await storeCover(c.env.COVERS, parsed.coverUrl);
    if (newKey) {
      c.executionCtx.waitUntil(deleteCover(c.env.COVERS, existing.coverKey));
      coverKey = newKey;
    }
  }

  await updateItem(c.env.DB, id, { ...parsed.values, coverKey });
  await setItemTags(c.env.DB, id, parsed.tags);
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
