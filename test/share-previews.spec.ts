// Link previews on share pages (ARCH.md §16 #71): the Open Graph tags a chat app reads when a share link is pasted.
// Only what the page itself shows — its name, a count, an item's title and creators, a cover already served — with
// the page still noindex, and nothing the whitelist keeps back.
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createLibrary, createLoan, createShare, listShares, setDisplayName, setItemTags, setWant, updateSiteSettings } from '../src/db/queries';
import { giftListStamp } from '../src/lib/auth';
import { newShareToken, previewText } from '../src/lib/share';
import { clearSharePageCache } from '../src/routes/share';
import { as, book, member, upgradedSwitches, type Member } from './member-helpers';

async function publicPage(path: string) {
  clearSharePageCache();
  const res = await as(null, path);
  return { status: res.status, text: await res.text() };
}

/** The Open Graph and Twitter tags a page carries, by property or name. */
function tags(html: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of html.matchAll(/<meta (?:property|name)="((?:og|twitter):[^"]+)" content="([^"]*)"/g)) out[m[1]!] = m[2]!;
  return out;
}

const giftList = async (of: Member, by: Member) => {
  const res = await as(by, '/shares', { body: { wantUserId: String(of.id), wantStamp: await giftListStamp(env.SESSION_SECRET, of) } });
  expect(res.status).toBe(302);
  return (await listShares(env.DB)).at(-1)!;
};

describe('previewText', () => {
  it('collapses whitespace and cuts at a word', () => {
    expect(previewText('  Ged goes\n\nto   school. ')).toBe('Ged goes to school.');
    expect(previewText(null)).toBe('');
    const long = 'word '.repeat(60).trim();
    const cut = previewText(long, 50);
    expect(cut.length).toBeLessThanOrEqual(50);
    expect(cut.endsWith('word…')).toBe(true);
    expect(previewText('a'.repeat(80), 20)).toBe(`${'a'.repeat(19)}…`); // no word to cut at: cut anyway
    expect(previewText('Hello there, friends and all', 14)).toBe('Hello there…'); // not "Hello there,…"
  });
});

describe('a shared shelf', () => {
  it('previews as its name, its count and its first cover, at its own URL, still noindex', async () => {
    const asha = await member('asha', 'admin');
    const shelf = await createLibrary(env.DB, 'Fiction');
    await book(asha, { libraryId: shelf.id, title: 'Aardvark Tales', coverKey: null });
    await book(asha, { libraryId: shelf.id, title: 'Piranesi', coverKey: 'cover-piranesi' });
    await book(asha, { libraryId: shelf.id, title: 'Zebra Crossing', coverKey: 'cover-zebra' });
    const token = newShareToken();
    await createShare(env.DB, { token, name: 'Our fiction', libraryId: shelf.id });
    const { status, text } = await publicPage(`/share/${token}`);
    expect(status).toBe(200);
    expect(text).toMatch(/<meta name="robots" content="noindex"\s*\/?>/);
    expect(tags(text)).toEqual({
      'og:type': 'website',
      'og:site_name': 'Nalanda',
      'og:title': 'Our fiction',
      'og:description': '3 items · a shared shelf from a Nalanda home library',
      'og:url': `http://nalanda.test/share/${token}`,
      // the first item in the page's order with a cover: Aardvark has none, so Piranesi's (sorted by title)
      'og:image': 'http://nalanda.test/covers/cover-piranesi',
      'og:image:alt': 'Cover of Our fiction',
      'twitter:card': 'summary',
    });
  });

  it('has no picture when nothing on it has a cover, and a tag’s link says it is a tag', async () => {
    const asha = await member('asha', 'admin');
    const shelf = await createLibrary(env.DB, 'Fiction');
    const b = await book(asha, { libraryId: shelf.id, title: 'Piranesi', coverKey: null });
    await setItemTags(env.DB, b.id, ['weird']);
    const token = newShareToken();
    await createShare(env.DB, { token, name: 'weird', libraryId: null, tag: 'weird' });
    const t = tags((await publicPage(`/share/${token}`)).text);
    expect(t['og:description']).toBe('1 item · a shared tag from a Nalanda home library');
    expect(t['og:image']).toBeUndefined();
    expect(t['og:image:alt']).toBeUndefined();
  });

  it('escapes a name and a title as any attribute is', async () => {
    const asha = await member('asha', 'admin');
    const shelf = await createLibrary(env.DB, 'Fiction');
    await book(asha, { libraryId: shelf.id, title: 'Say "hi" & <wave>' });
    const token = newShareToken();
    await createShare(env.DB, { token, name: '"Books" & <more>', libraryId: shelf.id });
    const { text } = await publicPage(`/share/${token}`);
    expect(text).toContain('<meta property="og:title" content="&quot;Books&quot; &amp; &lt;more&gt;"');
    expect(text).not.toContain('content=""Books"');
  });
});

describe('a shared item', () => {
  it('previews as its title, creators, type, where it is shown and its description — and nothing private', async () => {
    const asha = await member('asha', 'admin');
    const shelf = await createLibrary(env.DB, 'Fiction');
    const b = await book(asha, {
      libraryId: shelf.id,
      title: 'Piranesi',
      creators: 'Susanna Clarke',
      coverKey: 'cover-piranesi',
      description: 'A house with infinite halls.\n\nAnd the one who lives there.',
      notes: 'SECRET-NOTE',
      location: 'SECRET-PLACE',
      copies: 3,
      purchasePrice: 49900,
      purchaseCurrency: 'INR',
    });
    await createLoan(env.DB, { itemId: b.id, borrower: 'SECRET-BORROWER' });
    const token = newShareToken();
    await createShare(env.DB, { token, name: 'Our fiction', libraryId: shelf.id });
    const { text } = await publicPage(`/share/${token}/items/${b.id}`);
    const t = tags(text);
    expect(t['og:title']).toBe('Piranesi');
    expect(t['og:description']).toBe('Susanna Clarke · Book · on Our fiction — A house with infinite halls. And the one who lives there.');
    expect(t['og:image']).toBe('http://nalanda.test/covers/cover-piranesi');
    expect(t['og:image:alt']).toBe('Cover of Piranesi');
    expect(t['og:url']).toBe(`http://nalanda.test/share/${token}/items/${b.id}`);
    const head = text.slice(0, text.indexOf('<body>'));
    for (const leak of ['SECRET', '499', 'INR', 'asha', '3 cop']) expect(head).not.toContain(leak);
  });

  it('cuts a long description at a word', async () => {
    const asha = await member('asha', 'admin');
    const shelf = await createLibrary(env.DB, 'Fiction');
    const b = await book(asha, { libraryId: shelf.id, title: 'Long', creators: null, description: 'word '.repeat(100) });
    const token = newShareToken();
    await createShare(env.DB, { token, name: 'Shelf', libraryId: shelf.id });
    const d = tags((await publicPage(`/share/${token}/items/${b.id}`)).text)['og:description']!;
    expect(d.startsWith('Book · on Shelf — word word')).toBe(true);
    expect(d.endsWith('word…')).toBe(true);
    expect(d.length).toBeLessThan(170);
  });
});

describe('a gift list', () => {
  it('previews under the same title the page has: a display name only while names are on, never a username', async () => {
    const asha = await member('asha', 'admin');
    const ravi = await member('ravi');
    await setDisplayName(env.DB, ravi.id, 'Ravi K.');
    const shelf = await createLibrary(env.DB, 'Fiction');
    const b = await book(asha, { libraryId: shelf.id, title: 'Piranesi', creators: 'Susanna Clarke', coverKey: 'cover-piranesi', copies: 0 });
    await setWant(env.DB, b.id, ravi.id, true);
    const share = await giftList(ravi, asha);

    await upgradedSwitches(); // names off
    let t = tags((await publicPage(`/share/${share.token}`)).text);
    expect(t['og:title']).toBe('A want list');
    expect(t['og:description']).toBe('1 item · a want list shared from a Nalanda home library');
    expect(t['og:image']).toBe('http://nalanda.test/covers/cover-piranesi');
    let item = tags((await publicPage(`/share/${share.token}/items/${b.id}`)).text);
    expect(item['og:title']).toBe('Piranesi');
    expect(item['og:description']).toBe('Susanna Clarke · Book · on A want list');

    await updateSiteSettings(env.DB, { namesOnShares: true });
    t = tags((await publicPage(`/share/${share.token}`)).text);
    expect(t['og:title']).toBe('Ravi K.’s want list');
    item = tags((await publicPage(`/share/${share.token}/items/${b.id}`)).text);
    expect(item['og:description']).toBe('Susanna Clarke · Book · on Ravi K.’s want list');
    for (const html of [t, item]) expect(JSON.stringify(html)).not.toContain('ravi');
  });
});

describe('a link that resolves to nothing', () => {
  it('carries no preview at all', async () => {
    const { status, text } = await publicPage(`/share/${newShareToken()}`);
    expect(status).toBe(404);
    expect(tags(text)).toEqual({});
  });
});
