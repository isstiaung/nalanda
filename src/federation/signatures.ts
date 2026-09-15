// A fixed profile of RFC 9421 HTTP Message Signatures, with RFC 9530 Content-Digest
// (docs/proposals/connections.md §6).
//
// Deliberately not a general implementation: one label (`sig1`), one algorithm (Ed25519), and
// exactly two covered-component lists — ("@method" "@target-uri") for requests without a body,
// ("@method" "@target-uri" "content-digest") for POSTs. Anything outside the profile is rejected
// rather than interpreted. A verifier this narrow can be read, and trusted, in one sitting.

const ED25519 = { name: 'Ed25519' } as const;
const enc = new TextEncoder();

export const SIGNATURE_LABEL = 'sig1';
export const ALG = 'ed25519';
export const MAX_CLOCK_SKEW_SECONDS = 300;

const WITHOUT_BODY = ['@method', '@target-uri'] as const;
const WITH_BODY = ['@method', '@target-uri', 'content-digest'] as const;

/** Standard base64 with padding — the encoding inside an RFC 8941 byte sequence (`:…:`). */
export function toBase64(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  for (const b of view) binary += String.fromCharCode(b);
  return btoa(binary);
}

export function fromBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (ch) => ch.charCodeAt(0));
}

/** RFC 9530 Content-Digest for a body, SHA-256 only: `sha-256=:<base64>:`. */
export async function contentDigest(body: Uint8Array): Promise<string> {
  return `sha-256=:${toBase64(await crypto.subtle.digest('SHA-256', body))}:`;
}

/** RFC 9421 §2.3: the inner list of covered components, then parameters in a fixed order. */
export function signatureParams(
  components: readonly string[],
  params: { created: number; keyid: string; alg?: string },
): string {
  let out = `(${components.map((c) => `"${c}"`).join(' ')});created=${params.created};keyid="${params.keyid}"`;
  if (params.alg) out += `;alg="${params.alg}"`;
  return out;
}

/** RFC 9421 §2.5: one `"component": value` line each, then the `@signature-params` line. No trailing newline. */
export function signatureBase(components: ReadonlyArray<readonly [string, string]>, params: string): string {
  return [...components.map(([name, value]) => `"${name}": ${value}`), `"@signature-params": ${params}`].join('\n');
}

function isSafeKeyid(keyid: string): boolean {
  return /^[^"\\\s]+$/.test(keyid);
}

/**
 * Headers that sign a request under the profile. `url` must be exactly the URL fetched — it is
 * normalised here with `new URL(url).href`, so callers should fetch that same string.
 */
export async function signRequest(req: {
  method: string;
  url: string;
  body?: Uint8Array;
  keyid: string;
  privateKey: CryptoKey;
  created?: number;
}): Promise<Record<string, string>> {
  if (!isSafeKeyid(req.keyid)) throw new Error('keyid must not contain quotes, backslashes or whitespace');
  const method = req.method.toUpperCase();
  const created = req.created ?? Math.floor(Date.now() / 1000);
  const headers: Record<string, string> = {};
  const components: Array<[string, string]> = [
    ['@method', method],
    ['@target-uri', new URL(req.url).href],
  ];
  if (method === 'POST') {
    const digest = await contentDigest(req.body ?? new Uint8Array());
    headers['content-digest'] = digest;
    components.push(['content-digest', digest]);
  }
  const params = signatureParams(
    components.map(([name]) => name),
    { created, keyid: req.keyid, alg: ALG },
  );
  const signature = await crypto.subtle.sign(ED25519, req.privateKey, enc.encode(signatureBase(components, params)));
  headers['signature-input'] = `${SIGNATURE_LABEL}=${params}`;
  headers['signature'] = `${SIGNATURE_LABEL}=:${toBase64(signature)}:`;
  return headers;
}

export type ParsedSignature = {
  keyid: string;
  created: number;
  components: string[];
  /** The inner list and parameters exactly as received — the signature base must use it verbatim. */
  params: string;
  signature: Uint8Array;
};

const INPUT = /^sig1=(\((?:"[a-z0-9@-]+"(?: "[a-z0-9@-]+")*)?\)(?:;[a-z]+=(?:\d+|"[^"\\]*"))*)$/;
const PARAM = /;([a-z]+)=(\d+|"[^"\\]*")/g;
// An Ed25519 signature is exactly 64 bytes — 86 base64 characters and two of padding. WebCrypto throws on any
// other length rather than returning false.
const SIGNATURE = /^sig1=:([A-Za-z0-9+/]{86}==):$/;

/**
 * Reads the signature headers only — no crypto, no database — so a route can turn away unsigned
 * or malformed requests before looking anything up. Null means "not a signature in our profile".
 */
export function parseSignature(headers: Headers): ParsedSignature | null {
  const input = INPUT.exec((headers.get('signature-input') ?? '').trim());
  const sig = SIGNATURE.exec((headers.get('signature') ?? '').trim());
  if (!input || !sig) return null;
  const params = input[1] ?? '';
  const close = params.indexOf(')');
  const list = params.slice(1, close);
  const components = list ? list.split(' ').map((c) => c.slice(1, -1)) : [];

  const values = new Map<string, string>();
  for (const [, key, value] of params.slice(close + 1).matchAll(PARAM)) {
    if (!key || value === undefined || values.has(key)) return null; // duplicate parameter
    values.set(key, value);
  }
  if ([...values.keys()].some((k) => k !== 'created' && k !== 'keyid' && k !== 'alg')) return null;
  const created = values.get('created');
  const keyid = values.get('keyid');
  if (!created || !/^\d+$/.test(created) || !keyid?.startsWith('"')) return null;
  if (values.get('alg') !== `"${ALG}"`) return null;

  let signature: Uint8Array;
  try {
    signature = fromBase64(sig[1] ?? '');
  } catch {
    return null;
  }
  return { keyid: keyid.slice(1, -1), created: Number(created), components, params, signature };
}

export type Verdict = { ok: true } | { ok: false; reason: string };

/** Verifies a parsed signature against the request it arrived on, using the sender's public key. */
export async function verifyRequest(
  req: { method: string; url: string; headers: Headers; body: Uint8Array | null },
  sig: ParsedSignature,
  key: CryptoKey,
  now: number = Math.floor(Date.now() / 1000),
): Promise<Verdict> {
  if (Math.abs(now - sig.created) > MAX_CLOCK_SKEW_SECONDS) {
    return { ok: false, reason: 'signature is outside the allowed time window' };
  }
  const method = req.method.toUpperCase();
  const required = method === 'POST' ? WITH_BODY : WITHOUT_BODY;
  if (sig.components.length !== required.length || sig.components.some((c, i) => c !== required[i])) {
    return { ok: false, reason: 'signature does not cover exactly the required components' };
  }
  const components: Array<[string, string]> = [
    ['@method', method],
    ['@target-uri', new URL(req.url).href],
  ];
  if (method === 'POST') {
    const header = req.headers.get('content-digest');
    if (!header) return { ok: false, reason: 'content-digest header is missing' };
    if (header !== (await contentDigest(req.body ?? new Uint8Array()))) {
      return { ok: false, reason: 'body does not match content-digest' };
    }
    components.push(['content-digest', header]);
  }
  let valid = false;
  try {
    valid = await crypto.subtle.verify(ED25519, key, sig.signature, enc.encode(signatureBase(components, sig.params)));
  } catch {
    // a malformed signature is a failed one, not a server error
  }
  return valid ? { ok: true } : { ok: false, reason: 'signature does not verify' };
}
