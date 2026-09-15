import { sql } from 'drizzle-orm';
import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const MEDIA_TYPES = ['book', 'boardgame', 'vinyl', 'movie', 'music', 'videogame', 'other'] as const;
export type MediaType = (typeof MEDIA_TYPES)[number];

export const ITEM_STATUSES = ['not_started', 'in_progress', 'completed', 'abandoned'] as const;
export type ItemStatus = (typeof ITEM_STATUSES)[number];

const now = sql`(datetime('now'))`;

export const users = sqliteTable('users', {
  id: integer('id').primaryKey(),
  username: text('username').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  role: text('role', { enum: ['admin', 'member'] }).notNull().default('member'),
  mustChangePassword: integer('must_change_password', { mode: 'boolean' }).notNull().default(false),
  createdAt: text('created_at').notNull().default(now),
});

export const libraries = sqliteTable('libraries', {
  id: integer('id').primaryKey(),
  name: text('name').notNull(),
  position: integer('position').notNull().default(0),
  shareToken: text('share_token').unique(), // legacy — migrated into `shares` (0004), no longer read/written
  createdAt: text('created_at').notNull().default(now),
});

export const items = sqliteTable(
  'items',
  {
    id: integer('id').primaryKey(),
    libraryId: integer('library_id')
      .notNull()
      .references(() => libraries.id, { onDelete: 'cascade' }),
    mediaType: text('media_type', { enum: MEDIA_TYPES }).notNull().default('book'),
    title: text('title').notNull(),
    creators: text('creators'),
    isbn13: text('isbn13'),
    isbn10Upc: text('isbn10_upc'),
    publisher: text('publisher'),
    published: text('published'),
    description: text('description'),
    length: integer('length'),
    coverKey: text('cover_key'),
    status: text('status', { enum: ITEM_STATUSES }).notNull().default('not_started'),
    rating: integer('rating'),
    review: text('review'),
    notes: text('notes'),
    copies: integer('copies').notNull().default(1),
    beganOn: text('began_on'),
    completedOn: text('completed_on'),
    details: text('details').notNull().default('{}'),
    addedBy: integer('added_by').references(() => users.id),
    addedAt: text('added_at').notNull().default(now),
    updatedAt: text('updated_at').notNull().default(now),
  },
  (t) => [index('idx_items_library').on(t.libraryId), index('idx_items_isbn13').on(t.isbn13)],
);

export const tags = sqliteTable('tags', {
  id: integer('id').primaryKey(),
  name: text('name').notNull().unique(),
});

export const itemTags = sqliteTable(
  'item_tags',
  {
    itemId: integer('item_id')
      .notNull()
      .references(() => items.id, { onDelete: 'cascade' }),
    tagId: integer('tag_id')
      .notNull()
      .references(() => tags.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.itemId, t.tagId] })],
);

export const loans = sqliteTable(
  'loans',
  {
    id: integer('id').primaryKey(),
    itemId: integer('item_id')
      .notNull()
      .references(() => items.id, { onDelete: 'cascade' }),
    borrower: text('borrower').notNull(),
    contact: text('contact'),
    loanedOn: text('loaned_on').notNull().default(sql`(date('now'))`),
    dueOn: text('due_on'),
    returnedOn: text('returned_on'),
    note: text('note'),
  },
  (t) => [index('idx_loans_item').on(t.itemId)],
);

/**
 * Public share links, one per published VIEW (ARCH.md §16 #18): a token plus the
 * captured filters it exposes. A whole-shelf link is just a share with no filters.
 * libraryId is nullable for future all-shelves views; the UI currently always sets it.
 */
export const shares = sqliteTable('shares', {
  id: integer('id').primaryKey(),
  token: text('token').notNull().unique(),
  name: text('name').notNull(), // the public page title
  libraryId: integer('library_id').references(() => libraries.id, { onDelete: 'cascade' }),
  mediaType: text('media_type', { enum: MEDIA_TYPES }),
  status: text('status', { enum: ITEM_STATUSES }),
  owned: integer('owned', { mode: 'boolean' }),
  tag: text('tag'), // everything carrying this tag (stored lowercase), on any shelf the other filters allow
  sort: text('sort', { enum: ['added', 'title', 'rating', 'completed'] }).notNull().default('title'),
  createdAt: text('created_at').notNull().default(now),
});

export const loginAttempts = sqliteTable('login_attempts', {
  ip: text('ip').notNull(),
  attemptedAt: text('attempted_at').notNull().default(now),
});

// ---------- connections between instances (docs/proposals/connections.md) ----------
// Phase 1: identity, invites and connections. Inert unless FEDERATION_PRIVATE_KEY is set.

/** Singleton row (id 1): this household's name and canonical address, as connections see them. */
export const federationSettings = sqliteTable('federation_settings', {
  id: integer('id').primaryKey(),
  householdName: text('household_name').notNull(),
  baseUrl: text('base_url').notNull(),
  updatedAt: text('updated_at').notNull().default(now),
});

/**
 * One-time invites. Only the SHA-256 of the token is stored — the token itself is shown to the
 * admin once and never again, so a leaked database or backup can't redeem anything.
 */
export const connectionInvites = sqliteTable('connection_invites', {
  id: integer('id').primaryKey(),
  tokenHash: text('token_hash').notNull().unique(),
  createdBy: integer('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: text('created_at').notNull().default(now),
  expiresAt: text('expires_at').notNull(),
  usedAt: text('used_at'),
});

/**
 * awaiting_us — they redeemed our invite; an admin here must confirm.
 * awaiting_them — we redeemed theirs; their admin must confirm.
 * active — confirmed on both sides.
 */
export const CONNECTION_STATUSES = ['awaiting_us', 'awaiting_them', 'active'] as const;
export type ConnectionStatus = (typeof CONNECTION_STATUSES)[number];

/** Another Nalanda instance. The public key is its identity; the address is where to reach it. */
export const connections = sqliteTable('connections', {
  // AUTOINCREMENT: an id is never reused, so a stale page or cached row can't reach a newer connection
  id: integer('id').primaryKey({ autoIncrement: true }),
  baseUrl: text('base_url').notNull().unique(),
  householdName: text('household_name').notNull(),
  publicKey: text('public_key').notNull(), // Ed25519 public JWK, stored as JSON
  status: text('status', { enum: CONNECTION_STATUSES }).notNull(),
  inviteId: integer('invite_id').references(() => connectionInvites.id, { onDelete: 'set null' }),
  createdAt: text('created_at').notNull().default(now),
  confirmedAt: text('confirmed_at'),
  // phase 3: how far into their outbox this household has read, and when it last pulled
  outboxCursor: integer('outbox_cursor').notNull().default(0),
  outboxPulledAt: text('outbox_pulled_at'),
  // and the other way: how many messages this household has queued for them, numbered per connection
  outboxSeq: integer('outbox_seq').notNull().default(0),
});

/**
 * Activity ids already processed, so a replayed signed message within the signature window is a
 * no-op. Pruned after an hour, well past that window. Transient: not backed up.
 */
export const federationSeen = sqliteTable(
  'federation_seen',
  {
    activityId: text('activity_id').primaryKey(),
    seenAt: text('seen_at').notNull().default(now),
  },
  (t) => [index('idx_federation_seen_at').on(t.seenAt)],
);

/** Messages accepted from each connection per UTC day, for the daily limit. Transient: not backed up. */
export const connectionPushCounts = sqliteTable(
  'connection_push_counts',
  {
    connectionId: integer('connection_id')
      .notNull()
      .references(() => connections.id, { onDelete: 'cascade' }),
    day: text('day').notNull(),
    pushes: integer('pushes').notNull(),
    feedEntries: integer('feed_entries').notNull().default(0), // phase 2: feed entries stored from them
  },
  (t) => [primaryKey({ columns: [t.connectionId, t.day] })],
);

// Phase 2: the feed. Connection views are what this household shares; activity_log records what
// happened to items inside them; subscriptions and remote_activities are what it follows and keeps.

/** A slice of the catalog shared with every connection — the same captured filters as `shares`. */
export const connectionViews = sqliteTable('connection_views', {
  // AUTOINCREMENT: a withdrawn view's id never names a different view to the households that followed it
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  libraryId: integer('library_id').references(() => libraries.id, { onDelete: 'cascade' }),
  mediaType: text('media_type', { enum: MEDIA_TYPES }),
  status: text('status', { enum: ITEM_STATUSES }),
  owned: integer('owned', { mode: 'boolean' }),
  sort: text('sort', { enum: ['added', 'title', 'rating', 'completed'] }).notNull().default('title'),
  createdAt: text('created_at').notNull().default(now),
});

export const ACTIVITY_KINDS = ['reviewed', 'rated', 'finished'] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

/**
 * Written only by triggers on `items` (migration 0007), and only while a connection view exists.
 * One row per item and kind: a repeat replaces the row under a new id, so the id doubles as the
 * feed cursor and a replaced id tells a connection its stored copy is out of date.
 */
export const activityLog = sqliteTable(
  'activity_log',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    itemId: integer('item_id')
      .notNull()
      .references(() => items.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ACTIVITY_KINDS }).notNull(),
    at: text('at').notNull().default(now),
  },
  (t) => [uniqueIndex('activity_log_item_kind').on(t.itemId, t.kind), index('idx_activity_log_at').on(t.at)],
);

/** A view of a connection's that this household follows, with the limits it chose. */
export const feedSubscriptions = sqliteTable(
  'feed_subscriptions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    connectionId: integer('connection_id')
      .notNull()
      .references(() => connections.id, { onDelete: 'cascade' }),
    viewId: integer('view_id').notNull(), // the view's id on their instance
    viewName: text('view_name').notNull(),
    intervalMinutes: integer('interval_minutes').notNull(),
    retentionDays: integer('retention_days').notNull(),
    maxEntries: integer('max_entries').notNull(),
    cursor: integer('cursor').notNull().default(0),
    lastPulledAt: text('last_pulled_at'),
    lastError: text('last_error'),
    removedUnseen: integer('removed_unseen').notNull().default(0), // removals not yet noted on the Feed page
    goneAt: text('gone_at'), // they stopped sharing the view
    createdAt: text('created_at').notNull().default(now),
  },
  (t) => [uniqueIndex('feed_subscriptions_connection_view').on(t.connectionId, t.viewId)],
);

/** Feed entries received from a connection, kept under the subscription's lifecycle rules. */
export const remoteActivities = sqliteTable(
  'remote_activities',
  {
    id: integer('id').primaryKey(),
    subscriptionId: integer('subscription_id')
      .notNull()
      .references(() => feedSubscriptions.id, { onDelete: 'cascade' }),
    remoteId: integer('remote_id').notNull(), // their activity_log id
    itemRemoteId: integer('item_remote_id').notNull(), // their items id
    itemStamp: text('item_stamp').notNull().default(''), // phase 3: which of their books that id meant
    kind: text('kind', { enum: ACTIVITY_KINDS }).notNull(),
    publishedAt: text('published_at').notNull(),
    item: text('item').notNull(), // the validated FeedItem, as JSON
    bytes: integer('bytes').notNull(),
    receivedAt: text('received_at').notNull().default(now),
  },
  (t) => [
    uniqueIndex('remote_activities_subscription_remote').on(t.subscriptionId, t.remoteId),
    index('idx_remote_activities_published').on(t.publishedAt),
    index('idx_remote_activities_item').on(t.itemRemoteId),
  ],
);

// Phase 3: comments on reviews, and the outbox behind every message addressed to one connection.

/**
 * A comment in a thread between this household and one connection, on a review that belongs to one of the
 * two — `ourItemId` or `theirItemId` says which. The same activity id names it on both sides. Deleting keeps
 * the row with its body cleared, so a copy of the original still waiting in an outbox can't bring it back.
 */
export const comments = sqliteTable(
  'comments',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    activityId: text('activity_id').notNull().unique(),
    connectionId: integer('connection_id')
      .notNull()
      .references(() => connections.id, { onDelete: 'cascade' }),
    ourItemId: integer('our_item_id').references(() => items.id, { onDelete: 'cascade' }),
    theirItemId: integer('their_item_id'),
    theirItemStamp: text('their_item_stamp'),
    fromUs: integer('from_us', { mode: 'boolean' }).notNull(),
    authorName: text('author_name').notNull(),
    authorId: integer('author_id').references(() => users.id, { onDelete: 'set null' }),
    body: text('body'),
    createdAt: text('created_at').notNull().default(now),
    deletedAt: text('deleted_at'),
  },
  (t) => [index('idx_comments_our_item').on(t.ourItemId), index('idx_comments_their_item').on(t.connectionId, t.theirItemId)],
);

/**
 * Messages addressed to one connection. Each is pushed once when written, and kept here for that connection to
 * pull, so a push that failed isn't lost. Pruned after OUTBOX_RETENTION_DAYS.
 */
export const outbox = sqliteTable(
  'outbox',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    connectionId: integer('connection_id')
      .notNull()
      .references(() => connections.id, { onDelete: 'cascade' }),
    activityId: text('activity_id').notNull().unique(),
    // numbered per connection, so the numbers a connection sees say nothing about messages to anyone else
    seq: integer('seq').notNull(),
    message: text('message').notNull(),
    createdAt: text('created_at').notNull().default(now),
    deliveredAt: text('delivered_at'),
    attemptedAt: text('attempted_at'), // phase 4: last push attempt, for retries on page loads
  },
  (t) => [uniqueIndex('outbox_connection_seq').on(t.connectionId, t.seq)],
);

// Phase 4: borrowing — requests both ways, loans made to connections, and books borrowed from them.

export const BORROW_STATUSES = ['pending', 'accepted', 'declined', 'withdrawn'] as const;
export type BorrowStatus = (typeof BORROW_STATUSES)[number];

/**
 * A request to borrow one book. `incoming`: a connection asked for one of ours (`ourItemId`). Otherwise this
 * household asked for one of theirs (`theirItemId`), keeping the title and cover to show. The same activity id
 * names it on both sides.
 */
export const borrowRequests = sqliteTable(
  'borrow_requests',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    activityId: text('activity_id').notNull().unique(),
    connectionId: integer('connection_id')
      .notNull()
      .references(() => connections.id, { onDelete: 'cascade' }),
    incoming: integer('incoming', { mode: 'boolean' }).notNull(),
    ourItemId: integer('our_item_id').references(() => items.id, { onDelete: 'cascade' }),
    theirItemId: integer('their_item_id'),
    theirItemStamp: text('their_item_stamp'),
    theirViewId: integer('their_view_id'),
    itemTitle: text('item_title').notNull(),
    coverKey: text('cover_key'),
    requesterName: text('requester_name').notNull(),
    requesterId: integer('requester_id').references(() => users.id, { onDelete: 'set null' }),
    note: text('note'),
    status: text('status', { enum: BORROW_STATUSES }).notNull().default('pending'),
    dueOn: text('due_on'),
    createdAt: text('created_at').notNull().default(now),
    respondedAt: text('responded_at'),
  },
  (t) => [index('idx_borrow_requests_connection').on(t.connectionId, t.status)],
);

/** Links an ordinary loan to the connection that borrowed the book, and the request it answered. */
export const connectionLoans = sqliteTable('connection_loans', {
  loanId: integer('loan_id')
    .primaryKey()
    .references(() => loans.id, { onDelete: 'cascade' }),
  connectionId: integer('connection_id')
    .notNull()
    .references(() => connections.id, { onDelete: 'cascade' }),
  requestId: integer('request_id').references(() => borrowRequests.id, { onDelete: 'set null' }),
  requestActivityId: text('request_activity_id').notNull(),
});

/** A book this household has borrowed from a connection. Never part of the catalog. */
export const borrowedItems = sqliteTable('borrowed_items', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  connectionId: integer('connection_id')
    .notNull()
    .references(() => connections.id, { onDelete: 'cascade' }),
  requestActivityId: text('request_activity_id').notNull().unique(),
  theirItemId: integer('their_item_id').notNull(),
  title: text('title').notNull(),
  coverKey: text('cover_key'),
  borrowedOn: text('borrowed_on').notNull(),
  dueOn: text('due_on'),
  returnedOn: text('returned_on'),
});

export type User = typeof users.$inferSelect;
export type Library = typeof libraries.$inferSelect;
export type Share = typeof shares.$inferSelect;
export type Item = typeof items.$inferSelect;
export type NewItem = typeof items.$inferInsert;
export type Loan = typeof loans.$inferSelect;
export type Tag = typeof tags.$inferSelect;
export type FederationSettings = typeof federationSettings.$inferSelect;
export type ConnectionInvite = typeof connectionInvites.$inferSelect;
export type Connection = typeof connections.$inferSelect;
export type ConnectionView = typeof connectionViews.$inferSelect;
export type FeedSubscription = typeof feedSubscriptions.$inferSelect;
export type RemoteActivity = typeof remoteActivities.$inferSelect;
export type Comment = typeof comments.$inferSelect;
export type OutboxRow = typeof outbox.$inferSelect;
export type BorrowRequestRow = typeof borrowRequests.$inferSelect;
export type BorrowedItem = typeof borrowedItems.$inferSelect;
