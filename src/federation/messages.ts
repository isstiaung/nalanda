// The messages connected instances exchange (docs/proposals/connections.md §5). Shaped as
// ActivityStreams 2.0 objects — `@context`, `type`, `id`, `actor` — with types of Nalanda's own,
// named for what they mean, since nothing outside Nalanda needs to read them.
import { isHouseholdName, normaliseBaseUrl } from './http';
import { isPublicJwk, type PublicJwk } from './keys';

export const AS2_CONTEXT = 'https://www.w3.org/ns/activitystreams';

type Envelope = { '@context': typeof AS2_CONTEXT; id: string; actor: string };

/** Sent to /federation/connect when redeeming an invitation. */
export type ConnectRequest = Envelope & { type: 'ConnectRequest'; name: string; publicKey: PublicJwk; token: string };

export const INBOX_TYPES = ['ConnectAccept', 'ConnectDecline', 'Disconnect'] as const;
export type InboxType = (typeof INBOX_TYPES)[number];
/** Sent to /federation/inbox. Later phases add types; unknown ones are rejected. */
export type InboxMessage = Envelope & { type: InboxType };

const ACTIVITY_ID = /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function newActivityId(): string {
  return `urn:uuid:${crypto.randomUUID()}`;
}

export function connectRequest(actor: string, name: string, publicKey: PublicJwk, token: string): ConnectRequest {
  return { '@context': AS2_CONTEXT, type: 'ConnectRequest', id: newActivityId(), actor, name, publicKey, token };
}

export function inboxMessage(type: InboxType, actor: string): InboxMessage {
  return { '@context': AS2_CONTEXT, type, id: newActivityId(), actor };
}

function isEnvelope(value: unknown): value is Envelope & Record<string, unknown> {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    v['@context'] === AS2_CONTEXT &&
    typeof v.id === 'string' &&
    ACTIVITY_ID.test(v.id) &&
    typeof v.actor === 'string' &&
    normaliseBaseUrl(v.actor) === v.actor
  );
}

export function parseConnectRequest(value: unknown): ConnectRequest | null {
  if (!isEnvelope(value) || value.type !== 'ConnectRequest') return null;
  const { name, publicKey, token } = value;
  if (!isHouseholdName(name) || !isPublicJwk(publicKey)) return null;
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  return { '@context': AS2_CONTEXT, type: 'ConnectRequest', id: value.id, actor: value.actor, name, publicKey, token };
}

export function parseInboxMessage(value: unknown): InboxMessage | null {
  if (!isEnvelope(value) || !(INBOX_TYPES as readonly unknown[]).includes(value.type)) return null;
  return { '@context': AS2_CONTEXT, type: value.type as InboxType, id: value.id, actor: value.actor };
}
