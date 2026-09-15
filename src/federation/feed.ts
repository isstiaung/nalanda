// Following a connection's shared views — the receiving side of the feed
// (docs/proposals/connections.md §8). Pulls happen only while serving a page, after the response,
// so nothing runs in the background and a slow connection never holds up a page.
import {
  applyLifecycle,
  claimSubscription,
  dueSubscriptions,
  markSubscriptionGone,
  pruneOrphanThreads,
  recordPull,
  removeEntries,
  storedRemoteIds,
  storeEntries,
  takeFeedAllowance,
  type DueSubscription,
} from '../db/federation';
import type { Connection, FederationSettings } from '../db/schema';
import {
  FEED_PAGE_SIZE,
  MAX_CHECK_IDS,
  MAX_FEED_ENTRIES_PER_DAY,
  MAX_FEED_RESPONSE_BYTES,
  MAX_VIEW_NAME,
  SUBSCRIPTION_REFRESH_QUERIES,
} from './config';
import { budgeted, isBudgetSpent, type Budget } from './budget';
import { getSigned, postSigned } from './http';
import { isId, jsonBytes, keepForKind, parseFeedEntry, type FeedEntry } from './items';
import type { Identity } from './keys';

const isCount = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const asObject = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

// ---------- the views a connection shares ----------

export type SharedView = {
  id: number;
  name: string;
  itemCount: number;
  recent: { days: number; activities: number; bytes: number };
};

const MAX_VIEWS_READ = 50;

export function parseSharedViews(value: unknown): SharedView[] | null {
  const list = asObject(value)?.views;
  if (!Array.isArray(list)) return null;
  const views: SharedView[] = [];
  for (const raw of list.slice(0, MAX_VIEWS_READ)) {
    const v = asObject(raw);
    const recent = asObject(v?.recent);
    if (!v || !recent) continue;
    if (!isId(v.id) || typeof v.name !== 'string' || !v.name.trim() || v.name.length > MAX_VIEW_NAME) continue;
    if (!isCount(v.itemCount) || !isId(recent.days) || !isCount(recent.activities) || !isCount(recent.bytes)) continue;
    views.push({
      id: v.id,
      name: v.name,
      itemCount: v.itemCount,
      recent: { days: recent.days, activities: recent.activities, bytes: recent.bytes },
    });
  }
  return views;
}

export async function fetchSharedViews(
  identity: Identity,
  settings: FederationSettings,
  connection: Connection,
): Promise<SharedView[] | null> {
  const res = await getSigned(identity, settings.baseUrl, connection.baseUrl, '/federation/views');
  return res?.status === 200 ? parseSharedViews(res.body) : null;
}

/** Expected storage for a subscription: the view's recent rate over the retention period, capped by the entry limit. */
export function estimateBytes(recent: SharedView['recent'], retentionDays: number, maxEntries: number): number {
  if (!recent.activities) return 0;
  const byTime = (recent.bytes / recent.days) * retentionDays;
  const byCount = (recent.bytes / recent.activities) * maxEntries;
  return Math.round(Math.min(byTime, byCount));
}

export function perMonth(recent: SharedView['recent'], of: 'activities' | 'bytes'): number {
  return Math.round((recent[of] / recent.days) * 30);
}

export function formatBytes(n: number): string {
  if (n <= 0) return '0 KB';
  if (n < 1024) return '< 1 KB';
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// ---------- pulling ----------

type FeedPage = { latest: number; more: boolean; entries: FeedEntry[] };

export function parseFeedPage(value: unknown): FeedPage | null {
  const v = asObject(value);
  if (!v || !isCount(v.latest) || typeof v.more !== 'boolean' || !Array.isArray(v.entries)) return null;
  const entries: FeedEntry[] = [];
  // Past the page size the owner broke the protocol; what it sent beyond that isn't read.
  for (const raw of v.entries.slice(0, FEED_PAGE_SIZE)) {
    const entry = parseFeedEntry(raw);
    if (entry) entries.push(entry);
  }
  return { latest: v.latest, more: v.more, entries };
}

function parseCheck(value: unknown): { invalid: number[]; viewGone: boolean } | null {
  const v = asObject(value);
  if (!v || !Array.isArray(v.invalid) || typeof v.viewGone !== 'boolean') return null;
  return { invalid: v.invalid.slice(0, MAX_CHECK_IDS).filter(isId), viewGone: v.viewGone };
}

const isNoSuchView = (body: unknown) => asObject(body)?.error === 'no such view';

/**
 * One pull: new entries since the cursor, within the connection's daily allowance, then the removal check over
 * everything still stored. The receiver's own lifecycle rules run however it ends, so expired entries go even
 * when the owner can't be reached. Failures are recorded on the subscription for the Connections page. `db`
 * may be a budgeted handle: a pull cut short resumes from its recorded cursor, and storing is idempotent.
 */
export async function refreshSubscription(
  db: D1Database,
  identity: Identity,
  settings: FederationSettings,
  sub: DueSubscription,
): Promise<void> {
  try {
    const { connection } = sub;
    const res = await getSigned(
      identity,
      settings.baseUrl,
      connection.baseUrl,
      `/federation/feed?view=${sub.viewId}&since=${sub.cursor}`,
      MAX_FEED_RESPONSE_BYTES,
    );
    if (!res) return await recordPull(db, sub, { error: 'Couldn’t reach them.' });
    if (res.status === 404 && isNoSuchView(res.body)) return await markSubscriptionGone(db, sub.id);
    if (res.status === 401) return await recordPull(db, sub, { error: 'They turned the request away — they may have disconnected.' });
    if (res.status !== 200) return await recordPull(db, sub, { error: `They answered HTTP ${res.status}.` });
    const page = parseFeedPage(res.body);
    if (!page) return await recordPull(db, sub, { error: 'They sent a feed this library couldn’t read.' });

    const allowed = await takeFeedAllowance(db, connection.id, page.entries.length, MAX_FEED_ENTRIES_PER_DAY);
    await storeEntries(
      db,
      sub.id,
      page.entries.slice(0, allowed).map((e) => {
        const { json, bytes } = jsonBytes(keepForKind(e.item, e.kind));
        return { remoteId: e.id, itemRemoteId: e.item.id, kind: e.kind, publishedAt: e.published, item: json, bytes };
      }),
    );
    const dropped = allowed < page.entries.length;
    await recordPull(db, sub, {
      cursor: page.latest,
      error: dropped ? 'Some entries were dropped: they sent more than a day’s allowance.' : null,
      // More waiting, and this pull got somewhere: due again on a later page load. A connection that keeps
      // saying "more" without moving its cursor waits its interval like everyone else.
      again: page.more && !dropped && page.latest !== sub.cursor,
    });
    await checkRemovals(db, identity, settings, sub);
    await pruneOrphanThreads(db); // our copies of threads go with the entries they belong to
  } finally {
    await applyLifecycle(db, sub);
  }
}

/** Removals always apply: whatever the owner no longer shares is deleted here, whatever the lifecycle settings. */
async function checkRemovals(d1: D1Database, identity: Identity, settings: FederationSettings, sub: DueSubscription) {
  const ids = await storedRemoteIds(d1, sub.id);
  if (!ids.length) return;
  const res = await postSigned(identity, settings.baseUrl, sub.connection.baseUrl, '/federation/feed/check', {
    view: sub.viewId,
    ids: ids.slice(0, MAX_CHECK_IDS),
  });
  const verdict = res?.status === 200 ? parseCheck(res.body) : null;
  if (!verdict) return; // checked again on the next pull
  if (verdict.viewGone) return markSubscriptionGone(d1, sub.id);
  const asked = new Set(ids);
  await removeEntries(
    d1,
    sub.id,
    verdict.invalid.filter((id) => asked.has(id)),
  );
}

/**
 * Refreshes the most overdue subscriptions after a page's response, one at a time while this request's
 * background query budget lasts. Whatever doesn't fit waits for a later page load.
 */
export async function refreshDue(d1: D1Database, identity: Identity, settings: FederationSettings, budget: Budget): Promise<void> {
  const db = budgeted(d1, budget);
  try {
    while (budget.left >= SUBSCRIPTION_REFRESH_QUERIES) {
      const [sub] = await dueSubscriptions(db, 1);
      if (!sub || !(await claimSubscription(db, sub.id, sub.lastPulledAt))) return;
      try {
        await refreshSubscription(db, identity, settings, sub);
      } catch (err) {
        if (isBudgetSpent(err)) return;
        console.error('feed refresh failed', err);
        await recordPull(db, sub, { error: 'The last pull failed.' });
      }
    }
  } catch (err) {
    if (!isBudgetSpent(err)) throw err;
  }
}
