import { sql } from 'drizzle-orm';
import { index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const MEDIA_TYPES = ['book', 'boardgame', 'vinyl', 'movie', 'music', 'videogame', 'other'] as const;
export type MediaType = (typeof MEDIA_TYPES)[number];

export const ITEM_STATUSES = ['not_started', 'in_progress', 'completed', 'abandoned'] as const;
export type ItemStatus = (typeof ITEM_STATUSES)[number];

/** How one read of an item stands. A book never started simply has no reads. */
export const READ_STATUSES = ['in_progress', 'completed', 'abandoned'] as const;
export type ReadStatus = (typeof READ_STATUSES)[number];

/**
 * A record's condition, graded by hand on the Goldmine scale Discogs uses (ARCH.md §16 #55): the codes of its
 * marketplace grades, best first. A sleeve can also be Generic (not the original) or missing altogether; Discogs'
 * "Not Graded" is no grade, stored as NULL. It describes this household's copy, like `copies`: never published.
 */
export const MEDIA_GRADES = ['M', 'NM', 'VG+', 'VG', 'G+', 'G', 'F', 'P'] as const;
export type MediaGrade = (typeof MEDIA_GRADES)[number];
export const SLEEVE_GRADES = [...MEDIA_GRADES, 'Generic', 'No Cover'] as const;
export type SleeveGrade = (typeof SLEEVE_GRADES)[number];

/**
 * What a household's custom field holds (ARCH.md §16 #95): a line of text, a yes/no, or a calendar date. An admin
 * defines up to CUSTOM_FIELD_LIMIT of them (src/lib/custom.ts); every item form shows them.
 */
export const CUSTOM_KINDS = ['text', 'bool', 'date'] as const;
export type CustomKind = (typeof CUSTOM_KINDS)[number];

/**
 * What a household's own display font may be (ARCH.md §16 #96), read from its bytes (sniffFontType in
 * src/lib/fonts.ts), never from the file's name or the type the browser claimed.
 */
export const FONT_FORMATS = ['woff2', 'woff', 'ttf', 'otf'] as const;
export type FontFormat = (typeof FONT_FORMATS)[number];

const now = sql`(datetime('now'))`;

export const users = sqliteTable('users', {
  id: integer('id').primaryKey(),
  username: text('username').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  role: text('role', { enum: ['admin', 'member'] }).notNull().default('member'),
  mustChangePassword: integer('must_change_password', { mode: 'boolean' }).notNull().default(false),
  createdAt: text('created_at').notNull().default(now),
  // Each person's own read state (§16 #36): the newest notification and feed entry they were shown. Ids, not
  // times — a feed visit pulls new entries after responding, usually within the same second, and a time
  // marker would count those as seen. NULL means never looked, so everything counts.
  notificationsSeenId: integer('notifications_seen_id'),
  feedSeenId: integer('feed_seen_id'),
  // The name a member goes by outside the app (§16 #45): on share pages and to connections, only while the household
  // has switched names on there. Optional — without one a member stays unnamed. Never a login, never unique: the
  // username is what signs in, and the username never leaves the app.
  displayName: text('display_name'),
  // Which account this is, across time (§16 #56): 128 random bits, set when the account is made and never reused.
  // Ids are reused — SQLite hands a new row max(id)+1, so removing the newest member frees theirs for the next — and a
  // session cookie names this key as well as the id, so a removed member's cookie never signs in as whoever comes
  // next. The '' default exists only so SQLite can add the column to a table that has rows (it allows no random
  // default there); the migration after it fills every row, every insert sets its own, and an empty key never
  // signs anyone in (sessionMatches in src/lib/auth.ts).
  sessionKey: text('session_key').notNull().default(''),
  // Which of this account's sessions still count (§16 #70): a cookie names the generation it was made in, and one
  // made in an earlier generation signs in nobody. "Sign out other devices", a password change and an admin's reset
  // each add one. Beside the key, never instead of it: the key is who the account is and hangs the identity stamps
  // (the scan queue's) — rotating it would drop a device's held scans; this rotates freely.
  sessionGeneration: integer('session_generation').notNull().default(0),
  // The interface language this member chose on Account (§16 #93), one of the shipped locales (src/i18n), or NULL to
  // follow the household's default (site_settings.language). A member's setting, not item data: not in the CSV
  // export; backups carry it with the row.
  locale: text('locale'),
});

export const libraries = sqliteTable('libraries', {
  id: integer('id').primaryKey(),
  name: text('name').notNull(),
  position: integer('position').notNull().default(0),
  shareToken: text('share_token').unique(), // legacy — migrated into `shares` (0004), no longer read/written
  createdAt: text('created_at').notNull().default(now),
});

/**
 * A series items belong to (ARCH.md §16 #52): "The Expanse", with the household's optional count of its volumes.
 * A table rather than a name on every item, so a rename or a total is one row. `key` is the name folded for
 * comparison (seriesKey() in src/lib/series.ts: Unicode lowercase, spaces collapsed) — the name is unique by it,
 * so "the expanse" and "The  Expanse" are one series. Any media type may belong to one.
 */
export const series = sqliteTable('series', {
  id: integer('id').primaryKey(),
  name: text('name').notNull(),
  key: text('key').notNull().unique(),
  total: integer('total'), // how many numbered volumes the series has; NULL = not known
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
    // The latest page reached, kept alongside the reading_progress history so a shelf or item page
    // never needs a subquery for it (50 D1 queries per invocation). NULL = nothing recorded yet.
    progressPage: integer('progress_page'),
    coverKey: text('cover_key'),
    // status, began_on, completed_on, read_count and rereading are worked out from `reads` (ARCH.md §16 #41) and
    // kept here so a shelf, a filter or a share view never needs a subquery. Only refreshReadState() writes them
    // once an item has reads. They are the household's, from everyone's reads (§16 #43): status, began_on and
    // completed_on describe the last finished read by anyone, or else an open one, or else the last abandoned one.
    status: text('status', { enum: ITEM_STATUSES }).notNull().default('not_started'),
    // The household's summary of `reviews` (§16 #43): the average rating, rounded to the 1–10 scale, and the review
    // written most recently. Only refreshReviewState() writes them once an item has reviews.
    rating: integer('rating'),
    review: text('review'),
    notes: text('notes'),
    // Where the household keeps it — "study, 2nd shelf", "Loft · box 3" (§16 #51). Free text, optional, and private
    // like notes: never on share pages or to connections, since it says where things are in someone's home.
    location: text('location'),
    copies: integer('copies').notNull().default(1),
    beganOn: text('began_on'),
    completedOn: text('completed_on'),
    readCount: integer('read_count').notNull().default(0), // finished reads
    rereading: integer('rereading', { mode: 'boolean' }).notNull().default(false), // finished before, and read again now
    details: text('details').notNull().default('{}'),
    // The record's own condition (§16 #55), set by hand: private like `copies` — whitelisted nowhere, so share pages
    // and connections never see it. Real columns, not `details`, which share pages render whole. NULL = not graded.
    mediaCondition: text('media_condition', { enum: MEDIA_GRADES }),
    sleeveCondition: text('sleeve_condition', { enum: SLEEVE_GRADES }),
    addedBy: integer('added_by').references(() => users.id),
    addedAt: text('added_at').notNull().default(now),
    updatedAt: text('updated_at').notNull().default(now),
    // The row's own time (§16 #90), which its stamp to connections is taken from (itemStamp()): NULL while it is
    // added_at, as it is for every row until an import re-dates the item from its file's "date added" — the one write
    // that moves added_at, and it keeps the time it moved from here, so a stamp a connection holds stays good.
    createdAt: text('created_at'),
    // Its series and its number in it (§16 #52): 3, or 2.5 for a novella between two books; NULL = in the series,
    // number not known. Added by ALTER TABLE, so the reference carries no ON DELETE (§16 #35): a series is deleted
    // only once nothing points at it (pruneSeries()).
    seriesId: integer('series_id').references(() => series.id),
    seriesNumber: real('series_number'),
    // What the household paid for it (§16 #61): an integer count of the currency's minor units — paise, cents; a
    // yen is its own — never a float, and always with the ISO 4217 code it was entered in. Both set, or both NULL.
    // The code is kept per item, not only in site_settings, so a household that changes its currency keeps what it
    // paid before in what it paid it in. Private like `copies`: whitelisted nowhere, never on share pages or to
    // connections.
    purchasePrice: integer('purchase_price'),
    purchaseCurrency: text('purchase_currency'),
    // The forms the household holds this one in (§16 #75): a set of codes from src/lib/formats.ts for its media type —
    // "hardcover,ebook", "lp,cd" — comma-joined, in the list's order, '' for none. One item per work: the editions it
    // is held in are facts about it, not items of their own (see `editions`). Public catalogue data, like the publisher.
    formats: text('formats').notNull().default(''),
    // Its language (§16 #76), ISO 639-1: every item added takes the household's default (site_settings.language) unless
    // the provider or the file said; NULL only on rows from before the column, which read as the household's. Public,
    // like the publisher. And the title it was first published under, in any script, optional and public.
    language: text('language'),
    originalTitle: text('original_title'),
    // The household's custom fields' values (§16 #95): a JSON object keyed by the field's id as a string — text of up
    // to 500 characters, `true` for a yes/no that is ticked, or a calendar date — '{}' for none. Its own column, never
    // `details`, which share pages render whole: a value is private unless its field's own switch (custom_fields.on_shares)
    // is on, and then it reaches a share page only through toPublicItem() given the fields. Never to connections.
    custom: text('custom').notNull().default('{}'),
  },
  (t) => [
    index('idx_items_library').on(t.libraryId),
    index('idx_items_isbn13').on(t.isbn13),
    index('idx_items_series').on(t.seriesId),
    // Rows read are what the free plan rations (5M a day), and D1 counts every row a sort passes through as read
    // again — even under LIMIT (§16 #68). These hand rows over already in the order a page asks for, so a shelf's
    // page of 60, newest first or by title, reads 60 rows instead of the whole shelf twice; the Overview's recent
    // items 12 instead of the catalogue twice; and the totals by type group without a sort.
    index('idx_items_library_added').on(t.libraryId, t.addedAt),
    index('idx_items_library_title').on(t.libraryId, t.title),
    index('idx_items_added').on(t.addedAt),
    index('idx_items_library_type').on(t.libraryId, t.mediaType),
    // only the priced items (§16 #61): the shelf's paid totals read those, not every item to find them
    index('idx_items_paid')
      .on(t.libraryId, t.purchaseCurrency, t.purchasePrice)
      .where(sql`${t.purchasePrice} IS NOT NULL`),
  ],
);

/**
 * "Also held as" (§16 #75): the other editions an item is held in, each with what finds it again — its format, ISBN
 * or barcode, publisher and year, every one optional. Their point is the scan: a barcode of another edition finds
 * the item ("In your catalog") instead of adding a duplicate. Private like the main ISBN: never on share pages.
 */
export const editions = sqliteTable(
  'editions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    itemId: integer('item_id')
      .notNull()
      .references(() => items.id, { onDelete: 'cascade' }),
    format: text('format'), // a code from src/lib/formats.ts, or none
    isbn: text('isbn'), // an ISBN-13, ISBN-10 or barcode, digits only
    publisher: text('publisher'),
    year: text('year'),
  },
  (t) => [index('idx_editions_item').on(t.itemId), index('idx_editions_isbn').on(t.isbn)],
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
  (t) => [
    primaryKey({ columns: [t.itemId, t.tagId] }),
    // a tag's items, from the tag: its page, a share link that captured it, and the Tags page's counts (§16 #68)
    index('idx_item_tags_tag').on(t.tagId),
  ],
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
    // which copy went out (§16 #75): one of the item's formats, chosen on the lend form when it holds more than one
    edition: text('edition'),
  },
  (t) => [index('idx_loans_item').on(t.itemId)],
);

/**
 * Borrowed from someone not on Nalanda (ARCH.md §16 #82): the mirror of a loan. The item is in the catalog as Not
 * owned (copies = 0) and carries its reads and review as any item does; this row says whose it is and until when.
 * Private like loans: never on share pages, never to connections. A book borrowed from a connected household is a
 * `borrowed_items` row; this is the plain one, typed in. One open borrow per item.
 */
export const borrows = sqliteTable(
  'borrows',
  {
    // AUTOINCREMENT: a borrow's id is in its return route, so it never names another borrow
    id: integer('id').primaryKey({ autoIncrement: true }),
    itemId: integer('item_id')
      .notNull()
      .references(() => items.id, { onDelete: 'cascade' }),
    lender: text('lender').notNull(),
    contact: text('contact'),
    borrowedOn: text('borrowed_on').notNull(), // YYYY-MM-DD, the device's day (§16 #69)
    dueOn: text('due_on'),
    returnedOn: text('returned_on'),
    note: text('note'),
  },
  (t) => [index('idx_borrows_item').on(t.itemId)],
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
  sort: text('sort', { enum: ['added', 'title', 'author', 'rating', 'completed'] }).notNull().default('title'),
  createdAt: text('created_at').notNull().default(now),
  // A gift list (§16 #53): this member's want list as it stands — every item they want, on any shelf — and nothing
  // else. Set only on a want-list share, whose other filters are all unset. No ON DELETE action: drizzle-kit drops it
  // on ALTER TABLE, so deleteUser() removes a member's want-list shares itself, in its batch.
  wantUserId: integer('want_user_id').references(() => users.id),
});

/**
 * Saved views (ARCH.md §16 #81): the household's named filter sets, one per shelf — the shelf's filter bar as a
 * query string (`params`), parsed by the same code as the bar's own URL (parseShelfQuery), so a view can hold
 * everything the bar can: types, statuses, holding, formats, the search box, "Read by", the sort, and the two
 * decluttering filters (addedYears, unplayedMonths). Any member saves, replaces (by name) or deletes one. In the
 * app only: never a share's source — `params` may hold `q` and `readBy`, which no share may.
 */
export const savedViews = sqliteTable(
  'saved_views',
  {
    // AUTOINCREMENT: a view's id is in its delete route, so it never names another view
    id: integer('id').primaryKey({ autoIncrement: true }),
    libraryId: integer('library_id')
      .notNull()
      .references(() => libraries.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    params: text('params').notNull(),
    createdBy: integer('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: text('created_at').notNull().default(now),
  },
  (t) => [uniqueIndex('idx_saved_views_name').on(t.libraryId, t.name)],
);

/**
 * Who is writing, for the item-history triggers (ARCH.md §16 #84): one row (id 1) set as the first statement of a
 * batch that changes items and deleted as its last — a batch is one transaction, so no other request ever sees it
 * (the import_in_progress marker's pattern, #40). Holds the member's session key as well as the id, so a history row
 * names the account as it was then and a reused id (#56) names nobody.
 */
export const acting = sqliteTable('acting', {
  id: integer('id').primaryKey(),
  userId: integer('user_id').notNull(),
  sessionKey: text('session_key').notNull(),
});

/**
 * Item history (ARCH.md §16 #84): each change to one of an item's own fields — title, creators, shelf, holding, cover,
 * notes, location… never reads, reviews or plays, which show who did them already — written by the triggers of
 * migration 0050 from whatever path changed it, with the member the `acting` row named, if any. Admin-only on the item
 * page; rows older than HISTORY_DAYS are swept by every item write (asWriter). Values are kept to 200 characters.
 */
export const itemHistory = sqliteTable(
  'item_history',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    itemId: integer('item_id')
      .notNull()
      .references(() => items.id, { onDelete: 'cascade' }),
    field: text('field').notNull(), // the column's name as the triggers write it
    before: text('before'),
    after: text('after'),
    changedBy: integer('changed_by'), // the member's id then, or null; never a reference — the row outlives the account
    changedKey: text('changed_key'), // their session key then (#56): shown as theirs only while it still matches
    at: text('at').notNull().default(now),
  },
  (t) => [index('idx_item_history_item').on(t.itemId, t.id), index('idx_item_history_at').on(t.at)], // `at`: the sweep past HISTORY_DAYS on every item write
);

/**
 * A member's read-only API tokens (ARCH.md §16 #88): made on the Account page, shown once, kept only as a SHA-256 hash.
 * Bound to the account as a session is — its id, its key (#56) and the generation it was made in (#70) — so a removed
 * member's token signs in nobody, and "Sign out other devices", a new password or a reset take every token down.
 */
export const apiTokens = sqliteTable(
  'api_tokens',
  {
    // AUTOINCREMENT: a token's id is in its revoke route, so it never names another token
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    sessionKey: text('session_key').notNull(),
    generation: integer('generation').notNull(),
    name: text('name').notNull(),
    tokenHash: text('token_hash').notNull().unique(), // SHA-256 of the secret, hex; the secret itself is never stored
    createdAt: text('created_at').notNull().default(now),
  },
  (t) => [index('idx_api_tokens_user').on(t.userId)],
);
export type ApiToken = typeof apiTokens.$inferSelect;

/**
 * One-time links to an account (ARCH.md §16 #97): how an admin lets a member in — an invite for a new account, a reset
 * for a forgotten password — without ever seeing a password. Kept only as a SHA-256 hash of the secret in the link,
 * bound to the account as a session is (its id and key, #56), good for LINK_DAYS and once: setting a password through
 * one deletes every link of that account. An account has at most one at a time; a new one replaces it.
 */
export const accountLinks = sqliteTable(
  'account_links',
  {
    // AUTOINCREMENT: nothing outside names a link by id, but a reused id would never name a newer link either
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    sessionKey: text('session_key').notNull(),
    purpose: text('purpose', { enum: ['invite', 'reset'] }).notNull(),
    tokenHash: text('token_hash').notNull().unique(), // SHA-256 of the secret, hex; the secret itself is never stored
    expiresAt: text('expires_at').notNull(),
    createdAt: text('created_at').notNull().default(now),
  },
  (t) => [index('idx_account_links_user').on(t.userId)],
);
export type AccountLink = typeof accountLinks.$inferSelect;

/**
 * Each signed-in device (ARCH.md §16 #98): one row per sign-in, named in that device's cookie by its id, so Account can
 * list them and sign one out. Bound to the account as the cookie is — its key (#56) and generation (#70) — so "Sign out
 * other devices", a new password or a reset end every row at once. Sliding: a row lives SESSION_TTL_SECONDS from when it
 * was last used, and `last_seen_at` moves at most once a day, so an ordinary request writes nothing.
 */
export const sessions = sqliteTable(
  'sessions',
  {
    id: text('id').primaryKey(), // 16 random bytes, base64url; in the signed cookie, so knowing it alone forges nothing
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    sessionKey: text('session_key').notNull(),
    generation: integer('generation').notNull(),
    device: text('device').notNull().default(''), // "Chrome on macOS", read from the User-Agent at sign-in; nothing else of it kept
    createdAt: text('created_at').notNull().default(now),
    lastSeenAt: text('last_seen_at').notNull().default(now),
  },
  (t) => [index('idx_sessions_user').on(t.userId)],
);
export type DeviceSession = typeof sessions.$inferSelect;

/**
 * Failed password checks, for throttling (ARCH.md §8): a row is written before the password is checked, in the one
 * statement that also refuses it once the IP or the account has ten in ten minutes (`recordLoginAttempt()`), and
 * taken back when the password turns out right. `username` is as typed — the account guessed at — so guesses spread
 * over many addresses are still counted together, and one address's guesses lock out only the accounts they named.
 */
export const loginAttempts = sqliteTable('login_attempts', {
  ip: text('ip').notNull(),
  username: text('username').notNull().default(''),
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
 * Household-wide switches, in a single row (id 1). A missing row means every default (SITE_DEFAULTS in
 * src/db/queries.ts), so a new instance needs no setup step. Since reading goals a new instance starts with names and goals
 * on (§16 #49); migration 0036 gave every instance that already had members a row pinning what it had. The column
 * defaults below are what an ALTER TABLE gives existing rows — off — not what a new instance starts with.
 */
export const siteSettings = sqliteTable('site_settings', {
  id: integer('id').primaryKey(),
  // Share pages show a book's reading progress only when this is on (ARCH.md §9, §16 #34).
  progressOnShares: integer('progress_on_shares', { mode: 'boolean' }).notNull().default(false),
  // Progress updates reach connections' feeds unless this is turned off (§16 #35).
  progressToConnections: integer('progress_to_connections', { mode: 'boolean' }).notNull().default(true),
  // Members' display names, and each one's rating and review, on share pages (§16 #45). Off: share pages as before.
  namesOnShares: integer('names_on_shares', { mode: 'boolean' }).notNull().default(false),
  // Connections get one feed entry per person, with their display name, and everyone's review on an item page (§16 #45).
  namesToConnections: integer('names_to_connections', { mode: 'boolean' }).notNull().default(false),
  // Members' reading goals — set, halfway, reached — reach connections as per-person entries (§16 #49). Takes effect
  // only while namesToConnections is on: a goal entry is always signed, never "A member".
  goalsToConnections: integer('goals_to_connections', { mode: 'boolean' }).notNull().default(false),
  // The household's currency (§16 #61), an ISO 4217 code an admin sets: what purchase prices are entered in. NULL
  // until one is set — the item form then asks for it rather than guessing. Never leaves the app.
  currency: text('currency'),
  // The household's default language (§16 #76), ISO 639-1: what an added item takes unless told otherwise; English
  // until an admin picks another. The interface follows it too, where a translation exists (§16 #93).
  language: text('language').notNull().default('en'),
  updatedAt: text('updated_at').notNull().default(now),
});

/**
 * The household's own interface translation (§16 #93), one row per shipped locale: a JSON object of string key →
 * text, imported by an admin from a file edited by hand, overriding the shipped strings key by key — for this
 * household alone, share pages included. Validated on the way in (parseTranslation in src/i18n), escaped on the way
 * out like any string. Removed by an admin's "Remove"; never anything a member typed elsewhere.
 */
export const translations = sqliteTable('translations', {
  locale: text('locale').primaryKey(),
  strings: text('strings').notNull(),
  updatedAt: text('updated_at').notNull().default(now),
});

/**
 * The household's own display font (§16 #96), at most one per shipped locale: the face titles and the brand take in
 * that language, ahead of Eczar and Tiro Tamil. Uploaded by an admin under Members; the file is an R2 object under a
 * random UUID (`key`), public at /fonts/<key> like a cover. `name` is the file's name as uploaded, cleaned, shown on
 * Members alone; `bytes` its size. Pages read only `key` and `format`, each checked before it reaches a <style>.
 */
export const displayFonts = sqliteTable('display_fonts', {
  locale: text('locale').primaryKey(),
  key: text('key').notNull(),
  format: text('format', { enum: FONT_FORMATS }).notNull(),
  name: text('name').notNull(),
  bytes: integer('bytes').notNull(),
  uploadedAt: text('uploaded_at').notNull().default(now),
});
export type DisplayFont = typeof displayFonts.$inferSelect;

/**
 * The household's custom fields (ARCH.md §16 #95): up to ten, each a name, a kind and whether its values may show on
 * share pages — off by default, so a new field is private like notes until an admin says otherwise. Values live on
 * each item in `items.custom`, keyed by the field's id. Ids are never reused (AUTOINCREMENT): a value a trash
 * snapshot keeps under a deleted field's id can't come back under a newer field's. Deleting a field strips its key
 * from every item in the same batch. Names are unique without regard to case; the export writes values by name, so a
 * file moves between households.
 */
export const customFields = sqliteTable(
  'custom_fields',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    kind: text('kind', { enum: CUSTOM_KINDS }).notNull(),
    position: integer('position').notNull().default(0),
    onShares: integer('on_shares', { mode: 'boolean' }).notNull().default(false),
    createdAt: text('created_at').notNull().default(now),
  },
  (t) => [uniqueIndex('idx_custom_fields_name').on(sql`lower(${t.name})`)],
);
export type CustomField = typeof customFields.$inferSelect;

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
  sort: text('sort', { enum: ['added', 'title', 'author', 'rating', 'completed'] }).notNull().default('title'),
  createdAt: text('created_at').notNull().default(now),
});

/**
 * Each time someone read an item — started, finished, stopped — the source of truth for its reading state
 * (ARCH.md §16 #41, #43). items.status and the columns beside it are the household's summary of these rows,
 * derived by refreshReadState() in the same batch as any write here. Each reader has at most one open read of
 * an item at a time.
 */
export const reads = sqliteTable(
  'reads',
  {
    // AUTOINCREMENT: a read's id is in its routes and in reading_progress.read_id, so it never names another read
    id: integer('id').primaryKey({ autoIncrement: true }),
    itemId: integer('item_id')
      .notNull()
      .references(() => items.id, { onDelete: 'cascade' }),
    status: text('status', { enum: READ_STATUSES }).notNull(),
    beganOn: text('began_on'), // YYYY-MM-DD; NULL = not known
    endedOn: text('ended_on'), // when it was finished or stopped; NULL while open, or not known
    createdAt: text('created_at').notNull().default(now),
    // Whose read it is (§16 #43). NULL: a member removed since — their reads stay, unattributed, like items.added_by.
    // No ON DELETE action: drizzle-kit drops it on ALTER TABLE, so deleteUser() clears it in its own batch.
    readerId: integer('reader_id').references(() => users.id),
  },
  (t) => [
    index('idx_reads_item').on(t.itemId),
    // a second "Read again" while one is open makes nothing rather than a second open read — per reader, so two
    // people can read a book at once. NULLs are distinct in a unique index, so unattributed open reads aren't held
    // to one here; the app never opens one, and treats them as one reader when it checks (sameReader in queries.ts).
    uniqueIndex('reads_one_open_per_reader').on(t.itemId, t.readerId).where(sql`${t.status} = 'in_progress'`),
    // a year's finishes as a range (Year in review, §16 #59, #68), and the reads being read now ("Read by", §16 #43)
    index('idx_reads_status_ended').on(t.status, t.endedOn),
  ],
);

/**
 * Each member's rating and review of an item (§16 #43). items.rating and items.review are the household's summary
 * of these rows — the average rating, and the review written most recently — kept by refreshReviewState() in the
 * same batch as every write here, so share pages, connections, the activity triggers and the export read them as
 * before.
 */
export const reviews = sqliteTable(
  'reviews',
  {
    // AUTOINCREMENT: a review's id is in its routes, so it never names another one
    id: integer('id').primaryKey({ autoIncrement: true }),
    itemId: integer('item_id')
      .notNull()
      .references(() => items.id, { onDelete: 'cascade' }),
    // NULL: a member removed since, whose review stays, unattributed
    userId: integer('user_id').references(() => users.id, { onDelete: 'set null' }),
    rating: integer('rating'), // half-stars 1–10; NULL = not rated
    review: text('review'), // NULL = no review, only a rating
    createdAt: text('created_at').notNull().default(now),
    updatedAt: text('updated_at').notNull().default(now),
    // When its text was last written — which review is the household's latest. A rating changed on its own leaves it,
    // so re-rating a book doesn't push an old review over a newer one. NULL with no text.
    reviewedAt: text('reviewed_at'),
    // When its rating was last given — what a "rated" feed entry is dated by once the household's average falls back
    // to older ratings. Only a change of the rating moves it; editing the text alone doesn't. NULL with no rating.
    ratedAt: text('rated_at'),
  },
  // one review per person per item; NULLs are distinct, so reviews of removed members never collide
  (t) => [uniqueIndex('reviews_item_user').on(t.itemId, t.userId)],
);

/**
 * A member's reading goal (§16 #49): N books in a year, one per member per year. What counts is worked out when asked,
 * never stored — every finished read of a book by that member with its end date in that year, re-reads included — so a
 * read added, moved, corrected or deleted changes the count at once. A member's goals go with them when they're removed.
 */
export const readingGoals = sqliteTable(
  'reading_goals',
  {
    // AUTOINCREMENT: a goal's id is in its routes and feed entries point at it, so it never names another one
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    year: integer('year').notNull(),
    target: integer('target').notNull(), // books, 1–MAX_GOAL_TARGET
    createdAt: text('created_at').notNull().default(now),
    updatedAt: text('updated_at').notNull().default(now),
  },
  (t) => [uniqueIndex('reading_goals_user_year').on(t.userId, t.year)],
);

/**
 * One row per "I'm on page N" update, oldest to newest — the reading log Goodreads calls progress
 * updates. items.progress_page holds the latest for cheap reads; this table is the history, and
 * deleting a row recomputes it.
 */
export const readingProgress = sqliteTable(
  'reading_progress',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    itemId: integer('item_id')
      .notNull()
      .references(() => items.id, { onDelete: 'cascade' }),
    // Not capped at items.length: provider page counts are often wrong, and a real reader's page
    // number shouldn't be refused because Open Library disagrees. Percentages clamp at 100 instead.
    page: integer('page').notNull(),
    at: text('at').notNull().default(now),
    // Whose page it is: the reader of its read (§16 #43) — moving a read moves its pages' too.
    addedBy: integer('added_by').references(() => users.id),
    // Which read the page belongs to. NULL only for a page recorded before reads existed on an item that has
    // none. No ON DELETE action — drizzle-kit drops it on ALTER TABLE — so deleteRead() removes the pages first.
    readId: integer('read_id').references(() => reads.id),
  },
  (t) => [index('idx_reading_progress_item').on(t.itemId, t.at), index('idx_reading_progress_read').on(t.readId)],
);

/**
 * Each time the household played a board game or a record (ARCH.md §16 #54) — a play log for games, a listening log
 * for records. A play is the household's, not a person's: nothing on `items` summarizes it and no status depends on
 * it, so a play changes no item column and fires no activity trigger. `logged_by` is kept only for auditing and for
 * who may remove it (whoever logged it, or an admin). Dated only, by the day: no players, scores or durations.
 */
export const plays = sqliteTable(
  'plays',
  {
    // AUTOINCREMENT: a play's id is in its delete route, so it never names another play
    id: integer('id').primaryKey({ autoIncrement: true }),
    itemId: integer('item_id')
      .notNull()
      .references(() => items.id, { onDelete: 'cascade' }),
    playedOn: text('played_on').notNull(), // YYYY-MM-DD
    // who pressed Played; NULL: a member removed since — the play stays, since it is the household's
    loggedBy: integer('logged_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: text('created_at').notNull().default(now),
  },
  (t) => [
    // an item's plays: its count, its last play and its recent ones (the item page), and last played per item
    // ("what should we play tonight") — max(played_on) per item_id reads the index alone
    index('idx_plays_item_played').on(t.itemId, t.playedOn),
    // plays in a date range, across the catalogue ("year in review"): a range scan, grouped by item from the index
    index('idx_plays_played_item').on(t.playedOn, t.itemId),
  ],
);

/**
 * Each member's want list (§16 #53): what they want to read — or, for a record or a game, want — one row per member
 * per item. A member's own, changed only by them. Their finishing a book takes it off (closeRead, and the edit form's
 * Completed); removing the member clears their list, and deleting the item takes it off every list.
 */
export const wants = sqliteTable(
  'wants',
  {
    itemId: integer('item_id')
      .notNull()
      .references(() => items.id, { onDelete: 'cascade' }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: text('created_at').notNull().default(now),
  },
  (t) => [primaryKey({ columns: [t.userId, t.itemId] }), index('idx_wants_item').on(t.itemId)],
);

/**
 * Where to buy an item (§16 #53): a label and an http(s) URL someone pasted — never generated. The item's, shared by
 * the household: any member adds or removes one. Public only on a want-list share (a gift list), never on a shelf's
 * share page or to connections.
 */
export const purchaseLinks = sqliteTable(
  'purchase_links',
  {
    // AUTOINCREMENT: a link's id is in its remove route, so it never names another link
    id: integer('id').primaryKey({ autoIncrement: true }),
    itemId: integer('item_id')
      .notNull()
      .references(() => items.id, { onDelete: 'cascade' }),
    label: text('label').notNull(),
    url: text('url').notNull(),
    createdAt: text('created_at').notNull().default(now),
  },
  // the same URL twice on one item is one link
  (t) => [uniqueIndex('purchase_links_item_url').on(t.itemId, t.url)],
);

export const ACTIVITY_KINDS = ['reviewed', 'rated', 'finished', 'progress', 'started'] as const; // 'started': per person only (§16 #45)
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

/**
 * A member's reading goal as news (§16 #49): set (or its target changed), halfway, reached. Per person only, and the
 * only entries with no item — so a household on 1.3.0 or older, whose parser knows none of these kinds and needs an
 * item on every entry, skips them and keeps the rest of the page.
 */
export const GOAL_KINDS = ['goal_set', 'goal_halfway', 'goal_reached'] as const;
export type GoalKind = (typeof GOAL_KINDS)[number];
/** Every kind a feed entry can be: about an item, or about a member's goal. */
export const FEED_KINDS = [...ACTIVITY_KINDS, ...GOAL_KINDS] as const;
export type FeedKind = (typeof FEED_KINDS)[number];
export const isGoalKind = (k: unknown): k is GoalKind => (GOAL_KINDS as readonly unknown[]).includes(k);

/**
 * Written only by triggers (migration 0007 on `items`, 0015 on `reading_progress`), and only while a
 * connection view exists. One row per item and kind: a repeat replaces the row under a new id, so the
 * id doubles as the feed cursor and a replaced id tells a connection its stored copy is out of date.
 * Progress is the exception — every update is its own entry, pointing at its reading_progress row,
 * and goes when that row does (§16 #35).
 */
/**
 * The trash (ARCH.md §16 #74): a deleted item, kept for 30 days as one row. The delete is a real delete — the item
 * leaves every shelf, share, view, export and search as it always did — and this row holds what it was: the item's
 * columns and everything that hung off it (tags, series, reads, reviews, pages, plays, wants, links, loans), built by
 * SQLite as JSON in the same batch as the delete. Restoring runs it back through the import's insert, under a new id.
 * The cover's object stays in R2 under `cover_key` until the row is purged. No foreign keys: the shelf and the member
 * may be gone by then, and the row must still say what it said.
 */
export const trash = sqliteTable(
  'trash',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    itemId: integer('item_id').notNull(), // the id it had — for the record; a restore gets a new one
    // its shelf, by id and by name: shelf ids may be reused, so a restore goes only to the shelf still so named
    libraryId: integer('library_id'),
    libraryName: text('library_name'),
    mediaType: text('media_type').notNull(),
    title: text('title').notNull(),
    creators: text('creators'),
    coverKey: text('cover_key'),
    payload: text('payload').notNull(), // JSON: { item, tags, series, reads, reviews, loans, plays, wants, links, progress }
    deletedAt: text('deleted_at').notNull().default(now),
    // who deleted it: the id and the account's key (§16 #56), so a member given the id later is never named
    deletedBy: integer('deleted_by'),
    deletedByKey: text('deleted_by_key'),
  },
  (t) => [index('idx_trash_deleted').on(t.deletedAt)],
);

/**
 * Quotes and highlights (ARCH.md §16 #77): a member's own, on a book — a line copied down, with the page or Kindle
 * location and, optionally, the reader's own note beside the author's words. Private until the member marks it
 * `shared`: only a shared quote reaches a share page, signed with a display name only while names are on there.
 * `source` is 'kindle' for a highlight the Kindle import brought (dated by Kindle, in `at`), else NULL.
 */
export const quotes = sqliteTable(
  'quotes',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    itemId: integer('item_id')
      .notNull()
      .references(() => items.id, { onDelete: 'cascade' }),
    userId: integer('user_id').references(() => users.id, { onDelete: 'set null' }), // NULL: a member removed since
    text: text('text').notNull(),
    page: text('page'), // "42", or a Kindle location "1234-1236"; free text, short
    note: text('note'),
    shared: integer('shared', { mode: 'boolean' }).notNull().default(false),
    source: text('source'),
    at: text('at').notNull().default(now),
  },
  (t) => [index('idx_quotes_item').on(t.itemId), index('idx_quotes_user').on(t.userId)],
);

export const activityLog = sqliteTable(
  'activity_log',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    itemId: integer('item_id')
      .notNull()
      .references(() => items.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ACTIVITY_KINDS }).notNull(),
    at: text('at').notNull().default(now),
    // Set only on a progress entry: which update it is, so it carries that page. No ON DELETE CASCADE:
    // SQLite can't add one through ALTER TABLE, so deleteProgress() removes this row itself, first.
    progressId: integer('progress_id').references(() => readingProgress.id),
  },
  (t) => [
    // partial: the INSERT OR REPLACE in 0007's triggers still collapses reviews, ratings and finishes,
    // while progress entries accumulate
    uniqueIndex('activity_log_item_kind').on(t.itemId, t.kind).where(sql`${t.kind} <> 'progress'`),
    index('idx_activity_log_at').on(t.at),
    index('idx_activity_log_progress').on(t.progressId),
  ],
);

/**
 * Each member's own activity, for the per-person feed connections get while names are switched on (§16 #45). Written
 * only by triggers (migrations 0027, 0036) on reads, reviews and reading_progress, and by a goal's own write, and only
 * while a connection view exists — always, whatever the switches say: they decide at serve time which stream a
 * connection pulls, and whether goals are in it. Who did it is never stored here; it is the reader of `read_id`, the
 * writer of `review_id`, the reader of `progress_id`'s read, or the member whose goal `goal_id` is, resolved when
 * served, so moving a read or removing a member changes every later pull. One row per read and kind, per review and
 * kind, and per goal and kind, replaced on a repeat, as activity_log does per item; progress accumulates. Served with
 * ids offset by MEMBER_ACTIVITY_BASE, so the two streams never share a cursor.
 *
 * Goal entries (§16 #49): `goal_set` has no item; a milestone keeps the finished read that crossed the line
 * (`read_id`, `item_id`), so it goes only to views that hold that book, and goes when that read does. `goal_target` and
 * `goal_count` are the goal's target and count when the entry was recorded — what it said then, never recomputed.
 */
export const memberActivity = sqliteTable(
  'member_activity',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    // NULL only on a `goal_set` entry: a goal is about a person, not a book (migration 0036 made it nullable)
    itemId: integer('item_id').references(() => items.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: FEED_KINDS }).notNull(),
    at: text('at').notNull().default(now),
    readId: integer('read_id').references(() => reads.id, { onDelete: 'cascade' }), // started, finished; a milestone's finish
    reviewId: integer('review_id').references(() => reviews.id, { onDelete: 'cascade' }), // rated, reviewed
    progressId: integer('progress_id').references(() => readingProgress.id, { onDelete: 'cascade' }), // progress
    goalId: integer('goal_id').references(() => readingGoals.id, { onDelete: 'cascade' }), // goal_set, goal_halfway, goal_reached
    goalTarget: integer('goal_target'),
    goalCount: integer('goal_count'),
  },
  (t) => [
    uniqueIndex('member_activity_read_kind').on(t.kind, t.readId).where(sql`${t.readId} IS NOT NULL`),
    uniqueIndex('member_activity_review_kind').on(t.kind, t.reviewId).where(sql`${t.reviewId} IS NOT NULL`),
    uniqueIndex('member_activity_goal_kind').on(t.goalId, t.kind).where(sql`${t.goalId} IS NOT NULL`),
    index('idx_member_activity_at').on(t.at),
    index('idx_member_activity_item').on(t.itemId),
    index('idx_member_activity_progress').on(t.progressId),
  ],
);

/**
 * Holds a row only inside an import's batch — its first statement inserts it, its last deletes it — so the
 * activity triggers (migration 0021) can tell an import from someone's own edit. An import's finishes,
 * ratings and reviews are dated by the book's completed_on, or not recorded at all (ARCH.md §16 #40).
 */
export const importInProgress = sqliteTable('import_in_progress', {
  id: integer('id').primaryKey(),
});

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
    // AUTOINCREMENT (migration 0019): never reused, so a reader's feed_seen_id watermark stays meaningful
    // after the newest entry is withdrawn (§16 #36).
    id: integer('id').primaryKey({ autoIncrement: true }),
    subscriptionId: integer('subscription_id')
      .notNull()
      .references(() => feedSubscriptions.id, { onDelete: 'cascade' }),
    remoteId: integer('remote_id').notNull(), // their activity_log id
    itemRemoteId: integer('item_remote_id').notNull(), // their items id; 0 on a goal entry, which has no item (§16 #49)
    itemStamp: text('item_stamp').notNull().default(''), // phase 3: which of their books that id meant; '' on a goal entry
    kind: text('kind', { enum: FEED_KINDS }).notNull(),
    publishedAt: text('published_at').notNull(),
    item: text('item').notNull(), // the validated FeedItem as JSON — or, on a goal entry, the validated FeedGoal
    bytes: integer('bytes').notNull(),
    receivedAt: text('received_at').notNull().default(now),
  },
  (t) => [
    uniqueIndex('remote_activities_subscription_remote').on(t.subscriptionId, t.remoteId),
    index('idx_remote_activities_published').on(t.publishedAt),
    index('idx_remote_activities_item').on(t.itemRemoteId),
  ],
);

/**
 * Things that happened with connections that someone here should know about (§16 #36). The kinds that need
 * an admin to act — a household asking to connect — are shown only to admins.
 */
export const NOTIFICATION_KINDS = [
  'connection_request', // they redeemed our invitation: confirm or decline on Connections
  'connection_accepted', // they confirmed ours
  'connection_declined',
  'connection_withdrawn', // they took back a request still waiting on us
  'disconnected',
  'borrow_request',
  'borrow_withdrawn',
  'borrow_accepted',
  'borrow_declined',
  'returned', // the lender recorded our return
  'comment',
  'recommendation', // a household recommended one of its items to this one (§16 #58)
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];
export const ADMIN_NOTIFICATIONS: readonly NotificationKind[] = [
  'connection_request',
  'connection_accepted',
  'connection_declined',
  'connection_withdrawn',
  'disconnected',
];

/**
 * Household-wide, read per person through users.notifications_seen_at. Names and titles are copied in when
 * the event happens, so a notification still reads right after the connection or book is gone. They come
 * from another instance and render only as escaped text (CLAUDE.md); `href` is always built here.
 */
export const notifications = sqliteTable(
  'notifications',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    kind: text('kind', { enum: NOTIFICATION_KINDS }).notNull(),
    householdName: text('household_name').notNull(),
    subject: text('subject'), // a book title, when the event is about one
    href: text('href').notNull(),
    at: text('at').notNull().default(now),
  },
  (t) => [index('idx_notifications_at').on(t.at)],
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

// Recommendations between connected households (ARCH.md §16 #58).

/**
 * `open`: sent (ours), or waiting in the Recommended list (theirs). `dismissed` and `wanted` are this household's
 * answers to one of theirs, kept only here — the sender is never told. `refused`: they turned ours away for good.
 */
export const RECOMMENDATION_STATUSES = ['open', 'dismissed', 'wanted', 'refused'] as const;
export type RecommendationStatus = (typeof RECOMMENDATION_STATUSES)[number];

/**
 * A recommendation of one item, between this household and one connection. `incoming`: they recommended one of
 * theirs to us, and the row keeps what the list shows — the item's title, creators and cover key as they sent them,
 * the name it was signed with and the note, all strings from another instance. Otherwise one of ours went to them
 * (`ourItemId`), sent by `senderId`, with what it carried. The same activity id names it on both sides, and the row
 * stays after a dismissal, so the same message pulled again from their outbox isn't taken twice.
 */
export const recommendations = sqliteTable(
  'recommendations',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    activityId: text('activity_id').notNull().unique(),
    connectionId: integer('connection_id')
      .notNull()
      .references(() => connections.id, { onDelete: 'cascade' }),
    incoming: integer('incoming', { mode: 'boolean' }).notNull(),
    ourItemId: integer('our_item_id').references(() => items.id, { onDelete: 'cascade' }),
    senderId: integer('sender_id').references(() => users.id, { onDelete: 'set null' }),
    theirItemId: integer('their_item_id'),
    theirItemStamp: text('their_item_stamp'),
    theirViewId: integer('their_view_id'),
    mediaType: text('media_type', { enum: MEDIA_TYPES }).notNull(),
    title: text('title').notNull(),
    creators: text('creators'),
    published: text('published'),
    coverKey: text('cover_key'),
    // the item's public identifiers, as JSON — `bgg_id`, `discogs_id`, from its details — so a want finds a copy
    // already here (existingForWant) instead of adding a second one
    identifiers: text('identifiers').notNull().default('{}'),
    // as signed: a display name while names go to connections, else "A member" — never a username
    recommender: text('recommender').notNull(),
    note: text('note'),
    status: text('status', { enum: RECOMMENDATION_STATUSES }).notNull().default('open'),
    handledBy: integer('handled_by').references(() => users.id, { onDelete: 'set null' }),
    // theirs, once wanted: the item here it went onto someone's want list as — so the same book recommended again
    // by that household finds it, as a scan's want finds a copy by its ISBN
    wantedItemId: integer('wanted_item_id').references(() => items.id, { onDelete: 'set null' }),
    createdAt: text('created_at').notNull().default(now),
    handledAt: text('handled_at'),
  },
  (t) => [
    index('idx_recommendations_connection').on(t.connectionId, t.incoming, t.status),
    index('idx_recommendations_our_item').on(t.ourItemId),
  ],
);

export type User = typeof users.$inferSelect;
export type Library = typeof libraries.$inferSelect;
export type Share = typeof shares.$inferSelect;
export type Series = typeof series.$inferSelect;
export type Item = typeof items.$inferSelect;
export type NewItem = typeof items.$inferInsert;
export type Loan = typeof loans.$inferSelect;
export type Borrow = typeof borrows.$inferSelect;
export type Tag = typeof tags.$inferSelect;
export type FederationSettings = typeof federationSettings.$inferSelect;
export type ConnectionInvite = typeof connectionInvites.$inferSelect;
export type Connection = typeof connections.$inferSelect;
export type ConnectionView = typeof connectionViews.$inferSelect;
export type FeedSubscription = typeof feedSubscriptions.$inferSelect;
export type ReadingProgress = typeof readingProgress.$inferSelect;
export type Read = typeof reads.$inferSelect;
export type Review = typeof reviews.$inferSelect;
export type Play = typeof plays.$inferSelect;
export type ReadingGoal = typeof readingGoals.$inferSelect;
export type Notification = typeof notifications.$inferSelect;
export type RemoteActivity = typeof remoteActivities.$inferSelect;
export type Comment = typeof comments.$inferSelect;
export type OutboxRow = typeof outbox.$inferSelect;
export type BorrowRequestRow = typeof borrowRequests.$inferSelect;
export type BorrowedItem = typeof borrowedItems.$inferSelect;
export type PurchaseLink = typeof purchaseLinks.$inferSelect;
export type Recommendation = typeof recommendations.$inferSelect;
