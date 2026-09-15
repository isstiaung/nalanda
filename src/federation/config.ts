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
