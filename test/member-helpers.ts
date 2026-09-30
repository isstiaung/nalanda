// Shared by the per-member specs (ARCH.md §16 #43): a household of named people, each signed in, and requests made
// as one of them.
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { createItem, createLibrary, createUser, updateSiteSettings } from '../src/db/queries';
import type { Item, NewItem } from '../src/db/schema';
import { createSessionToken, SESSION_COOKIE } from '../src/lib/auth';
import app from '../src/index';

export type Member = { id: number; name: string; cookie: string; admin: boolean; sessionKey: string };

/**
 * The switches as an instance upgraded from before reading goals has them: names and goals off, the old defaults,
 * which migration 0036 pins for every instance that already had members (§16 #49). A new instance starts with them on, so a test about
 * names off — or the household's unnamed stream — says so with this.
 */
export const upgradedSwitches = () =>
  updateSiteSettings(env.DB, { namesOnShares: false, namesToConnections: false, goalsToConnections: false });

export async function member(name: string, role: 'admin' | 'member' = 'member'): Promise<Member> {
  const user = await createUser(env.DB, { username: name, passwordHash: 'pbkdf2$1$x$y', role, mustChangePassword: false });
  const token = await createSessionToken(env.SESSION_SECRET, user, Math.floor(Date.now() / 1000));
  return { id: user.id, name, cookie: `${SESSION_COOKIE}=${token}`, admin: role === 'admin', sessionKey: user.sessionKey };
}

/** Who a DB call acts as. */
export const actor = (m: Member) => ({ id: m.id, admin: m.admin });

/** A request as `who` — or signed out. A body makes it a POST. */
export async function as(
  who: Member | null,
  path: string,
  init: { body?: Record<string, string>; htmx?: boolean; json?: unknown } = {},
): Promise<Response> {
  const headers: Record<string, string> = { origin: 'http://nalanda.test' };
  if (who) headers.cookie = who.cookie;
  if (init.htmx) headers['HX-Request'] = 'true';
  let body: string | undefined;
  if (init.json !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(init.json);
  } else if (init.body) {
    headers['content-type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(init.body).toString();
  }
  const ctx = createExecutionContext();
  const res = await app.fetch(
    new Request(`http://nalanda.test${path}`, { method: body === undefined ? 'GET' : 'POST', headers, body, redirect: 'manual' }),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

export const html = async (who: Member | null, path: string) => (await as(who, path)).text();

export const rows = async <T = Record<string, unknown>>(query: string, ...binds: unknown[]) =>
  (await env.DB.prepare(query).bind(...binds).all<T>()).results;

/** A book — on its own new shelf unless `values` names one — its status, dates, rating and review `by` someone (its added_by). */
export async function book(by: Member | null, values: Partial<NewItem> = {}): Promise<Item> {
  return createItem(env.DB, {
    libraryId: values.libraryId ?? (await createLibrary(env.DB, 'Household shelf')).id,
    mediaType: 'book',
    title: 'The Dispossessed',
    length: 300,
    details: '{}',
    addedBy: by?.id ?? null,
    ...values,
  });
}

export const readsOf = (itemId: number) =>
  rows<{ id: number; readerId: number | null; status: string; beganOn: string | null; endedOn: string | null }>(
    'SELECT id, reader_id AS readerId, status, began_on AS beganOn, ended_on AS endedOn FROM reads WHERE item_id = ?1 ORDER BY id',
    itemId,
  );

export const reviewsOf = (itemId: number) =>
  rows<{ id: number; userId: number | null; rating: number | null; review: string | null; reviewedAt: string | null }>(
    'SELECT id, user_id AS userId, rating, review, reviewed_at AS reviewedAt FROM reviews WHERE item_id = ?1 ORDER BY id',
    itemId,
  );

export const openReadOf = async (itemId: number, who: Member) =>
  (await rows<{ id: number }>("SELECT id FROM reads WHERE item_id = ?1 AND reader_id = ?2 AND status = 'in_progress'", itemId, who.id))[0]!.id;

/** The item columns the household summary lives in. */
export const summaryOf = async (itemId: number) =>
  (
    await rows<Record<string, unknown>>(
      'SELECT status, began_on AS beganOn, completed_on AS completedOn, read_count AS readCount, rereading, progress_page AS progressPage, rating, review FROM items WHERE id = ?1',
      itemId,
    )
  )[0]!;
