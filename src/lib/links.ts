// Purchase links (ARCH.md §16 #53): a label and a URL someone pasted — never generated — shared by the household,
// public only on a want-list share (a gift list). Every URL is checked here, on the way in from a form and from an
// import alike, so nothing but an absolute http(s) address is ever stored, rendered or published.

export const MAX_LINK_LABEL = 60;
export const MAX_LINK_URL = 2000;
export const MAX_LINKS_PER_ITEM = 20;

export type LinkDraft = { label: string; url: string };

/** Control and format characters (bidi overrides among them), which have no business in a label. */
const INVISIBLE = /[\p{Cc}\p{Cf}]/gu;

/**
 * A pasted link, checked: an absolute http: or https: URL — so never javascript:, data:, a relative path or a
 * protocol-relative `//host` — with a host, without a user name or password (a login pasted by mistake would go
 * public with it), and at most MAX_LINK_URL characters once the browser-standard parser has normalized it. The label
 * is trimmed, single-spaced, stripped of control and format characters and cut to MAX_LINK_LABEL; empty, it is the
 * site's host name. A string says what's wrong.
 */
export function checkPurchaseLink(rawLabel: string, rawUrl: string): LinkDraft | string {
  const text = rawUrl.trim();
  if (!text) return 'Paste the link’s address.';
  // the parser trims and drops tabs and newlines inside; anything else unusual stays and is percent-encoded
  if (/[\s\p{Cc}]/u.test(text)) return 'A link’s address has no spaces or line breaks in it.';
  let url: URL;
  try {
    url = new URL(text); // no base: a relative or protocol-relative address throws
  } catch {
    return 'That isn’t a whole web address — it should start with https://';
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return 'Only web links (https:// or http://) can be added.';
  if (!url.hostname) return 'That address has no site in it.';
  if (url.username || url.password) return 'That address carries a user name or password — remove it before adding the link.';
  const href = url.href;
  if (href.length > MAX_LINK_URL) return `A link’s address can be at most ${MAX_LINK_URL} characters.`;
  const label =
    rawLabel.replace(INVISIBLE, '').replace(/\s+/g, ' ').trim().slice(0, MAX_LINK_LABEL).trim() || url.hostname.replace(/^www\./, '');
  return { label, url: href };
}

/** The host a link goes to, as the list shows it beside the label: the one part of an address a person checks. */
export function linkHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/**
 * The export's `purchase_links` cell: JSON, oldest first — `[{"label":"Bookshop","url":"https://…"}]` — or empty.
 */
export function formatLinksCell(links: LinkDraft[]): string {
  return links.length ? JSON.stringify(links.map((l) => ({ label: l.label, url: l.url }))) : '';
}

/**
 * The links a `purchase_links` cell holds, each checked as a pasted one is — a cell edited in a spreadsheet can't
 * bring a javascript: address in — without repeats, at most MAX_LINKS_PER_ITEM. Anything unreadable is none.
 */
export function parseLinksCell(cell: string | null | undefined): LinkDraft[] {
  if (!cell?.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(cell);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: LinkDraft[] = [];
  for (const e of parsed) {
    if (!e || typeof e !== 'object') continue;
    const { label, url } = e as Record<string, unknown>;
    if (typeof url !== 'string') continue;
    const link = checkPurchaseLink(typeof label === 'string' ? label : '', url);
    if (typeof link === 'string' || out.some((l) => l.url === link.url)) continue;
    out.push(link);
    if (out.length >= MAX_LINKS_PER_ITEM) break;
  }
  return out;
}

// ---------- want lists in the export ----------

/** A want in the export's `wanted_by` cell: whose (a username, or left out: the importer's) and since when. */
export type CellWant = { by?: string; at: string | null };

const SQL_DATETIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

// Semicolon-separated, oldest first, each `since@member` as a reads token is `…@reader` (§16 #43):
//   2026-09-01 10:00:00@asha;2026-09-20 18:30:00@ravi
// The member is a username, percent-encoded so no name can break the cell. A token with no `@` is the importer's.
// A want belongs to a member who exists — removing one clears their list — so there is no "former member" here.
export function formatWantsCell(wants: Array<{ by: string; at: string }>): string {
  return wants.map((w) => `${w.at}@${encodeURIComponent(w.by)}`).join(';');
}

export function parseWantsCell(cell: string | null | undefined): CellWant[] {
  const out: CellWant[] = [];
  for (const token of (cell ?? '').split(';').map((t) => t.trim()).filter(Boolean)) {
    const at = token.lastIndexOf('@');
    const time = (at < 0 ? token : token.slice(0, at)).trim();
    let by: string | undefined;
    if (at >= 0) {
      try {
        by = decodeURIComponent(token.slice(at + 1));
      } catch {
        continue; // a broken name names nobody we could give it to
      }
      if (!by) continue; // an empty name: nobody's — a want is always somebody's
    }
    out.push({ ...(by === undefined ? {} : { by }), at: SQL_DATETIME.test(time) ? time : null });
  }
  return out;
}
