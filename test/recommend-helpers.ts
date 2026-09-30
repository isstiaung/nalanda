// Shared by the recommendation specs (ARCH.md §16 #58): the other household, as A's outbound requests meet it — its
// descriptor, with or without `accepts`, its inbox, and its covers.
import { env } from 'cloudflare:test';
import type { Recommend, RecommendedItem } from '../src/federation/messages';
import { recommend } from '../src/federation/messages';
import { answerOutbound, decode, json, type Outbound, type Peer } from './federation-helpers';

/** A descriptor as `peer` serves it: 1.4.0's shape, plus `accepts` from this version on. */
export const descriptorOf = (peer: Peer, accepts?: unknown) => ({
  protocol: 'nalanda-connections',
  version: 1,
  name: peer.name,
  url: peer.url,
  publicKey: peer.publicJwk,
  ...(accepts !== undefined ? { accepts } : {}),
});

export const COVER_KEY = '1b4e28ba-2fa1-11d2-883f-0016d3cca427';
/** Bytes a cover fetch gets back: an image, past storeCover's 500-byte floor. */
export const coverBytes = () => new Uint8Array(900).fill(7);

export type PeerSide = {
  /** Every request A made, in order. */
  log: Outbound[];
  /** The bodies A pushed to their inbox. */
  pushes: Array<Record<string, unknown>>;
};

/**
 * Answers A's outbound requests as `peer` would: its descriptor (listing `accepts` unless it's undefined — an older
 * household), its inbox by `inbox` (a status, or 'unreachable'), its covers, and 404 for anything else.
 */
export function peerSide(
  peer: Peer,
  opts: { accepts?: unknown; inbox?: number | 'unreachable' | ((body: Uint8Array) => Response); outbox?: unknown } = {},
): PeerSide {
  const pushes: Array<Record<string, unknown>> = [];
  const accepts = 'accepts' in opts ? opts.accepts : ['Recommend'];
  const log = answerOutbound((req) => {
    const url = new URL(req.url);
    if (url.origin !== peer.url) return json({}, 404);
    if (url.pathname === '/.well-known/nalanda') return json(descriptorOf(peer, accepts));
    if (url.pathname === '/federation/inbox') {
      pushes.push(decode(req.body));
      const inbox = opts.inbox ?? 200;
      if (inbox === 'unreachable') throw new TypeError('unreachable');
      if (typeof inbox === 'function') return inbox(req.body);
      return json(inbox < 300 ? { status: 'received' } : { error: 'refused' }, inbox);
    }
    if (url.pathname === `/covers/${COVER_KEY}`) return new Response(coverBytes(), { headers: { 'content-type': 'image/jpeg' } });
    if (url.pathname === '/federation/outbox' && opts.outbox !== undefined) return json(opts.outbox);
    return json({}, 404);
  });
  return { log, pushes };
}

/** A recommendation from `peer` of one of its items. */
export function theirRecommendation(
  peer: Peer,
  item: Partial<RecommendedItem> = {},
  recommender = 'Priya',
  note: string | null = 'You would love this.',
): Recommend {
  return recommend(
    peer.url,
    {
      id: 7,
      stamp: '0123456789abcdef',
      view: 2,
      mediaType: 'book',
      title: 'The Left Hand of Darkness',
      creators: 'Ursula K. Le Guin',
      published: '1969',
      coverKey: COVER_KEY,
      ids: {},
      ...item,
    },
    recommender,
    note,
  );
}

export const rows = async <T = Record<string, unknown>>(query: string, ...binds: unknown[]) =>
  (await env.DB.prepare(query).bind(...binds).all<T>()).results;

/** Makes every undelivered outbox message due for a retry on the next page load. */
export const retryDue = () => env.DB.prepare("UPDATE outbox SET attempted_at = datetime('now', '-1 hour')").run();

/** Outbound requests to one path of theirs. */
export const to = (log: Outbound[], path: string) => log.filter((r) => new URL(r.url).pathname === path);
