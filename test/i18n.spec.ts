// The interface language (ARCH.md §16 #93): one strings table, English the source, Hindi and Tamil machine-drafted
// and marked so; the interface follows the household's default language where a translation is shipped, a member's
// own choice over it; share pages carry the household's. The strings download for translators, and an admin's
// import of the household's own translation, which overrides the shipped one key by key.
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createLibrary, createShare, getTranslation, updateSiteSettings } from '../src/db/queries';
import type { Bindings } from '../src/env';
import { budgeted } from '../src/federation/budget';
import { en, type StringKey } from '../src/i18n/strings';
import { hi } from '../src/i18n/hi';
import { ta } from '../src/i18n/ta';
import { DRAFT_LOCALES, KEYS, locales, MAX_TRANSLATION_BYTES, n, parseTranslation, resolveLocale, stringsFor, t } from '../src/i18n';
import { newShareToken } from '../src/lib/share';
import app from '../src/index';
import { clearSharePageCache } from '../src/routes/share';
import { as, book, html, member, rows, type Member } from './member-helpers';

const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe('the strings table', () => {
  it('ships Hindi and Tamil as full drafts: every English key, the same placeholders, no markup', () => {
    expect(locales).toEqual(['en', 'hi', 'ta']);
    expect(DRAFT_LOCALES).toEqual(['hi', 'ta']);
    expect(KEYS.length).toBeGreaterThan(300);
    for (const pack of [hi, ta]) {
      expect(pack.draft).toBe(true);
      expect(Object.keys(pack.strings).sort()).toEqual([...KEYS].sort());
      for (const key of KEYS) {
        const text = pack.strings[key];
        expect(text, key).toBeTruthy();
        expect(placeholders(text), key).toEqual(placeholders(en[key]));
      }
    }
    for (const pack of [en, hi.strings, ta.strings]) {
      for (const key of KEYS) expect(pack[key], key).not.toMatch(/[<>]/);
    }
    // a count's two forms always come as a pair (the type PluralKey holds the other direction)
    for (const key of KEYS) if (key.endsWith('_other')) expect(KEYS, key).toContain(`${key.slice(0, -6)}_one`);
  });

  it('t() fills placeholders, falls back to English, and takes the household’s override first', () => {
    expect(t('en', 'nav.unread_count', { count: 3 })).toBe('3 unread');
    expect(t('en', 'nav.unread_count')).toBe('{count} unread'); // a placeholder with no value stays visible
    expect(t('hi', 'nav.overview')).toBe('अवलोकन');
    expect(t('ta', 'nav.overview')).toBe('மேலோட்டம்');
    expect(t('xx', 'nav.overview')).toBe('Overview'); // not a shipped locale: English
    expect(t('hi', 'nav.overview', undefined, { 'nav.overview': 'सिंहावलोकन' })).toBe('सिंहावलोकन');
    expect(t('hi', 'nav.overview', undefined, { 'nav.overview': '' })).toBe('अवलोकन'); // an empty override is none
    expect(t('hi', 'nav.add', undefined, { 'nav.overview': 'x' })).toBe('आइटम जोड़ें'); // other keys unaffected
    expect(n('en', 'share.items', 1)).toBe('1 item');
    expect(n('en', 'share.items', 2)).toBe('2 items');
    expect(n('hi', 'media.book_count', 2)).toBe('2 किताबें');
    const merged = stringsFor('ta', { 'nav.overview': 'முகப்பு' });
    expect(merged['nav.overview']).toBe('முகப்பு');
    expect(merged['nav.add']).toBe(ta.strings['nav.add']);
    expect(Object.keys(merged).length).toBe(KEYS.length);
  });

  it('parseTranslation keeps known keys with text and counts the rest as ignored', () => {
    expect(parseTranslation(null)).toBeNull();
    expect(parseTranslation(['nav.overview'])).toBeNull();
    expect(parseTranslation('text')).toBeNull();
    const parsed = parseTranslation({ 'nav.overview': 'Home', 'nav.add': '', 'not.a.key': 'x', 'nav.search': 3, 'nav.tags': 'x'.repeat(3000) });
    expect(parsed).toEqual({ strings: { 'nav.overview': 'Home' }, kept: 1, ignored: 4 });
  });

  it('resolveLocale: the member’s shipped choice, else the household’s where shipped, else English', () => {
    expect(resolveLocale(null, { language: 'en' })).toBe('en');
    expect(resolveLocale(null, { language: 'hi' })).toBe('hi');
    expect(resolveLocale(null, { language: 'fr' })).toBe('en');
    expect(resolveLocale({ locale: 'ta' }, { language: 'hi' })).toBe('ta');
    expect(resolveLocale({ locale: 'xx' }, { language: 'hi' })).toBe('hi');
    expect(resolveLocale({ locale: null }, { language: 'ta' })).toBe('ta');
  });
});

const lang = (page: string) => page.match(/<html lang="([a-z]+)">/)?.[1];

describe('the display faces', () => {
  it('serves Eczar’s Devanagari and Tiro Tamil beside the Latin Eczar, each declared for its own range only', async () => {
    // vendored by scripts/vendor.mjs, served as static files (the test-only ASSETS binding, as the service worker's spec reads them)
    for (const path of [
      '/vendor/fonts/eczar-latin-600-normal.woff2',
      '/vendor/fonts/eczar-devanagari-600-normal.woff2',
      '/vendor/fonts/eczar-devanagari-700-normal.woff2',
      '/vendor/fonts/tiro-tamil-tamil-400-normal.woff2',
      '/vendor/fonts/eczar.LICENSE.txt',
      '/vendor/fonts/tiro-tamil.LICENSE.txt',
    ]) {
      const res = await env.ASSETS.fetch(`http://nalanda.test${path}`, { redirect: 'manual' });
      expect(res.status, path).toBe(200);
      expect((await res.arrayBuffer()).byteLength, path).toBeGreaterThan(100);
    }
    const css = await (await env.ASSETS.fetch('http://nalanda.test/app.css')).text();
    // the Latin faces take every title; the Devanagari faces, declared after them, take Devanagari's own range
    expect(css).toMatch(/font-family: 'Eczar';[^}]*eczar-latin-600-normal\.woff2[^}]*\}/);
    expect(css).not.toMatch(/font-family: 'Eczar';[^}]*eczar-latin-600-normal\.woff2[^}]*unicode-range/);
    expect(css).toMatch(/font-family: 'Eczar';[^}]*font-weight: 600;[^}]*eczar-devanagari-600-normal\.woff2[^}]*unicode-range: U\+0900-097F, U\+1CD0-1CF9/);
    expect(css).toMatch(/font-family: 'Eczar';[^}]*font-weight: 700;[^}]*eczar-devanagari-700-normal\.woff2[^}]*unicode-range: U\+0900-097F/);
    expect(css.indexOf('eczar-latin-700-normal')).toBeLessThan(css.indexOf('eczar-devanagari-600-normal'));
    // Tiro Tamil: Tamil's range alone, so a Latin heading never falls to it, and never its Latin subsets
    expect(css).toMatch(/font-family: 'Tiro Tamil';[^}]*tiro-tamil-tamil-400-normal\.woff2[^}]*unicode-range: U\+0964-0965, U\+0B82-0BFA/);
    expect(css).not.toContain('tiro-tamil-latin');
    expect(css).toContain("--serif: 'Eczar', 'Tiro Tamil', ");
    // the brand's नालन्दा sets in Eczar now
    expect(css).toMatch(/\.brand-deva \{ font-family: var\(--serif\);/);
  });
});

async function calls(who: Member, path: string): Promise<number> {
  const budget = { left: 1000 };
  const ctx = createExecutionContext();
  const res = await app.fetch(new Request(`http://nalanda.test${path}`, { headers: { cookie: who.cookie } }), { ...env, DB: budgeted(env.DB, budget) } as Bindings, ctx);
  await waitOnExecutionContext(ctx);
  expect(res.status, path).toBe(200);
  await res.text();
  return 1000 - budget.left;
}

describe('the interface language', () => {
  it('is English until the household picks a shipped language, and a member’s own choice comes first', async () => {
    const asha = await member('asha', 'admin');
    let page = await html(asha, '/');
    expect(lang(page)).toBe('en');
    expect(page).toContain('<h1>Overview</h1>');
    expect(page).toContain('Skip to content');

    await updateSiteSettings(env.DB, { language: 'ta' });
    page = await html(asha, '/');
    expect(lang(page)).toBe('ta');
    expect(page).toContain('<h1>மேலோட்டம்</h1>');
    expect(page).toContain('உள்ளடக்கத்திற்குச் செல்'); // the skip link
    expect(page).toContain('<title>மேலோட்டம் · Nalanda</title>');

    await updateSiteSettings(env.DB, { language: 'fr' }); // every item takes French; the interface has no French yet
    page = await html(asha, '/');
    expect(lang(page)).toBe('en');
    expect(page).toContain('<h1>Overview</h1>');

    // the member's own choice, from Account
    expect((await as(asha, '/account/locale', { body: { locale: 'hi' } })).headers.get('location')).toBe('/account?language=saved#language');
    expect((await rows<{ locale: string | null }>('SELECT locale FROM users WHERE id = ?1', asha.id))[0]!.locale).toBe('hi');
    page = await html(asha, '/');
    expect(lang(page)).toBe('hi');
    expect(page).toContain('<h1>अवलोकन</h1>');
    expect(page).toContain('<span>आइटम जोड़ें</span>'); // the sidebar
    // another member is untouched by it
    const ravi = await member('ravi');
    expect(lang(await html(ravi, '/'))).toBe('en');
    // back to the household's
    expect((await as(asha, '/account/locale', { body: { locale: '' } })).status).toBe(302);
    expect((await rows<{ locale: string | null }>('SELECT locale FROM users WHERE id = ?1', asha.id))[0]!.locale).toBeNull();
    expect(lang(await html(asha, '/'))).toBe('en');
    expect((await as(asha, '/account/locale', { body: { locale: 'xx' } })).status).toBe(400);
    expect((await as(asha, '/account/locale', { body: { locale: 'de' } })).status).toBe(400); // a language, not a shipped locale
  });

  it('costs a translated page no D1 call more than an English one', async () => {
    const asha = await member('asha', 'admin');
    const shelf = await createLibrary(env.DB, 'Books');
    await book(asha, { libraryId: shelf.id });
    const english = { overview: await calls(asha, '/'), shelf: await calls(asha, `/libraries/${shelf.id}`), account: await calls(asha, '/account') };
    expect(english.account).toBe(3); // the session, the sidebar's shelves, the row with its tokens (test/api-tokens.spec.ts)
    await updateSiteSettings(env.DB, { language: 'hi' });
    await as(asha, '/settings/translations', { json: { locale: 'hi', strings: { 'overview.title': 'घर' } } });
    expect(await calls(asha, '/')).toBe(english.overview);
    expect(await calls(asha, `/libraries/${shelf.id}`)).toBe(english.shelf);
    expect(await calls(asha, '/account')).toBe(english.account);
    expect(await html(asha, '/')).toContain('<h1>घर</h1>'); // and the translation did apply
  });

  it('the Account page offers the choice, labelled, with the drafts marked and the strings to download', async () => {
    const asha = await member('asha', 'admin');
    const page = await html(asha, '/account');
    expect(page).toContain('<label for="account-locale">Interface language</label>');
    expect(page).toContain('<select id="account-locale" name="locale" aria-describedby="language-help">');
    expect(page).toContain('<option value="" selected="">Household default (English)</option>');
    expect(page).toContain('<option value="hi">हिन्दी (machine-drafted)</option>');
    expect(page).toContain('<option value="ta">தமிழ் (machine-drafted)</option>');
    expect(page).toContain('<option value="en">English</option>');
    expect(page).toContain('href="/strings/hi.json"');
    expect(page).toContain('href="/strings/ta.json"');
    await updateSiteSettings(env.DB, { language: 'ta' });
    expect(await html(asha, '/account')).toContain('வீட்டின் இயல்பு (தமிழ்)');
  });

  it('htmx partials come back in the member’s language too', async () => {
    const asha = await member('asha', 'admin');
    const shelf = await createLibrary(env.DB, 'Books');
    const b = await book(asha, { libraryId: shelf.id, copies: 0 });
    await as(asha, '/account/locale', { body: { locale: 'hi' } });
    const swapped = await (await as(asha, `/items/${b.id}/mark-owned`, { body: {}, htmx: true })).text();
    expect(swapped).toContain('>अपने पास</button>');
    expect(swapped).not.toContain('<html');
  });

  it('share pages carry the household’s language, never a member’s, with their own strings translated', async () => {
    const asha = await member('asha', 'admin');
    const shelf = await createLibrary(env.DB, 'Books');
    const b = await book(asha, { libraryId: shelf.id, copies: 0 });
    const share = await createShare(env.DB, { token: newShareToken(), name: 'Ours', libraryId: shelf.id });
    await as(asha, '/account/locale', { body: { locale: 'hi' } });
    clearSharePageCache();
    let page = await (await as(null, `/share/${share.token}`)).text();
    expect(lang(page)).toBe('en');
    expect(page).toContain('Shared read-only from a Nalanda home library');
    expect(page).toContain('<span class="pill ghost">Not owned</span>');

    await updateSiteSettings(env.DB, { language: 'ta' });
    clearSharePageCache();
    page = await (await as(null, `/share/${share.token}`)).text();
    expect(lang(page)).toBe('ta'); // the household's, though asha reads the app in Hindi
    expect(page).toContain('<div class="share-mark">நாளந்தா · பகிர்ந்த அலமாரி</div>');
    expect(page).toContain('<span class="pill ghost">கைவசம் இல்லை</span>');
    expect(page).toContain('The Dispossessed'); // item data as it is
    const item = await (await as(null, `/share/${share.token}/items/${b.id}`)).text();
    expect(lang(item)).toBe('ta');
    expect(item).toContain('<dt>வகை</dt>');
    expect(item).toContain('← Oursக்குத் திரும்பு');
    const feed = await (await as(null, `/share/${share.token}/feed.atom`)).text();
    expect(feed).toContain('ஒரு நாளந்தா வீட்டு நூலகத்திலிருந்து பகிரப்பட்டது');
    // the login page too: nobody is signed in, so the household's
    expect(lang(await (await as(null, '/login')).text())).toBe('ta');
    expect(await (await as(null, '/login')).text()).toContain('<h1>உள்நுழை</h1>');
  });

  it('serves the strings as JSON to a signed-in member, English for a locale that isn’t shipped', async () => {
    expect((await as(null, '/strings/hi.json')).status).toBe(302); // to log in
    const ravi = await member('ravi');
    const res = await as(ravi, '/strings/hi.json');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(res.headers.get('content-disposition')).toContain('nalanda-strings-hi.json');
    const got = (await res.json()) as Record<string, string>;
    expect(Object.keys(got).sort()).toEqual([...KEYS].sort());
    expect(got['nav.overview']).toBe('अवलोकन');
    const unknown = (await (await as(ravi, '/strings/xx.json')).json()) as Record<string, string>;
    expect(unknown['nav.overview']).toBe('Overview');
    expect((await as(ravi, '/strings/evil')).status).toBe(404);
    expect((await as(ravi, '/strings/../x.json')).status).not.toBe(200);
  });

  it('an admin imports the household’s own translation, which wins over the shipped one key by key', async () => {
    const asha = await member('asha', 'admin');
    const ravi = await member('ravi');
    await updateSiteSettings(env.DB, { language: 'hi' });
    // a member can't
    expect((await as(ravi, '/settings/translations', { json: { locale: 'hi', strings: { 'nav.overview': 'x' } } })).status).toBe(403);
    // too big
    const big = await as(asha, '/settings/translations', { json: { locale: 'hi', strings: { _pad: 'x'.repeat(MAX_TRANSLATION_BYTES) } } });
    expect(big.status).toBe(413);
    // not JSON
    const ctx = createExecutionContext();
    const bad = await app.fetch(
      new Request('http://nalanda.test/settings/translations', {
        method: 'POST',
        headers: { cookie: asha.cookie, origin: 'http://nalanda.test', 'content-type': 'application/json' },
        body: '{not json',
      }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(bad.status).toBe(400);
    // not a shipped locale, not an object
    expect((await as(asha, '/settings/translations', { json: { locale: 'fr', strings: { 'nav.overview': 'Accueil' } } })).status).toBe(400);
    expect((await as(asha, '/settings/translations', { json: { locale: 'hi', strings: ['nav.overview'] } } )).status).toBe(400);
    expect(await getTranslation(env.DB, 'hi')).toBeNull();

    // the import: known keys kept, the rest ignored and counted
    const ok = await as(asha, '/settings/translations', {
      json: { locale: 'hi', strings: { 'overview.title': 'घर', 'pill.not_owned': 'पास नहीं', 'made.up': 'x', 'nav.add': 42, '<b>': 'no' } },
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ locale: 'hi', kept: 2, ignored: 3 });
    expect(await getTranslation(env.DB, 'hi')).toEqual({ 'overview.title': 'घर', 'pill.not_owned': 'पास नहीं' });

    // it wins on the pages, for everyone, escaped
    const shelf = await createLibrary(env.DB, 'Books');
    const b = await book(asha, { libraryId: shelf.id, copies: 0 });
    expect(await html(ravi, '/')).toContain('<h1>घर</h1>');
    expect(await html(ravi, `/items/${b.id}`)).toContain('>पास नहीं</button>');
    expect(await html(ravi, '/account')).toContain('<option value="" selected="">घर की डिफ़ॉल्ट (हिन्दी)</option>');
    // and on a share page: the household's own words for its own strings
    const share = await createShare(env.DB, { token: newShareToken(), name: 'Ours', libraryId: shelf.id });
    clearSharePageCache();
    expect(await (await as(null, `/share/${share.token}`)).text()).toContain('<span class="pill ghost">पास नहीं</span>');
    // the download merges it
    expect(((await (await as(ravi, '/strings/hi.json')).json()) as Record<string, string>)['overview.title']).toBe('घर');
    // a string with markup is text on the page
    await as(asha, '/settings/translations', { json: { locale: 'hi', strings: { 'overview.title': '<img src=x onerror=alert(1)>' } } });
    const page = await html(ravi, '/');
    expect(page).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(page).not.toContain('<img src=x');
    // a re-import replaces the whole file: pill.not_owned is back to the shipped draft
    expect(page).toContain('अपने पास नहीं');

    // Members lists it, and Remove clears it
    const members = await html(asha, '/settings/users');
    expect(members).toContain('हिन्दी: 1 स्ट्रिंग');
    expect(members).toContain('action="/settings/translations/hi/delete"');
    expect(members).toContain('src="/translations.js"');
    expect((await as(asha, '/settings/translations/hi/delete', { body: {} })).headers.get('location')).toBe('/settings/users#translations');
    expect(await getTranslation(env.DB, 'hi')).toBeNull();
    expect(await html(ravi, '/')).toContain('<h1>अवलोकन</h1>');
  });

  it('Members says which interface language the household’s choice gives', async () => {
    const asha = await member('asha', 'admin');
    expect(await html(asha, '/settings/users')).toContain('The interface follows it: English, unless a member picks another under Account.');
    await updateSiteSettings(env.DB, { language: 'fr' });
    expect(await html(asha, '/settings/users')).toContain('There is no French interface yet, so the interface stays in English');
    await updateSiteSettings(env.DB, { language: 'ta' });
    const page = await html(asha, '/settings/users');
    expect(lang(page)).toBe('ta');
    expect(page).toContain('இடைமுகம் இதைப் பின்பற்றும்: தமிழ்');
    expect(page).toContain('<label for="translation-locale">'); // the import form, labelled
    expect(page).toContain('<label for="translation-file">');
  });
});
