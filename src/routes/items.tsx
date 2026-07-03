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
  Cover,
  DetailsList,
  ItemForm,
  MEDIA_ICON,
  MEDIA_LABEL,
  STATUS_LABEL,
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
      copies: Number.isFinite(copiesNum) && copiesNum > 0 ? copiesNum : 1,
      beganOn: orNull(str('beganOn')),
      completedOn: orNull(str('completedOn')),
      details,
    },
    tags: str('tags').split(',').map((t) => t.trim()).filter(Boolean),
    coverUrl: str('coverUrl'),
    removeCover: str('removeCover') === '1',
  };
}

items.post('/items', async (c) => {
  const parsed = parseItemForm(await c.req.parseBody());
  if (!parsed) return c.text('Title and library are required.', 400);
  const lib = await getLibrary(c.env.DB, parsed.values.libraryId);
  if (!lib) return c.text('No such library.', 400);

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
          <p>{item.creators}</p>
        </hgroup>
        <p class="muted">
          {MEDIA_ICON[item.mediaType]} {MEDIA_LABEL[item.mediaType]}
          {lib ? (
            <>
              {' · '}
              <a href={`/libraries/${lib.id}`}>{lib.name}</a>
            </>
          ) : null}
          {item.published ? ` · ${item.published}` : ''}
          {item.publisher ? ` · ${item.publisher}` : ''}
          {item.length ? ` · ${item.length}` : ''}
          {item.copies > 1 ? ` · ${item.copies} copies` : ''}
        </p>
        <p>
          <span class="badge">{STATUS_LABEL[item.status]}</span>{' '}
          {item.rating ? <span class="rating">{stars(item.rating)}</span> : null}
          {loan ? <span class="badge warn">on loan to {loan.borrower}</span> : null}
        </p>
        {tags.length ? (
          <p>
            {tags.map((t) => (
              <a href={`/tags/${encodeURIComponent(t)}`} class="tag">
                #{t}
              </a>
            ))}
          </p>
        ) : null}
        {item.description ? <p class="prewrap">{item.description}</p> : null}
        <DetailsList details={parseDetails(item.details)} />
        {item.review ? (
          <section>
            <h4>Review</h4>
            <p class="prewrap">{item.review}</p>
          </section>
        ) : null}
        {item.notes ? (
          <section>
            <h4>
              Private notes <small class="muted">(never on share pages)</small>
            </h4>
            <p class="prewrap">{item.notes}</p>
          </section>
        ) : null}

        <section>
          {loan ? (
            <form method="post" action={`/loans/${loan.id}/return`} class="inline-form">
              <span class={loan.dueOn && loan.dueOn < today ? 'error' : 'muted'}>
                Lent to {loan.borrower} on {loan.loanedOn}
                {loan.dueOn ? `, due ${loan.dueOn}` : ''}
              </span>
              <button type="submit" class="secondary">
                Mark returned
              </button>
            </form>
          ) : (
            <details>
              <summary>Lend this out</summary>
              <form method="post" action={`/items/${item.id}/loan`} class="inline-form">
                <input name="borrower" placeholder="Who?" required />
                <input name="contact" placeholder="Contact (optional)" />
                <input type="date" name="dueOn" aria-label="Due date" />
                <button type="submit">Lend</button>
              </form>
            </details>
          )}
        </section>

        <p class="muted">
          Added {item.addedAt}
          {addedBy ? ` by ${addedBy.username}` : ''}
        </p>
        <div class="actions">
          <a href={`/items/${item.id}/edit`} role="button" class="secondary">
            Edit
          </a>
          <form
            method="post"
            action={`/items/${item.id}/delete`}
            class="inline"
            onsubmit="return confirm('Delete this item?')"
          >
            <button type="submit" class="danger">
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
      <h1>Edit item</h1>
      <ItemForm libraries={libs} action={`/items/${id}`} submitLabel="Save changes" item={item} tags={tags} />
    </>,
  );
});

items.post('/items/:id', async (c) => {
  const id = Number(c.req.param('id'));
  const existing = await getItem(c.env.DB, id);
  if (!existing) return c.notFound();
  const parsed = parseItemForm(await c.req.parseBody());
  if (!parsed) return c.text('Title and library are required.', 400);

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
