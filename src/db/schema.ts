import { sql } from 'drizzle-orm';
import { index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

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
  sort: text('sort', { enum: ['added', 'title', 'rating'] }).notNull().default('title'),
  createdAt: text('created_at').notNull().default(now),
});

export const loginAttempts = sqliteTable('login_attempts', {
  ip: text('ip').notNull(),
  attemptedAt: text('attempted_at').notNull().default(now),
});

export type User = typeof users.$inferSelect;
export type Library = typeof libraries.$inferSelect;
export type Share = typeof shares.$inferSelect;
export type Item = typeof items.$inferSelect;
export type NewItem = typeof items.$inferInsert;
export type Loan = typeof loans.$inferSelect;
export type Tag = typeof tags.$inferSelect;
