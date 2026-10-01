// Atom and RSS for share links (ARCH.md §16 #86): the newest additions among a link's items as a feed a reader can
// subscribe to — the same whitelist as the page (toPublicItem/toGiftItem), dated by when the item was added, never
// by a read. Pure functions: the route in src/routes/share.tsx gathers the entries, these write the XML.

/** How many entries a feed carries. */
export const FEED_ENTRIES = 20;

export type FeedEntry = {
  id: string; // the entry's permanent id — the item's share page address
  title: string;
  link: string; // the item's share page
  updated: string; // RFC 3339, UTC
  summary: string; // plain text: the creators and the household rating
  html: string; // the entry's content as HTML, already escaped
  image: string | null; // the cover's absolute address, for readers that show one
};

export type FeedMeta = {
  title: string;
  link: string; // the share page
  self: string; // this feed's own address
  updated: string; // RFC 3339
  description: string;
};

/** Text as XML character data — `&`, `<`, `>` and both quotes, so a title can say anything. */
export function xmlEscape(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

/** A stored time ("2026-10-01 11:28:05", the UTC D1 writes) or day ("2026-10-01") as RFC 3339 in UTC. */
export function rfc3339(at: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}:\d{2}))?/.exec(at);
  if (!m) return '1970-01-01T00:00:00Z';
  return `${m[1]}T${m[2] ?? '00:00:00'}Z`;
}

/** The same instant as RSS 2.0 wants it (RFC 822): "Thu, 01 Oct 2026 11:28:05 GMT". */
export function rfc822(at: string): string {
  const d = new Date(rfc3339(at));
  return Number.isNaN(d.getTime()) ? 'Thu, 01 Jan 1970 00:00:00 GMT' : d.toUTCString();
}

/** The entry's HTML, from already-safe parts: the cover, the creators, the household's rating and latest review. */
export function entryHtml(parts: { image: string | null; title: string; creators: string | null; rating: number | null; review: string | null }): string {
  const bits: string[] = [];
  if (parts.image) bits.push(`<p><img src="${xmlEscape(parts.image)}" alt="Cover of ${xmlEscape(parts.title)}"></p>`);
  if (parts.creators) bits.push(`<p>${xmlEscape(parts.creators)}</p>`);
  if (parts.rating !== null) bits.push(`<p>Rated ${parts.rating}/10</p>`);
  if (parts.review) bits.push(`<p>${xmlEscape(parts.review)}</p>`);
  return bits.join('');
}

export function atomFeed(meta: FeedMeta, entries: FeedEntry[]): string {
  const e = xmlEscape;
  return (
    `<?xml version="1.0" encoding="utf-8"?>\n` +
    `<feed xmlns="http://www.w3.org/2005/Atom">\n` +
    `  <title>${e(meta.title)}</title>\n` +
    `  <subtitle>${e(meta.description)}</subtitle>\n` +
    `  <link href="${e(meta.link)}"/>\n` +
    `  <link rel="self" type="application/atom+xml" href="${e(meta.self)}"/>\n` +
    `  <id>${e(meta.link)}</id>\n` +
    `  <updated>${e(meta.updated)}</updated>\n` +
    `  <generator>Nalanda</generator>\n` +
    entries
      .map(
        (x) =>
          `  <entry>\n` +
          `    <title>${e(x.title)}</title>\n` +
          `    <link href="${e(x.link)}"/>\n` +
          `    <id>${e(x.id)}</id>\n` +
          `    <updated>${e(x.updated)}</updated>\n` +
          `    <summary>${e(x.summary)}</summary>\n` +
          `    <content type="html">${e(x.html)}</content>\n` +
          `  </entry>\n`,
      )
      .join('') +
    `</feed>\n`
  );
}

export function rssFeed(meta: FeedMeta, entries: FeedEntry[]): string {
  const e = xmlEscape;
  return (
    `<?xml version="1.0" encoding="utf-8"?>\n` +
    `<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">\n` +
    `  <channel>\n` +
    `    <title>${e(meta.title)}</title>\n` +
    `    <link>${e(meta.link)}</link>\n` +
    `    <description>${e(meta.description)}</description>\n` +
    `    <atom:link href="${e(meta.self)}" rel="self" type="application/rss+xml"/>\n` +
    `    <lastBuildDate>${rfc822(meta.updated)}</lastBuildDate>\n` +
    `    <generator>Nalanda</generator>\n` +
    entries
      .map(
        (x) =>
          `    <item>\n` +
          `      <title>${e(x.title)}</title>\n` +
          `      <link>${e(x.link)}</link>\n` +
          `      <guid isPermaLink="true">${e(x.id)}</guid>\n` +
          `      <pubDate>${rfc822(x.updated)}</pubDate>\n` +
          `      <description>${e(x.html || x.summary)}</description>\n` +
          `    </item>\n`,
      )
      .join('') +
    `  </channel>\n` +
    `</rss>\n`
  );
}
