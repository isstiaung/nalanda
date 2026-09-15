// Work a page load starts after its response (docs/proposals/connections.md §8): pulling connections'
// outboxes, then followed feeds — all within one budget of D1 queries, because the free plan allows 50 per
// invocation and waitUntil work belongs to the page's. Nothing here runs unless someone opens a page.
import type { Context } from 'hono';
import type { FederationSettings } from '../db/schema';
import type { AppEnv } from '../env';
import { BACKGROUND_QUERY_BUDGET, OUTBOX_QUERY_SHARE } from './config';
import { refreshDue } from './feed';
import type { Identity } from './keys';
import { refreshOutboxes } from './outbox';

export function refreshInBackground(c: Context<AppEnv>, identity: Identity, settings: FederationSettings, feeds: boolean): void {
  c.executionCtx.waitUntil(
    (async () => {
      // Messages addressed to this household first — pulling is their delivery guarantee — within a share of the
      // budget, so a backlog can't crowd out feeds. Feeds get whatever is left.
      const outboxes = { left: OUTBOX_QUERY_SHARE };
      await refreshOutboxes(c.env.DB, identity, settings, outboxes);
      if (feeds) {
        await refreshDue(c.env.DB, identity, settings, { left: BACKGROUND_QUERY_BUDGET - (OUTBOX_QUERY_SHARE - outboxes.left) });
      }
    })().catch((err) => console.error('background refresh failed', err)),
  );
}
