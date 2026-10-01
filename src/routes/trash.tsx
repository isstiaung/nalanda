// The trash (ARCH.md §16 #74): what was deleted in the last 30 days, to restore or let go. Admin-only, like deleting
// in bulk and the other pages that undo what members did.
import { Hono } from 'hono';
import { discardTrash, getTrash, listLibraries, listMembersWithKeys, listTrash, memberKeys, purgeTrash, restoreFromTrash, TRASH_DAYS, type TrashRow } from '../db/queries';
import type { AppEnv } from '../env';
import { deleteCover } from '../lib/covers';
import { ledgerDateTime } from '../lib/dates';
import { MEDIA_ICON, MEDIA_LABEL } from '../views/components';
import { page } from '../views/layout';

const trash = new Hono<AppEnv>();

trash.use('/trash/*', async (c, next) => {
  if (c.get('user').role !== 'admin') return c.text('Only an admin can see the trash or restore from it.', 403);
  return next();
});
trash.use('/trash', async (c, next) => {
  if (c.get('user').role !== 'admin') return c.text('Only an admin can see the trash or restore from it.', 403);
  return next();
});

trash.get('/trash', async (c) => {
  // what is past its time goes first, its covers with it: the free tier has no cron, so a visit does the sweep
  const expired = await purgeTrash(c.env.DB);
  if (expired.length) c.executionCtx.waitUntil(Promise.all(expired.map((k) => deleteCover(c.env.COVERS, k))));
  const [rows, shelves, people] = await Promise.all([listTrash(c.env.DB), listLibraries(c.env.DB), listMembersWithKeys(c.env.DB)]);
  const shelfName = new Map(shelves.map((l) => [l.id, l.name]));
  // who deleted it, only while that id still has the key it had (§16 #56): a member given the id since is not named
  const personName = (r: TrashRow) => people.find((p) => p.id === r.deletedBy && p.sessionKey === r.deletedByKey)?.username ?? null;
  const restored = c.req.query('restored');
  const gone = c.req.query('gone') === '1';
  const refusedId = /^\d{1,15}$/.test(c.req.query('noshelf') ?? '') ? Number(c.req.query('noshelf')) : null;
  const refused = refusedId === null ? null : await getTrash(c.env.DB, refusedId);
  return page(
    c,
    'Trash',
    <>
      <div class="page-head">
        <div>
          <h1>Trash</h1>
          <span class="sub">
            {rows.length} {rows.length === 1 ? 'ITEM' : 'ITEMS'} · KEPT {TRASH_DAYS} DAYS
          </span>
        </div>
      </div>
      {restored ? (
        <p class="notice">
          Restored. <a href={`/items/${restored}`}>Open it</a> — it is back on its shelf, with its tags, reads, reviews, plays and loans.
        </p>
      ) : null}
      {gone ? <p class="notice">Deleted for good.</p> : null}
      {c.req.query('expired') === '1' ? (
        <p class="error" role="alert">
          That item was past its {TRASH_DAYS} days, and has gone for good.
        </p>
      ) : null}
      {refused ? (
        <p class="error" role="alert">
          “{refused.title}” can’t be restored yet: its shelf{refused.libraryName ? ` “${refused.libraryName}”` : ''} is no longer here. Make a
          shelf {refused.libraryName ? `named “${refused.libraryName}”` : 'for it'} and try again.
        </p>
      ) : null}
      <p class="muted">
        A deleted item waits here for {TRASH_DAYS} days with everything it had, then goes for good. Restoring gives it a new
        number on its shelf; a connected household sees it as newly added.
      </p>
      {rows.length ? (
        <table class="data-table trash-table">
          <thead>
            <tr>
              <th scope="col">Item</th>
              <th scope="col" class="hide-sm">Shelf</th>
              <th scope="col" class="hide-sm">Deleted</th>
              <th scope="col">
                <span class="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <TrashLine row={r} shelf={shelfName.get(r.libraryId ?? -1) ?? r.libraryName} by={personName(r)} />
            ))}
          </tbody>
        </table>
      ) : (
        <p class="muted">Nothing in the trash.</p>
      )}
    </>,
  );
});

const TrashLine = ({ row, shelf, by }: { row: TrashRow; shelf: string | null; by: string | null }) => (
  <tr>
    <td data-label="Item">
      <span aria-hidden="true">{MEDIA_ICON[row.mediaType] ?? ''}</span> <strong>{row.title}</strong>
      {row.creators ? <small class="muted"> · {row.creators}</small> : null}
      <small class="muted"> · {MEDIA_LABEL[row.mediaType] ?? row.mediaType}</small>
    </td>
    <td data-label="Shelf" class="hide-sm">
      {shelf ?? <span class="muted">a shelf since removed</span>}
    </td>
    <td data-label="Deleted" class="hide-sm">
      <span class="mono">{ledgerDateTime(row.deletedAt)}</span>
      {by ? <small class="muted"> by {by}</small> : null}
    </td>
    <td class="actions-cell">
      <form method="post" action={`/trash/${row.id}/restore`} class="inline">
        <button type="submit" class="btn">
          Restore
        </button>
      </form>{' '}
      <form method="post" action={`/trash/${row.id}/discard`} class="inline" data-confirm={`Delete “${row.title}” for good? It can’t be restored after this.`}>
        <button type="submit" class="btn-danger">
          Delete for good
        </button>
      </form>
    </td>
  </tr>
);

const idOf = (raw: string) => (/^\d{1,15}$/.test(raw) ? Number(raw) : null);

trash.post('/trash/:id/restore', async (c) => {
  const id = idOf(c.req.param('id'));
  if (id === null) return c.notFound();
  const outcome = await restoreFromTrash(c.env.DB, id, memberKeys(await listMembersWithKeys(c.env.DB)));
  if ('refused' in outcome) {
    if (outcome.refused === 'gone') return c.notFound();
    return c.redirect(outcome.refused === 'expired' ? '/trash?expired=1' : `/trash?noshelf=${id}`);
  }
  return c.redirect(`/trash?restored=${outcome.id}`);
});

trash.post('/trash/:id/discard', async (c) => {
  const id = idOf(c.req.param('id'));
  if (id === null) return c.notFound();
  const coverKey = await discardTrash(c.env.DB, id);
  c.executionCtx.waitUntil(deleteCover(c.env.COVERS, coverKey));
  return c.redirect('/trash?gone=1');
});

export default trash;
