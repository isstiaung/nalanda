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
/** A feed response stops adding entries past this size — small enough to parse well inside the CPU budget. */
export const FEED_RESPONSE_BUDGET_BYTES = 64 * 1024;
/** The most of a feed response a receiver reads. */
export const MAX_FEED_RESPONSE_BYTES = 128 * 1024;
/** Titles and creators are cut to this in feed entries, reviews to MAX_FEED_REVIEW_CHARS. */
export const MAX_FEED_TEXT_CHARS = 1_000;
export const MAX_FEED_REVIEW_CHARS = 8_000;
/** Most ids one removal check may ask about — the largest a subscription can hold. */
export const MAX_CHECK_IDS = 1_000;
export const MAX_CHECK_BODY_BYTES = 64 * 1024;
/** Stored feed entries per connection, whatever its subscriptions allow. */
export const MAX_STORED_ENTRIES_PER_CONNECTION = 1_000;
/** New feed entries stored from one connection per day; the rest of a flood is dropped. */
export const MAX_FEED_ENTRIES_PER_DAY = 500;
export const MAX_CONNECTION_VIEWS = 20;
export const MAX_VIEW_NAME = 80;
/** Requests one connection may make to the feed endpoints per window, per isolate — each costs D1 reads. */
export const FEED_READS_PER_WINDOW = 120;
export const FEED_READ_WINDOW_MS = 10 * 60_000;
/** How long an isolate reuses the list of shared views it serves. */
export const SHARED_VIEWS_CACHE_MS = 5 * 60_000;

/** How often a subscription may pull, in minutes. */
export const PULL_INTERVALS = [15, 60, 1440] as const;
export type PullInterval = (typeof PULL_INTERVALS)[number];
export const DEFAULT_PULL_INTERVAL: PullInterval = 60;
export const DEFAULT_RETENTION_DAYS = 90;
export const MAX_RETENTION_DAYS = 365;
export const DEFAULT_MAX_ENTRIES = 500;
export const MIN_MAX_ENTRIES = 10;

/**
 * D1 queries a page load may spend on background work after its response. The free plan allows 50 per
 * invocation, the page itself uses up to about 15, and waitUntil work counts toward the same invocation.
 */
export const BACKGROUND_QUERY_BUDGET = 30;
/** Roughly what one subscription refresh costs in queries; another starts only while the budget has this much left. */
export const SUBSCRIPTION_REFRESH_QUERIES = 14;
/** The window a view's activity volume is measured over, for size estimates. */
export const VOLUME_WINDOW_DAYS = 90;
/** Activity recorded when a household shares its first view: the newest this many, within the window. */
export const BACKFILL_ENTRIES = 300;
/** Stored entries the Feed page renders at once, by count and by bytes of entry JSON. */
export const FEED_PAGE_ENTRIES = 200;
export const FEED_PAGE_BYTES = 128 * 1024;

// ---------- comments and the outbox (phase 3) ----------

export const MAX_COMMENT_CHARS = 2_000;
export const MAX_AUTHOR_NAME = 64;
/** Messages this household may send one connection per day — its own side of the daily push limit. */
export const MAX_SENT_PER_DAY = 100;
/** Messages in one outbox response, within a byte budget. */
export const OUTBOX_PAGE_SIZE = 50;
export const OUTBOX_RESPONSE_BUDGET_BYTES = 64 * 1024;
export const MAX_OUTBOX_RESPONSE_BYTES = 128 * 1024;
/** How long a message waits in the outbox for a connection that hasn't pulled it. */
export const OUTBOX_RETENTION_DAYS = 30;
/** A connection's outbox is pulled at most this often. */
export const OUTBOX_PULL_MINUTES = 5;
/** Of a page load's background budget, the most outbox pulls may spend — feeds get the rest. */
export const OUTBOX_QUERY_SHARE = 16;
/** Another outbox pull starts only while its share has this many queries left. */
export const OUTBOX_PULL_QUERIES = 8;
/** New messages applied from one outbox per pull; a backlog drains across page loads. */
export const OUTBOX_APPLY_PER_PULL = 5;
/** Comments on this household's reviews listed at the top of Feed: from the last this many days. */
export const RECENT_COMMENT_DAYS = 14;

// ---------- borrowing (phase 4) ----------

/** How long a page of a connection's shelf, or one of its items, is kept in this isolate's memory — never stored. */
export const SHELF_CACHE_MS = 5 * 60_000;
export const SHELF_CACHE_ENTRIES = 100;
export const MAX_BORROW_NOTE_CHARS = 500;
/** Longer texts on a connection's item page are cut to this. */
export const MAX_DETAIL_TEXT_CHARS = 20_000;
/** Borrow requests one connection may have waiting here at once. */
export const MAX_PENDING_REQUESTS_PER_CONNECTION = 20;
/** Undelivered outbox messages retried per page load, each at most this often, for this long. */
export const PUSH_RETRIES_PER_REQUEST = 1;
export const PUSH_RETRY_MINUTES = 10;
export const PUSH_RETRY_DAYS = 2;

