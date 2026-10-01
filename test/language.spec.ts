// Language and original title (ARCH.md §16 #76): a household default any ISO 639-1 language, every added item takes
// it unless told otherwise, editable any time; an original title in any script, searchable as written; both public
// like the publisher.
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createLibrary, createShare, getItem, getSiteSettings, updateSiteSettings } from '../src/db/queries';
import { mapNalandaRow } from '../src/lib/csv';
import { DEFAULT_LANGUAGE, isLanguageCode, LANGUAGES, languageFromProvider, languageName } from '../src/lib/language';
import { newShareToken, toPublicItem } from '../src/lib/share';
import { clearSharePageCache } from '../src/routes/share';
import { as, book, html, member } from './member-helpers';

describe('the language library', () => {
  it('knows every ISO 639-1 code, by name, and maps what providers and files say', () => {
    expect(LANGUAGES.length).toBeGreaterThan(180);
    expect(isLanguageCode('ta')).toBe(true);
    expect(isLanguageCode('tam')).toBe(false);
    expect(isLanguageCode('')).toBe(false);
    expect(languageName('ta')).toBe('Tamil');
    expect(languageName('xx')).toBe('xx');
    expect(DEFAULT_LANGUAGE).toBe('en');
    expect(languageFromProvider('en')).toBe('en');
    expect(languageFromProvider('en-US')).toBe('en');
    expect(languageFromProvider('eng')).toBe('en'); // Open Library, ISO 639-2
    expect(languageFromProvider('tam')).toBe('ta');
    expect(languageFromProvider('fre')).toBe('fr'); // the bibliographic code
    expect(languageFromProvider('fra')).toBe('fr'); // and the terminologic one
    expect(languageFromProvider('Tamil')).toBe('ta'); // a file that names it
    expect(languageFromProvider('Klingon')).toBeNull();
    expect(languageFromProvider('')).toBeNull();
    expect(languageFromProvider(undefined)).toBeNull();
  });
});

const form = (shelf: number, extra: Record<string, string>) => ({ title: 'Kadal', libraryId: String(shelf), mediaType: 'book', ...extra });

describe('the household default', () => {
  it('starts as English, is set by an admin from the list, and every added item takes it unless the form says', async () => {
    const asha = await member('asha', 'admin');
    const shelf = await createLibrary(env.DB, 'Fiction');
    expect((await getSiteSettings(env.DB)).language).toBe('en');
    const page = await html(asha, '/settings/users');
    expect(page).toContain('id="language"');
    expect(page).toContain('<option value="en" selected="">English</option>');

    const first = await as(asha, '/items', { body: form(shelf.id, {}) });
    const firstId = Number(first.headers.get('location')!.match(/\/items\/(\d+)/)![1]);
    expect((await getItem(env.DB, firstId))!.language).toBe('en');

    expect((await as(asha, '/settings/language', { body: { language: 'ta' } })).status).toBe(302);
    expect((await getSiteSettings(env.DB)).language).toBe('ta');
    expect((await as(asha, '/settings/language', { body: { language: 'tam' } })).status).toBe(400);
    expect((await getSiteSettings(env.DB)).language).toBe('ta');

    const second = await as(asha, '/items', { body: form(shelf.id, { title: 'Ponniyin Selvan' }) });
    const secondId = Number(second.headers.get('location')!.match(/\/items\/(\d+)/)![1]);
    expect((await getItem(env.DB, secondId))!.language).toBe('ta');
    expect((await getItem(env.DB, firstId))!.language).toBe('en'); // changing the default changes nothing added already

    const third = await as(asha, '/items', { body: form(shelf.id, { title: 'Le Petit Prince', language: 'fr', originalTitle: 'Le Petit Prince' }) });
    const thirdId = Number(third.headers.get('location')!.match(/\/items\/(\d+)/)![1]);
    expect((await getItem(env.DB, thirdId))!).toMatchObject({ language: 'fr', originalTitle: 'Le Petit Prince' });
    // the provider's hidden field, through the same name
    const fourth = await as(asha, '/items', { body: form(shelf.id, { title: 'From a provider', language: 'hi' }) });
    expect((await getItem(env.DB, Number(fourth.headers.get('location')!.match(/\/items\/(\d+)/)![1])))!.language).toBe('hi');
  });

  it('a member edits an item’s language and original title any time; a form without a code of ours keeps the item’s', async () => {
    const asha = await member('asha', 'admin');
    const ravi = await member('ravi');
    const shelf = await createLibrary(env.DB, 'Fiction');
    const b = await book(asha, { libraryId: shelf.id, title: 'Kadal', language: 'en' });
    expect((await as(ravi, `/items/${b.id}`, { body: form(shelf.id, { language: 'ta', originalTitle: 'கடல்' }) })).status).toBe(302);
    expect((await getItem(env.DB, b.id))!).toMatchObject({ language: 'ta', originalTitle: 'கடல்' });
    await as(ravi, `/items/${b.id}`, { body: form(shelf.id, { language: 'nonsense', originalTitle: '' }) });
    expect((await getItem(env.DB, b.id))!).toMatchObject({ language: 'ta', originalTitle: null });
    const edit = await html(ravi, `/items/${b.id}/edit`);
    expect(edit).toContain('<option value="ta" selected="">Tamil</option>');
    // an item from before the column reads as the household's on its form
    await env.DB.prepare('UPDATE items SET language = NULL WHERE id = ?1').bind(b.id).run();
    expect(await html(ravi, `/items/${b.id}/edit`)).toContain('<option value="en" selected="">English</option>');
  });
});

describe('on the pages', () => {
  it('shows the original title under the title, and a language pill only when it differs from the household’s', async () => {
    const asha = await member('asha', 'admin');
    const shelf = await createLibrary(env.DB, 'Fiction');
    const ta = await book(asha, { libraryId: shelf.id, title: 'Kadal', language: 'ta', originalTitle: 'கடல்' });
    const en = await book(asha, { libraryId: shelf.id, title: 'Piranesi', language: 'en' });
    const taPage = await html(asha, `/items/${ta.id}`);
    expect(taPage).toContain('<p class="original-title muted">கடல்</p>');
    expect(taPage).toContain('<span class="pill language">Tamil</span>');
    expect(await html(asha, `/items/${en.id}`)).not.toContain('pill language');
    await updateSiteSettings(env.DB, { language: 'ta' });
    expect(await html(asha, `/items/${ta.id}`)).not.toContain('pill language');
    expect(await html(asha, `/items/${en.id}`)).toContain('<span class="pill language">English</span>');
  });

  it('finds an original title as written, and not transliterated', async () => {
    const asha = await member('asha', 'admin');
    const shelf = await createLibrary(env.DB, 'Fiction');
    await book(asha, { libraryId: shelf.id, title: 'The Sea', language: 'ta', originalTitle: 'கடல்' });
    expect(await html(asha, '/search?q=%E0%AE%95%E0%AE%9F%E0%AE%B2%E0%AF%8D')).toContain('The Sea'); // கடல்
    expect(await html(asha, '/search?q=kadal')).not.toContain('The Sea');
  });

  it('publishes both, like the publisher', async () => {
    const asha = await member('asha', 'admin');
    const shelf = await createLibrary(env.DB, 'Fiction');
    const b = await book(asha, { libraryId: shelf.id, title: 'Kadal', language: 'ta', originalTitle: 'கடல்' });
    const pub = toPublicItem((await getItem(env.DB, b.id))!);
    expect(pub.language).toBe('ta');
    expect(pub.originalTitle).toBe('கடல்');
    const token = newShareToken();
    await createShare(env.DB, { token, name: 'Shelf', libraryId: shelf.id });
    clearSharePageCache();
    const text = await (await as(null, `/share/${token}/items/${b.id}`)).text();
    expect(text).toContain('<p class="original-title muted">கடல்</p>');
    expect(text).toContain('<dt>Language</dt><dd>Tamil</dd>');
  });

  it('round-trips through the CSV, with a blank language reading as the household’s', async () => {
    const asha = await member('asha', 'admin');
    const shelf = await createLibrary(env.DB, 'Fiction');
    await book(asha, { libraryId: shelf.id, title: 'Kadal', language: 'ta', originalTitle: 'கடல்' });
    const csv = await (await as(asha, '/export.csv')).text();
    const header = csv.split('\n')[0]!;
    expect(header).toContain('language');
    expect(header).toContain('original_title');
    expect(csv).toContain(',ta,கடல்,');
    const mapped = mapNalandaRow({ title: 'X', media_type: 'book', language: 'fr', original_title: 'Y' }, null, 'ta');
    expect(mapped?.item).toMatchObject({ language: 'fr', originalTitle: 'Y' });
    expect(mapNalandaRow({ title: 'X', media_type: 'book', language: '', original_title: '' }, null, 'ta')?.item).toMatchObject({ language: 'ta', originalTitle: null });
    expect(mapNalandaRow({ title: 'X', media_type: 'book', language: 'English' }, null, 'ta')?.item.language).toBe('en');
  });
});
