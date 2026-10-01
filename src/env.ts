export type Bindings = {
  DB: D1Database;
  COVERS: R2Bucket;
  // Signs session cookies. Unset, empty or blank means nobody can sign in: setup and login explain (hasSessionSecret).
  SESSION_SECRET?: string;
  DISCOGS_TOKEN?: string;
  BGG_TOKEN?: string; // BoardGameGeek application token — board games need it since BGG went registration-only
  GOOGLE_BOOKS_KEY?: string;
  HOME_SHARE_TOKEN?: string; // front door: anonymous "/" redirects to /share/<this token>
  // Ed25519 private JWK (JSON). Unset — or invalid — means connections are disabled entirely.
  FEDERATION_PRIVATE_KEY?: string;
};

export type SessionUser = {
  id: number;
  username: string;
  role: 'admin' | 'member';
  mustChangePassword: boolean;
  // Which account this is across time, not just which id (§16 #56): anything derived from the signed-in person that
  // must not carry over to a later account given the same id uses accountIdentity() over this and the id. Never
  // rendered — not a secret, but nothing a page needs.
  sessionKey: string;
  // The generation this session was made in (§16 #70): what a cookie re-issued on this response must name.
  sessionGeneration: number;
};

export type AppEnv = {
  Bindings: Bindings;
  Variables: {
    user: SessionUser;
  };
};

// Sent on all outbound metadata/cover fetches; some providers (Discogs, BGG) require a UA.
/**
 * Every outbound provider/image call goes through this: an unbounded fetch can hang a whole
 * backfill batch, and the browser driving it just waits.
 */
export function fetchWithTimeout(url: string, init: RequestInit = {}, ms = 6000): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(ms) });
}

export const USER_AGENT = 'nalanda/0.1 (self-hosted personal library)';
