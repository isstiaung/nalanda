// Constants and hard limits for connections between instances
// (docs/proposals/connections.md §12, "Hard limits"). Limits apply regardless of anyone's
// settings; they are starting values, tuned as later phases land.

export const PROTOCOL = 'nalanda-connections';
export const PROTOCOL_VERSION = 1;

export const DESCRIPTOR_PATH = '/.well-known/nalanda';
export const INVITE_PATH = '/connect';

export const INVITE_TTL_DAYS = 7;
export const MAX_HOUSEHOLD_NAME = 80;
export const MAX_ACTIVE_CONNECTIONS = 25;


/** A signed request to another instance — long enough to cover that instance's own descriptor fetch. */
export const FETCH_TIMEOUT_MS = 15_000;
/** Fetching a descriptor, kept well inside FETCH_TIMEOUT_MS: the connect handshake nests one inside the other. */
export const DESCRIPTOR_TIMEOUT_MS = 5_000;
/** Messages accepted from one connection per day, then refused — the D1 write allowance is the whole instance's. */
export const MAX_PUSHES_PER_DAY = 200;
export const MAX_DESCRIPTOR_BYTES = 16 * 1024;
export const MAX_CONNECT_BODY_BYTES = 16 * 1024;
export const MAX_INBOX_BODY_BYTES = 64 * 1024;
export const MAX_RESPONSE_BYTES = 256 * 1024;

// ---------- feed (phase 2) ----------

/** Most entries in one feed response, whatever the caller asks for. */
export const FEED_PAGE_SIZE = 100;
/** A feed response stops adding entries past this size, staying under MAX_RESPONSE_BYTES. */
export const FEED_RESPONSE_BUDGET_BYTES = 192 * 1024;
/** Reviews are cut to this many characters in feed entries. */
export const MAX_FEED_REVIEW_CHARS = 8_000;
/** Most ids one removal check may ask about — the largest a subscription can hold. */
export const MAX_CHECK_IDS = 1_000;
export const MAX_CHECK_BODY_BYTES = 64 * 1024;
/** Stored feed entries per connection, whatever its subscriptions allow. */
export const MAX_STORED_ENTRIES_PER_CONNECTION = 1_000;
export const MAX_CONNECTION_VIEWS = 20;
export const MAX_VIEW_NAME = 80;

/** How often a subscription may pull, in minutes. */
export const PULL_INTERVALS = [15, 60, 1440] as const;
export type PullInterval = (typeof PULL_INTERVALS)[number];
export const DEFAULT_PULL_INTERVAL: PullInterval = 60;
export const DEFAULT_RETENTION_DAYS = 90;
export const MAX_RETENTION_DAYS = 365;
export const DEFAULT_MAX_ENTRIES = 500;
export const MIN_MAX_ENTRIES = 10;

/** Subscriptions refreshed per page load. Each costs two subrequests; the rest wait their turn. */
export const REFRESHES_PER_REQUEST = 4;
/** The window a view's activity volume is measured over, for size estimates. */
export const VOLUME_WINDOW_DAYS = 90;
/** Activity recorded from before a household's first connection view: the newest this many, within the window. */
export const BACKFILL_ENTRIES = 300;

