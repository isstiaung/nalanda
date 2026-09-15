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


export const FETCH_TIMEOUT_MS = 10_000;
export const MAX_DESCRIPTOR_BYTES = 16 * 1024;
export const MAX_CONNECT_BODY_BYTES = 16 * 1024;
export const MAX_INBOX_BODY_BYTES = 64 * 1024;
export const MAX_RESPONSE_BYTES = 256 * 1024;
