// Addresses and outbound requests between connected instances
// (docs/proposals/connections.md §5, §6).
import {
  DESCRIPTOR_PATH,
  DESCRIPTOR_TIMEOUT_MS,
  FETCH_TIMEOUT_MS,
  INVITE_PATH,
  MAX_DESCRIPTOR_BYTES,
  MAX_HOUSEHOLD_NAME,
  MAX_RESPONSE_BYTES,
  PROTOCOL,
  PROTOCOL_VERSION,
} from './config';
import { isPublicJwk, type Identity, type PublicJwk } from './keys';
import { signRequest } from './signatures';

export type Descriptor = {
  protocol: typeof PROTOCOL;
  version: typeof PROTOCOL_VERSION;
  name: string;
  url: string;
  publicKey: PublicJwk;
};

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * A peer's base address, normalised to its origin — or null. https only, except plain http for
 * localhost so two local instances can connect in development. No credentials, path or query:
 * an instance is identified by its origin alone.
 */
export function normaliseBaseUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.username || url.password || url.search || url.hash) return null;
  if (url.pathname !== '/' && url.pathname !== '') return null;
  const local = LOCAL_HOSTS.has(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) return null;
  return url.origin;
}

/**
 * An invite link: `<origin>/connect#<token>`. The token rides in the fragment, which browsers
 * never send to a server — so opening the link by mistake doesn't put it in anyone's logs.
 */
export function inviteLink(baseUrl: string, token: string): string {
  return `${baseUrl}${INVITE_PATH}#${token}`;
}

export function parseInviteLink(raw: string): { baseUrl: string; token: string } | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.pathname !== INVITE_PATH || url.search) return null;
  const token = url.hash.slice(1);
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const baseUrl = normaliseBaseUrl(url.origin);
  return baseUrl ? { baseUrl, token } : null;
}

/** Reads at most `maxBytes` of a body, abandoning the stream past that. Null when too large. */
export async function readLimited(
  message: { headers: Headers; body: ReadableStream<Uint8Array> | null },
  maxBytes: number,
): Promise<Uint8Array | null> {
  if (Number(message.headers.get('content-length') ?? '0') > maxBytes) {
    await message.body?.cancel();
    return null;
  }
  if (!message.body) return new Uint8Array();
  const reader = message.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export function parseJson(bytes: Uint8Array | null): unknown {
  if (!bytes || bytes.length === 0) return null;
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

export function isHouseholdName(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= MAX_HOUSEHOLD_NAME;
}

export function isDescriptor(value: unknown): value is Descriptor {
  if (!value || typeof value !== 'object') return false;
  const d = value as Record<string, unknown>;
  return (
    d.protocol === PROTOCOL &&
    d.version === PROTOCOL_VERSION &&
    isHouseholdName(d.name) &&
    typeof d.url === 'string' &&
    normaliseBaseUrl(d.url) === d.url &&
    isPublicJwk(d.publicKey)
  );
}

/**
 * Fetches and validates a peer's descriptor. Redirects are refused: the point of the fetch is to
 * prove *this* origin serves the key, and following a redirect would prove it about another.
 */
export async function fetchDescriptor(baseUrl: string): Promise<Descriptor | null> {
  let res: Response;
  try {
    res = await fetch(`${baseUrl}${DESCRIPTOR_PATH}`, {
      redirect: 'manual',
      signal: AbortSignal.timeout(DESCRIPTOR_TIMEOUT_MS),
      headers: { accept: 'application/json' },
    });
  } catch {
    return null;
  }
  if (res.status !== 200) {
    await res.body?.cancel();
    return null;
  }
  const data = parseJson(await readLimited(res, MAX_DESCRIPTOR_BYTES));
  return isDescriptor(data) && data.url === baseUrl ? data : null;
}

/** A signed request to another instance. Null if it couldn't be reached at all. */
async function sendSigned(
  identity: Identity,
  fromBaseUrl: string,
  method: 'GET' | 'POST',
  url: string,
  payload?: unknown,
): Promise<{ status: number; body: unknown } | null> {
  const body = method === 'POST' ? new TextEncoder().encode(JSON.stringify(payload)) : undefined;
  const signed = await signRequest({ method, url, body, keyid: fromBaseUrl, privateKey: identity.privateKey });
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: body
        ? { ...signed, 'content-type': 'application/json', accept: 'application/json' }
        : { ...signed, accept: 'application/json' },
    });
  } catch {
    return null;
  }
  return { status: res.status, body: parseJson(await readLimited(res, MAX_RESPONSE_BYTES)) };
}

/** A signed JSON POST to another instance. Null if it couldn't be reached at all. */
export function postSigned(
  identity: Identity,
  fromBaseUrl: string,
  toBaseUrl: string,
  path: string,
  payload: unknown,
): Promise<{ status: number; body: unknown } | null> {
  return sendSigned(identity, fromBaseUrl, 'POST', new URL(path, toBaseUrl).href, payload);
}

/** A signed GET from another instance; `path` may carry a query. Null if it couldn't be reached at all. */
export function getSigned(
  identity: Identity,
  fromBaseUrl: string,
  toBaseUrl: string,
  path: string,
): Promise<{ status: number; body: unknown } | null> {
  return sendSigned(identity, fromBaseUrl, 'GET', new URL(path, toBaseUrl).href);
}
