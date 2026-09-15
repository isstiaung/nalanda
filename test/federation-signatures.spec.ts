// Unit: the RFC 9421 signing profile and instance identity used between connected instances
// (src/federation/signatures.ts, src/federation/keys.ts). The known-answer tests use the RFCs'
// own published vectors, so the code is checked against the standards, not only against itself.
import { describe, expect, it } from 'vitest';
import { fingerprint, importPublicKey, isPublicJwk, loadIdentity } from '../src/federation/keys';
import {
  contentDigest,
  parseSignature,
  signatureBase,
  signatureParams,
  signRequest,
  toBase64,
  verifyRequest,
} from '../src/federation/signatures';

const ED25519 = { name: 'Ed25519' } as const;
const enc = new TextEncoder();

// RFC 9421 Appendix B.1.4, "test-key-ed25519"
const RFC_KEY = {
  kty: 'OKP',
  crv: 'Ed25519',
  d: 'n4Ni-HpISpVObnQMW0wOhCKROaIKqKtW_2ZYb2p9KcU',
  x: 'JrQLj5P_89iXES9-vFgrIy29clF9CC_oPPsw3c5D0bs',
} as const;

async function keypair(): Promise<CryptoKeyPair> {
  return (await crypto.subtle.generateKey(ED25519, true, ['sign', 'verify'])) as CryptoKeyPair;
}

async function secretFor(pair: CryptoKeyPair): Promise<string> {
  const jwk = (await crypto.subtle.exportKey('jwk', pair.privateKey)) as JsonWebKey;
  return JSON.stringify({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, d: jwk.d });
}

describe('known answers from the RFCs', () => {
  it('reproduces RFC 9421 B.2.6 exactly — signature base and Ed25519 signature', async () => {
    const components = [
      ['date', 'Tue, 20 Apr 2021 02:07:55 GMT'],
      ['@method', 'POST'],
      ['@path', '/foo'],
      ['@authority', 'example.com'],
      ['content-type', 'application/json'],
      ['content-length', '18'],
    ] as const;
    const params = signatureParams(
      components.map(([name]) => name),
      { created: 1618884473, keyid: 'test-key-ed25519' },
    );
    expect(params).toBe(
      '("date" "@method" "@path" "@authority" "content-type" "content-length");created=1618884473;keyid="test-key-ed25519"',
    );
    const base = signatureBase(components, params);
    expect(base).toBe(
      [
        '"date": Tue, 20 Apr 2021 02:07:55 GMT',
        '"@method": POST',
        '"@path": /foo',
        '"@authority": example.com',
        '"content-type": application/json',
        '"content-length": 18',
        '"@signature-params": ("date" "@method" "@path" "@authority" "content-type" "content-length");created=1618884473;keyid="test-key-ed25519"',
      ].join('\n'),
    );

    const privateKey = await crypto.subtle.importKey('jwk', RFC_KEY, ED25519, false, ['sign']);
    const signature = await crypto.subtle.sign(ED25519, privateKey, enc.encode(base));
    // Ed25519 is deterministic, so this has to match the RFC byte for byte
    expect(toBase64(signature)).toBe(
      'wqcAqbmYJ2ji2glfAMaRy4gruYYnx2nEFN2HN6jrnDnQCK1u02Gb04v9EDgwUPiu4A0w6vuQv5lIp5WPpBKRCw==',
    );
  });

  it('reproduces RFC 9530 Appendix D — sha-256 of {"hello": "world"}', async () => {
    expect(await contentDigest(enc.encode('{"hello": "world"}'))).toBe(
      'sha-256=:X48E9qOokqqrvdts8nOJRJN3OWDUoyWxBf7kbu9DBPE=:',
    );
  });

  it('fingerprints a key the same way the Node keygen script does', async () => {
    // expected value computed with Node's crypto over the same raw public key
    expect(await fingerprint({ kty: 'OKP', crv: 'Ed25519', x: RFC_KEY.x })).toBe('b16c 2d1b ead1 2626 3976 4fdb 0ee4 d377');
  });
});

describe('the signing profile', () => {
  const url = 'https://a.example/federation/inbox';
  const body = enc.encode('{"type":"Disconnect","id":"4f1c"}');
  const created = 1_758_000_000;

  async function signedPost(pair: CryptoKeyPair, overrides: { url?: string; body?: Uint8Array } = {}) {
    const headers = new Headers(
      await signRequest({
        method: 'POST',
        url: overrides.url ?? url,
        body: overrides.body ?? body,
        keyid: 'https://b.example',
        privateKey: pair.privateKey,
        created,
      }),
    );
    return headers;
  }

  it('signs a POST in exactly the profile shape, and it verifies', async () => {
    const pair = await keypair();
    const headers = await signedPost(pair);
    expect(headers.get('signature-input')).toBe(
      `sig1=("@method" "@target-uri" "content-digest");created=${created};keyid="https://b.example";alg="ed25519"`,
    );
    const parsed = parseSignature(headers);
    expect(parsed?.keyid).toBe('https://b.example');
    const verdict = await verifyRequest({ method: 'POST', url, headers, body }, parsed!, pair.publicKey, created);
    expect(verdict).toEqual({ ok: true });
  });

  it('signs a GET without a content digest, and it verifies', async () => {
    const pair = await keypair();
    const headers = new Headers(
      await signRequest({ method: 'GET', url, keyid: 'https://b.example', privateKey: pair.privateKey, created }),
    );
    expect(headers.get('content-digest')).toBeNull();
    const verdict = await verifyRequest(
      { method: 'GET', url, headers, body: null },
      parseSignature(headers)!,
      pair.publicKey,
      created,
    );
    expect(verdict).toEqual({ ok: true });
  });

  it('rejects a changed body', async () => {
    const pair = await keypair();
    const headers = await signedPost(pair);
    const verdict = await verifyRequest(
      { method: 'POST', url, headers, body: enc.encode('{"type":"Disconnect","id":"EVIL"}') },
      parseSignature(headers)!,
      pair.publicKey,
      created,
    );
    expect(verdict).toEqual({ ok: false, reason: 'body does not match content-digest' });
  });

  it('rejects a body swapped along with a recomputed digest', async () => {
    const pair = await keypair();
    const headers = await signedPost(pair);
    const evil = enc.encode('{"type":"Disconnect","id":"EVIL"}');
    headers.set('content-digest', await contentDigest(evil)); // attacker fixes up the digest too
    const verdict = await verifyRequest(
      { method: 'POST', url, headers, body: evil },
      parseSignature(headers)!,
      pair.publicKey,
      created,
    );
    expect(verdict).toEqual({ ok: false, reason: 'signature does not verify' });
  });

  it('rejects a request replayed against a different URL', async () => {
    const pair = await keypair();
    const headers = await signedPost(pair);
    const verdict = await verifyRequest(
      { method: 'POST', url: 'https://a.example/federation/connect', headers, body },
      parseSignature(headers)!,
      pair.publicKey,
      created,
    );
    expect(verdict).toEqual({ ok: false, reason: 'signature does not verify' });
  });

  it('rejects a GET signature presented on a POST — the body would be unsigned', async () => {
    const pair = await keypair();
    const headers = new Headers(
      await signRequest({ method: 'GET', url, keyid: 'https://b.example', privateKey: pair.privateKey, created }),
    );
    const verdict = await verifyRequest(
      { method: 'POST', url, headers, body },
      parseSignature(headers)!,
      pair.publicKey,
      created,
    );
    expect(verdict).toEqual({ ok: false, reason: 'signature does not cover exactly the required components' });
  });

  it('allows five minutes of clock skew either way, and not a second more', async () => {
    const pair = await keypair();
    const headers = await signedPost(pair);
    const parsed = parseSignature(headers)!;
    const req = { method: 'POST', url, headers, body };
    expect(await verifyRequest(req, parsed, pair.publicKey, created + 300)).toEqual({ ok: true });
    expect(await verifyRequest(req, parsed, pair.publicKey, created - 300)).toEqual({ ok: true });
    expect((await verifyRequest(req, parsed, pair.publicKey, created + 301)).ok).toBe(false);
    expect((await verifyRequest(req, parsed, pair.publicKey, created - 301)).ok).toBe(false);
  });

  it("rejects someone else's key", async () => {
    const signer = await keypair();
    const other = await keypair();
    const headers = await signedPost(signer);
    const verdict = await verifyRequest(
      { method: 'POST', url, headers, body },
      parseSignature(headers)!,
      other.publicKey,
      created,
    );
    expect(verdict).toEqual({ ok: false, reason: 'signature does not verify' });
  });

  it('treats equivalent spellings of the same URL as the same target', async () => {
    const pair = await keypair();
    const headers = await signedPost(pair, { url: 'https://A.EXAMPLE:443/federation/inbox' });
    const verdict = await verifyRequest(
      { method: 'POST', url, headers, body },
      parseSignature(headers)!,
      pair.publicKey,
      created,
    );
    expect(verdict).toEqual({ ok: true });
  });

  it('refuses to sign with a keyid that could break out of its quotes', async () => {
    const pair = await keypair();
    await expect(
      signRequest({ method: 'GET', url, keyid: 'https://b.example";alg="x', privateKey: pair.privateKey, created }),
    ).rejects.toThrow();
  });
});

describe('parsing stays inside the profile', () => {
  const sig = 'sig1=:' + 'A'.repeat(86) + '==:';
  const valid = '("@method" "@target-uri");created=1758000000;keyid="https://b.example";alg="ed25519"';
  const parse = (input: string | null, signature: string | null = sig) => {
    const h = new Headers();
    if (input !== null) h.set('signature-input', input);
    if (signature !== null) h.set('signature', signature);
    return parseSignature(h);
  };

  it('accepts the profile shape', () => {
    expect(parse(`sig1=${valid}`)).not.toBeNull();
  });

  it.each([
    ['no signature headers at all', null, null],
    ['a signature without its input', null, sig],
    ['a different label', `sig2=${valid}`, sig],
    ['more than one signature', `sig1=${valid}, sig2=${valid}`, sig],
    ['an unknown parameter', `sig1=${valid};nonce="abc"`, sig],
    ['a missing alg', 'sig1=("@method" "@target-uri");created=1758000000;keyid="https://b.example"', sig],
    ['another algorithm', 'sig1=("@method" "@target-uri");created=1758000000;keyid="https://b.example";alg="rsa-v1_5-sha256"', sig],
    ['a duplicated parameter', `sig1=${valid};created=1`, sig],
    ['a non-numeric created', 'sig1=("@method" "@target-uri");created=soon;keyid="https://b.example";alg="ed25519"', sig],
    ['a keyid that is not a string', 'sig1=("@method" "@target-uri");created=1758000000;keyid=5;alg="ed25519"', sig],
    ['a signature that is not a byte sequence', `sig1=${valid}`, 'sig1=AAAA'],
  ])('rejects %s', (_label, input, signature) => {
    expect(parse(input, signature)).toBeNull();
  });
});

describe('instance identity', () => {
  it('is off when the secret is unset or malformed', async () => {
    expect(await loadIdentity(undefined)).toBeNull();
    expect(await loadIdentity('')).toBeNull();
    expect(await loadIdentity('not json')).toBeNull();
    expect(await loadIdentity(JSON.stringify({ kty: 'EC', crv: 'P-256', x: 'a', d: 'b' }))).toBeNull();
  });

  it('refuses a key whose public half does not belong to its private half', async () => {
    const a = JSON.parse(await secretFor(await keypair()));
    const b = JSON.parse(await secretFor(await keypair()));
    expect(await loadIdentity(JSON.stringify({ ...a, x: b.x }))).toBeNull();
  });

  it('loads a valid key, publishes only its public half, and signs verifiably', async () => {
    const identity = await loadIdentity(await secretFor(await keypair()));
    expect(identity).not.toBeNull();
    expect(Object.keys(identity!.publicJwk).sort()).toEqual(['crv', 'kty', 'x']); // never `d`
    expect(identity!.fingerprint).toMatch(/^([0-9a-f]{4} ){7}[0-9a-f]{4}$/);

    const publicKey = await importPublicKey(identity!.publicJwk);
    const headers = new Headers(
      await signRequest({ method: 'GET', url: 'https://a.example/x', keyid: 'https://b.example', privateKey: identity!.privateKey }),
    );
    const verdict = await verifyRequest(
      { method: 'GET', url: 'https://a.example/x', headers, body: null },
      parseSignature(headers)!,
      publicKey!,
    );
    expect(verdict).toEqual({ ok: true });
  });

  it('only accepts well-formed Ed25519 public keys from peers', () => {
    expect(isPublicJwk({ kty: 'OKP', crv: 'Ed25519', x: RFC_KEY.x })).toBe(true);
    expect(isPublicJwk({ kty: 'OKP', crv: 'X25519', x: RFC_KEY.x })).toBe(false);
    expect(isPublicJwk({ kty: 'OKP', crv: 'Ed25519', x: 'too-short' })).toBe(false);
    expect(isPublicJwk(null)).toBe(false);
  });
});
