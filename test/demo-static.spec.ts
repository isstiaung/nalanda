// The static demo's pure parts (ARCH.md §16 #89): where an address lands as a file, how links are pointed there, what
// the crawl never follows, and what every page gets and loses. The crawl itself (scripts/demo-build.mjs) runs a
// scratch wrangler dev and is exercised by the Demo workflow, not here.
import { describe, expect, it } from 'vitest';
import { addressesIn, bannerHtml, CANNED_SEARCHES, crawlable, DEMO_PASSWORD, DEMO_USER, fileFor, hrefFor, inject, isAsset, LOGIN_NOTE, rewriteLinks } from '../scripts/demo-static.mjs';

describe('where an address lands', () => {
  it('puts the home under home/, a page under its path, a filtered page under q/, and keeps a file where it is', () => {
    expect(fileFor('/')).toBe('home/index.html');
    expect(fileFor('/libraries/3')).toBe('libraries/3/index.html');
    expect(fileFor('/libraries/3?sort=title&view=grid')).toBe('libraries/3/q/sort=title&view=grid.html');
    expect(fileFor('/search?q=le+guin')).toBe('search/q/q=le+guin.html');
    expect(fileFor('/search?q=a%20b%2F"c')).toBe('search/q/q=a_b_c.html'); // nothing a file name can't take
    expect(fileFor('/app.css')).toBe('app.css');
    expect(fileFor('/covers/0b1c2d3e')).toBe('covers/0b1c2d3e');
    expect(fileFor('/share/abc/feed.atom')).toBe('share/abc/feed.atom');
    expect(fileFor('/vendor/fonts/eczar-latin-600-normal.woff2')).toBe('vendor/fonts/eczar-latin-600-normal.woff2');
  });

  it('links to a page as a directory under the base, to a file as itself', () => {
    expect(hrefFor('/', '/nalanda')).toBe('/nalanda/home/');
    expect(hrefFor('/items/12', '/nalanda')).toBe('/nalanda/items/12/');
    expect(hrefFor('/libraries/3?sort=title', '/nalanda')).toBe('/nalanda/libraries/3/q/sort=title.html');
    expect(hrefFor('/app.css', '/nalanda')).toBe('/nalanda/app.css');
    expect(hrefFor('/items/12')).toBe('/items/12/');
  });

  it('tells an asset from a page', () => {
    for (const a of ['/app.css', '/app.js', '/logo.svg', '/vendor/htmx.min.js', '/covers/abc', '/icons/icon-192.png', '/bgg/powered-by-bgg.svg', '/share/t/feed.rss']) expect(isAsset(a), a).toBe(true);
    for (const p of ['/', '/libraries/3', '/items/12', '/search', '/share/t', '/account']) expect(isAsset(p), p).toBe(false);
  });
});

describe('what the crawl follows', () => {
  it('never a write, a sign-out, the export, the API, the app files, a token page, or a page past the first', () => {
    for (const no of ['/auth/logout', '/login', '/setup', '/export.csv?after=0', '/api/v1/me', '/api/lookup?q=x', '/federation/export.json', '/sw.js', '/manifest.webmanifest', '/offline.html', '/account/tokens', '/libraries/3?page=2', '/export.csv', '//evil.example/x', 'https://x.example/', '/items/1#reads']) {
      expect(crawlable(no), no).toBe(false);
    }
    for (const yes of ['/', '/libraries/3', '/libraries/3?sort=title', '/items/12', '/search?q=le+guin', '/share/abc', '/account', '/tags', '/covers/abc', '/app.css']) expect(crawlable(yes), yes).toBe(true);
  });

  it('reads every same-origin address a page refers to, once, in order, without fragments', () => {
    const html = '<a href="/libraries/3">a</a><form action="/libraries/3?sort=title&amp;view=grid"></form><img src="/covers/k"><a href="/items/1#reads">b</a><a href="/items/1">c</a><a href="https://x.example/">no</a><script src="/app.js"></script><a href="//x.example/no">no</a>';
    expect(addressesIn(html)).toEqual(['/libraries/3', '/libraries/3?sort=title&view=grid', '/covers/k', '/items/1', '/app.js']);
  });
});

describe('what a page becomes', () => {
  it('points every link, form, image and script at its file under the base, keeping fragments and leaving other origins alone', () => {
    const html = '<a href="/">home</a> <a href="/libraries/3?sort=title&amp;view=grid#top">shelf</a> <form action="/search"><input name="q"></form> <img src="/covers/k"> <script src="/app.js"></script> <a href="https://x.example/p">x</a> <a href="//cdn.example/y">y</a>';
    expect(rewriteLinks(html, '/nalanda')).toBe(
      '<a href="/nalanda/home/">home</a> <a href="/nalanda/libraries/3/q/sort=title&amp;view=grid.html#top">shelf</a> <form action="/nalanda/search/"><input name="q"></form> <img src="/nalanda/covers/k"> <script src="/nalanda/app.js"></script> <a href="https://x.example/p">x</a> <a href="//cdn.example/y">y</a>',
    );
  });

  it('loses the manifest, the app metas and htmx, gains the demo stylesheet, pages and script in the head, and the banner first in the body', () => {
    const html = '<!doctype html><html><head><meta charset="utf-8"/><link rel="manifest" href="/manifest.webmanifest"/><link rel="apple-touch-icon" href="/icons/x.png"/><meta name="mobile-web-app-capable" content="yes"/><meta name="apple-mobile-web-app-capable" content="yes"/><script src="/vendor/htmx.min.js" defer=""></script><script src="/app.js" defer=""></script></head><body data-scan-owner="abc"><a href="#main">skip</a></body></html>';
    const out = inject(rewriteLinks(html, '/nalanda'), { base: '/nalanda', banner: bannerHtml('/nalanda') });
    expect(out).not.toContain('manifest');
    expect(out).not.toContain('apple-touch-icon');
    expect(out).not.toContain('mobile-web-app-capable');
    expect(out).not.toContain('htmx');
    expect(out).toContain('<script src="/nalanda/app.js" defer=""></script>');
    expect(out).toContain('<link rel="stylesheet" href="/nalanda/demo.css"><script src="/nalanda/demo-pages.js"></script><script src="/nalanda/demo.js" defer></script></head>');
    expect(out).toContain('<body data-scan-owner="abc"><div class="demo-banner" role="note">');
    expect(out).toContain('<a href="/nalanda/">Sign out</a>');
    expect(bannerHtml('')).toContain('<a href="/">Sign out</a>');
  });

  it('says what the sign-in takes and what it is not, and names the canned searches', () => {
    expect(DEMO_USER).toBe('demo');
    expect(DEMO_PASSWORD).toBe('demo');
    expect(LOGIN_NOTE).toContain('<strong>demo</strong> / <strong>demo</strong>');
    expect(LOGIN_NOTE).toContain('not security');
    expect(CANNED_SEARCHES).toContain('le guin');
    expect(CANNED_SEARCHES.every((q) => fileFor(`/search?q=${encodeURIComponent(q).replace(/%20/g, '+')}`).startsWith('search/q/q='))).toBe(true);
  });
});
