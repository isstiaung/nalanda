// Bulk edit (ARCH.md §16 #47): one action on the items checked on a shelf page or in search results. Each action is
// one D1 batch (src/db/queries.ts), and a plain form post — the redirect carries back what it did.
import { writerOf } from './items';
import { Hono, type Context } from 'hono';
import {
  BULK_ACTIONS,
  BULK_MAX,
  bulkAddTags,
  bulkDelete,
  bulkMove,
  bulkRemoveTags,
  bulkSetOwned,
  getLibrary,
  itemsForConfirmation,
  normalizeTags,
  type BulkAction,
  type BulkResult,
} from '../db/queries';
import type { AppEnv } from '../env';
import { deleteCover } from '../lib/covers';
import { DeleteConfirmation } from '../views/bulk';
import { page } from '../views/layout';

const bulk = new Hono<AppEnv>();

/** The pages the bar lives on — a shelf or search results, with their query. Anything else goes home: no open redirect. */
const BACK = /^\/(?:libraries\/\d{1,15}|search)(?:\?[^#\\\s]*)?$/;
const safeBack = (raw: string) => (BACK.test(raw) ? raw : '/');

/** The query keys a notice uses, cleared from the page's own query before a new notice is set. */
const NOTICE_KEYS = ['bulk', 'n', 'same', 'skipped', 'to'];

function withNotice(back: string, action: BulkAction, r: BulkResult, to?: number): string {
  if (back === '/') return back;
  const url = new URL(back, 'http://nalanda.invalid');
  for (const k of NOTICE_KEYS) url.searchParams.delete(k);
  url.searchParams.set('bulk', action);
  url.searchParams.set('n', String(r.changed));
  if (r.same) url.searchParams.set('same', String(r.same));
  if (r.skipped) url.searchParams.set('skipped', String(r.skipped));
  if (to !== undefined) url.searchParams.set('to', String(to));
  return `${url.pathname}${url.search}`;
}

/** Selected ids: whole, positive, each once, in the order sent. */
function parseIds(raw: unknown): number[] {
  const list = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
  const ids = new Set<number>();
  for (const v of list) {
    if (typeof v !== 'string' || !/^\d{1,15}$/.test(v.trim())) continue;
    const n = Number(v.trim());
    if (n > 0) ids.add(n);
  }
  return [...ids];
}

const one = (raw: unknown): string => (typeof raw === 'string' ? raw.trim() : Array.isArray(raw) && typeof raw[0] === 'string' ? raw[0].trim() : '');

/** A refusal as a page: what was wrong, and the way back to the selection. */
async function refuse(c: Context<AppEnv>, status: 400 | 403, message: string, back: string) {
  c.status(status);
  return page(
    c,
    'Bulk edit',
    <>
      <div class="page-head">
        <div>
          <h1>Nothing changed</h1>
        </div>
      </div>
      <p class="error" role="alert">{message}</p>
      <p>
        <a href={back}>← Back</a>
      </p>
    </>,
  );
}

bulk.post('/bulk', async (c) => {
  const body = await c.req.parseBody({ all: true });
  const back = safeBack(one(body['back']));
  const action = one(body['action']);
  if (!(BULK_ACTIONS as readonly string[]).includes(action)) return refuse(c, 400, 'Choose an action for the selected items.', back);
  const act = action as BulkAction;

  // The owner's call: deleting in bulk is an admin's, though any member can delete one item from its page. Refused
  // before anything is read, confirmation page included — a member never sees the titles it would have listed.
  if (act === 'delete' && c.get('user').role !== 'admin') {
    return c.text('Only an admin can delete items in bulk. A member can delete an item from its own page.', 403);
  }

  const ids = parseIds(body['id']);
  if (!ids.length) return refuse(c, 400, 'Select at least one item first.', back);
  if (ids.length > BULK_MAX) {
    return refuse(c, 400, `One action takes up to ${BULK_MAX} items, and ${ids.length} were selected. Select fewer and try again.`, back);
  }

  let result: BulkResult;
  let to: number | undefined;
  switch (act) {
    case 'tag-add':
    case 'tag-remove': {
      const names = normalizeTags(one(body['tag']).split(','));
      if (!names.length) return refuse(c, 400, 'Type the tag to add or remove.', back);
      if (names.length > 20 || names.some((n) => n.length > 100)) return refuse(c, 400, 'That is too many tags, or too long a tag, for one action.', back);
      result = act === 'tag-add' ? await bulkAddTags(c.env.DB, ids, names) : await bulkRemoveTags(c.env.DB, ids, names);
      break;
    }
    case 'move': {
      const raw = one(body['libraryId']);
      const lib = /^\d{1,15}$/.test(raw) ? await getLibrary(c.env.DB, Number(raw)) : null;
      if (!lib) return refuse(c, 400, 'Choose the shelf to move them to.', back);
      result = await bulkMove(c.env.DB, ids, lib.id, writerOf(c));
      to = lib.id;
      break;
    }
    case 'owned':
    case 'not-owned':
      result = await bulkSetOwned(c.env.DB, ids, act === 'owned', writerOf(c));
      break;
    case 'delete': {
      if (one(body['confirm']) !== '1') {
        const found = await itemsForConfirmation(c.env.DB, ids);
        if (!found.length) return refuse(c, 400, 'None of the selected items exist any more.', back);
        return page(c, 'Delete items', <DeleteConfirmation items={found} back={back} />);
      }
      result = await bulkDelete(c.env.DB, ids, { id: c.get('user').id, sessionKey: c.get('user').sessionKey }); // into the trash (§16 #74)
      // not these items' covers — those stay until their rows are purged — but the covers of rows purged on the way
      c.executionCtx.waitUntil(Promise.all(result.covers.map((k) => deleteCover(c.env.COVERS, k))));
      break;
    }
  }
  return c.redirect(withNotice(back, act, result, to));
});

export default bulk;
