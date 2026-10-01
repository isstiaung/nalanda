// FEDERATION_OFFLINE (ARCH.md §16 #92): a plain runtime variable — a `vars` entry in wrangler.jsonc or a line in
// .dev.vars, never a secret — that keeps this instance from contacting any connected household. It is for a copy
// of a production database restored somewhere else: its `connections` table still names the real peers, and the
// first page load would otherwise pull their outboxes and retry pushes against them. Set, it stops every background
// pull and push (refreshInBackground), every message a page would send (pushQueued, pushNow, notifyPeer, the
// connect handshake and a recommendation's descriptor check) and the live reads of a connection's shelves; what
// peers sign to this instance is still answered as before. Production leaves it unset.
import type { Bindings } from '../env';

/** Whether the variable is set to anything that means yes: not blank, and not 0, false, no or off. */
export function federationOffline(env: Pick<Bindings, 'FEDERATION_OFFLINE'>): boolean {
  const raw = env.FEDERATION_OFFLINE;
  if (raw === undefined || raw === null) return false;
  const value = String(raw).trim().toLowerCase();
  return value !== '' && value !== '0' && value !== 'false' && value !== 'no' && value !== 'off';
}

/** What a page says in place of contacting anyone. */
export const OFFLINE_NOTICE = 'Connections are offline on this copy (FEDERATION_OFFLINE is set): nothing is sent to or fetched from any household.';
