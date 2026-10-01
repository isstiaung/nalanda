import type { Translator } from './i18n';

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
  // A plain variable, not a secret (ARCH.md §16 #92): set to anything but blank/0/false/no/off, this instance contacts no
  // connected household — for a restored copy of a production database. Production leaves it unset.
  FEDERATION_OFFLINE?: string;
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
  // The interface language this member chose on Account (§16 #93), or null to follow the household's.
  locale: string | null;
};

export type AppEnv = {
  Bindings: Bindings;
  Variables: {
    user: SessionUser;
    // What this request renders in (§16 #93): set by the session middleware for every signed-in page from the same
    // call that read the account; a public page sets it on first use (i18nOf in views/layout.tsx).
    i18n: Translator;
    // The household's default language (site_settings.language, §16 #76), from the same call: what the Account page's
    // "Household default" means, and what Members says the interface follows.
    householdLanguage: string;
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
