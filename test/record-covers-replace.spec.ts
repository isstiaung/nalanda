// The one-off that takes Discogs' images out of storage (ARCH.md §16 #67, runbooks/record-covers.md): which stored
// record covers it counts as Discogs' (their provenance, read from the data), and its apply — the SQL
// scripts/record-covers.mjs runs, batch by batch, against a local D1 and bucket here.
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createItem, createLibrary, getItem } from '../src/db/queries';
import {
  batchCheckSql,
  coverProvenance,
  inBatches,
  RECORD_COVERS_SQL,
  referencedKeysSql,
  replacementStatement,
  settleBatch,
  type RecordCoverRow,
  type Replacement,
} from '../src/lib/record-covers';
import { rows } from './member-helpers';

describe('which stored record covers came from Discogs', () => {
  it('reads it from the data: a Discogs add never saved since; a typed cover is kept; anything else can’t be placed', async () => {
    const shelf = await createLibrary(env.DB, 'Records');
    const key = () => crypto.randomUUID();
    const discogsAdd = await createItem(env.DB, { libraryId: shelf.id, mediaType: 'vinyl', title: 'From Discogs', coverKey: key(), details: '{"discogs_id":11400290}' });
    const typed = await createItem(env.DB, { libraryId: shelf.id, mediaType: 'music', title: 'Typed by hand', coverKey: key(), details: '{"label":"Mine"}' });
    const edited = await createItem(env.DB, { libraryId: shelf.id, mediaType: 'vinyl', title: 'Saved since', coverKey: key(), details: '{"discogs_id":1}' });
    await env.DB.prepare("UPDATE items SET updated_at = datetime('now', '+1 minute') WHERE id = ?1").bind(edited.id).run();
    const wanted = await createItem(env.DB, { libraryId: shelf.id, mediaType: 'vinyl', title: 'Wanted from them', coverKey: key(), details: '{"discogs_id":2}', copies: 0 });
    await env.DB.prepare("INSERT INTO connections (id, base_url, household_name, public_key, status) VALUES (1, 'http://127.0.0.1:9', 'Them', '{}', 'active')").run();
    await env.DB.prepare(
      "INSERT INTO recommendations (activity_id, connection_id, incoming, media_type, title, recommender, status, wanted_item_id) VALUES ('a1', 1, 1, 'vinyl', 'Wanted from them', 'A member', 'wanted', ?1)",
    ).bind(wanted.id).run();
    // not record covers: a book with a release id and a cover, a record with no cover
    await createItem(env.DB, { libraryId: shelf.id, mediaType: 'book', title: 'A book', coverKey: key(), details: '{"discogs_id":3}' });
    await createItem(env.DB, { libraryId: shelf.id, mediaType: 'vinyl', title: 'No cover', details: '{"discogs_id":4}' });
    const typedId = await createItem(env.DB, { libraryId: shelf.id, mediaType: 'vinyl', title: 'Typed id', coverKey: key(), details: '{"discogs_id":"not a number"}' });

    const found = (await env.DB.prepare(RECORD_COVERS_SQL).all<RecordCoverRow>()).results;
    expect(found.map((row) => [row.title, coverProvenance(row)])).toEqual([
      [discogsAdd.title, { provenance: 'discogs', reason: 'discogs-add' }],
      [typed.title, { provenance: 'user', reason: 'typed' }],
      [edited.title, { provenance: 'unknown', reason: 'saved-since' }],
      [wanted.title, { provenance: 'unknown', reason: 'from-connection' }],
      [typedId.title, { provenance: 'user', reason: 'typed' }],
    ]);
  });
});

// ---------- apply ----------

describe('the apply, batch by batch', () => {
  /** What scripts/record-covers.mjs does with each batch, against this D1 and bucket: one call, read back, then R2. */
  async function applyInBatches(replacements: Replacement[], size: number, deleted = new Set<string>()) {
    const outcomes = [];
    for (const batch of inBatches(replacements, size)) {
      await env.DB.batch(batch.map((r) => env.DB.prepare(replacementStatement(r))));
      const now = (await env.DB.prepare(batchCheckSql(batch)).all<{ id: number; added_at: string; cover_key: string | null }>()).results;
      const keys = batch.flatMap((r) => (r.newKey ? [r.oldKey, r.newKey] : [r.oldKey]));
      const referenced = new Set((await env.DB.prepare(referencedKeysSql(keys)).all<{ cover_key: string }>()).results.map((r) => r.cover_key));
      const outcome = settleBatch(batch, now, referenced);
      for (const key of outcome.freed.filter((k) => !deleted.has(k))) {
        await env.COVERS.delete(key);
        deleted.add(key);
      }
      outcomes.push(outcome);
    }
    return outcomes;
  }

  it('swaps or drops each cover, leaves a row changed since alone, and frees each object only once nothing points at it', async () => {
    const shelf = await createLibrary(env.DB, 'Records');
    const planned: Replacement[] = [];
    // an awkward key from some older run: compared as text, never pasted into the statement
    const odd = "rehearsal'key;--";
    for (let n = 0; n < 7; n++) {
      const oldKey = n === 6 ? odd : crypto.randomUUID();
      const item = await createItem(env.DB, { libraryId: shelf.id, mediaType: 'vinyl', title: `LP ${n}`, coverKey: oldKey, details: '{"discogs_id":1}' });
      await env.COVERS.put(oldKey, 'old cover');
      const newKey = n % 2 === 0 ? crypto.randomUUID() : null; // even: the archive's cover; odd: dropped
      if (newKey) await env.COVERS.put(newKey, 'the archive’s cover');
      planned.push({ id: item.id, addedAt: (await getItem(env.DB, item.id))!.addedAt, oldKey, newKey });
    }
    // after the export: LP 2's cover is changed by hand, LP 3 is deleted and its id taken by another record, LP 4 becomes a book
    const handKey = crypto.randomUUID();
    await env.DB.prepare('UPDATE items SET cover_key = ?1 WHERE id = ?2').bind(handKey, planned[2]!.id).run();
    await env.DB.prepare('DELETE FROM items WHERE id = ?1').bind(planned[3]!.id).run();
    await env.DB.prepare(
      "INSERT INTO items (id, library_id, media_type, title, cover_key, details, added_at) VALUES (?1, ?2, 'vinyl', 'Newcomer', ?3, '{}', '2099-01-01 00:00:00')",
    ).bind(planned[3]!.id, shelf.id, planned[3]!.oldKey).run();
    await env.DB.prepare("UPDATE items SET media_type = 'book' WHERE id = ?1").bind(planned[4]!.id).run();
    await env.DB.prepare("UPDATE items SET updated_at = '2000-01-01 00:00:00'").run(); // so a write is visible

    const outcomes = await applyInBatches(planned, 3);
    expect(outcomes.map((o) => [o.landed.length, o.skipped.length])).toEqual([[2, 1], [1, 2], [1, 0]]);
    const now = new Map((await rows<{ id: number; title: string; cover_key: string | null; updated_at: string }>('SELECT id, title, cover_key, updated_at FROM items')).map((r) => [r.id, r]));
    for (const [n, r] of planned.entries()) {
      const row = now.get(r.id)!;
      if (n === 2) expect(row.cover_key, 'changed by hand').toBe(handKey);
      else if (n === 3) expect([row.title, row.cover_key], 'the newcomer').toEqual(['Newcomer', r.oldKey]);
      else if (n === 4) expect(row.cover_key, 'now a book').toBe(r.oldKey);
      else {
        expect(row.cover_key, `LP ${n}`).toBe(r.newKey);
        expect(row.updated_at, `LP ${n}`).not.toBe('2000-01-01 00:00:00');
      }
    }
    for (const n of [2, 3, 4]) expect(now.get(planned[n]!.id)!.updated_at).toBe('2000-01-01 00:00:00');
    // the bucket: old covers that were replaced or dropped are gone; the ones still pointed at stay; unused new ones go
    const objects = new Set((await env.COVERS.list()).objects.map((o) => o.key));
    for (const n of [0, 1, 5, 6]) expect(objects.has(planned[n]!.oldKey), `old ${n}`).toBe(false);
    for (const n of [0, 6]) expect(objects.has(planned[n]!.newKey!), `new ${n}`).toBe(true);
    expect(objects.has(planned[3]!.oldKey)).toBe(true); // the newcomer still points at it
    expect(objects.has(planned[4]!.oldKey)).toBe(true); // the book keeps its cover
    expect(objects.has(planned[2]!.newKey!)).toBe(false); // never taken: freed
    expect(objects.has(planned[4]!.newKey!)).toBe(false);

    // run again: nothing in the database moves, and nothing more leaves the bucket
    const snapshot = await rows('SELECT id, cover_key, updated_at FROM items ORDER BY id');
    const listed = (await env.COVERS.list()).objects.map((o) => o.key).sort();
    const deleted = new Set([...outcomes.flatMap((o) => o.freed)]);
    await applyInBatches(planned, 3, deleted);
    expect(await rows('SELECT id, cover_key, updated_at FROM items ORDER BY id')).toEqual(snapshot);
    expect((await env.COVERS.list()).objects.map((o) => o.key).sort()).toEqual(listed);
  });

  it('builds statements only from an id, a date and keys — refusing a malformed key — and batches as asked', () => {
    expect(() => replacementStatement({ id: 1, addedAt: '2026-01-01 00:00:00', oldKey: 'x', newKey: "x'; DROP TABLE items; --" })).toThrow();
    expect(() => replacementStatement({ id: 0, addedAt: '2026-01-01 00:00:00', oldKey: 'x', newKey: null })).toThrow();
    const sql = replacementStatement({ id: 5, addedAt: '2026-01-01 00:00:00', oldKey: "a';--", newKey: null });
    expect(sql).not.toContain("a';--");
    expect(sql.match(/;/g)).toHaveLength(1);
    expect(inBatches([1, 2, 3, 4, 5, 6, 7], 3)).toEqual([[1, 2, 3], [4, 5, 6], [7]]);
    expect(() => inBatches([1], 0)).toThrow();
  });
});
