// The interface language (ARCH.md §16 #93). Every string a covered page shows is a key in strings.ts, English the
// source; hi.ts and ta.ts are its translations, machine-drafted until a native reader checks them. t() looks a key
// up in the resolved locale and falls back to English; a household's own translation — imported by an admin, kept
// in the `translations` table — overrides the shipped one key by key. The interface follows the household's default
// language (site_settings.language, §16 #76) unless a member chose another on Account (users.locale); share pages
// carry the household's. Item data, usernames and display names are never translated.
import { en, type StringKey } from './strings';
import { hi } from './hi';
import { ta } from './ta';

export type { StringKey } from './strings';

/** The shipped locales, English first: what the Account select offers and what a household translation may be for. */
export const locales = ['en', 'hi', 'ta'] as const;
export type Locale = (typeof locales)[number];

export const isLocale = (value: unknown): value is Locale => typeof value === 'string' && (locales as readonly string[]).includes(value);

/** Each language's name in itself, for the select — never translated. */
export const LOCALE_NAMES: Record<Locale, string> = { en: 'English', hi: 'हिन्दी', ta: 'தமிழ்' };

export type Strings = Record<StringKey, string>;
/** A shipped language: its strings, and whether they are a machine draft nobody has checked yet. */
export type Pack = { strings: Strings; draft: boolean };

const PACKS: Record<Locale, Pack> = { en: { strings: en, draft: false }, hi, ta };

/** The locales whose shipped strings are a machine draft, for the notes that say so. */
export const DRAFT_LOCALES: readonly Locale[] = locales.filter((l) => PACKS[l].draft);

export const KEYS = Object.keys(en) as StringKey[];
const KEY_SET = new Set<string>(KEYS);
export const isStringKey = (value: unknown): value is StringKey => typeof value === 'string' && KEY_SET.has(value);

/** A household's own translation: whichever keys it chose to override, as the import kept them. */
export type Overrides = Partial<Record<StringKey, string>>;

export type Params = Record<string, string | number>;

/** `{name}` → its value; a placeholder with no value stays as written, so a mistyped one shows rather than vanishes. */
export function fill(text: string, params?: Params): string {
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (whole, name: string) => (Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : whole));
}

/**
 * The string for a key in a locale: the household's override, else the shipped translation, else English — and
 * English alone for a locale that isn't shipped. A key no translation has is never blank.
 */
export function t(locale: string, key: StringKey, params?: Params, overrides?: Overrides | null): string {
  const own = overrides?.[key];
  const shipped = isLocale(locale) ? PACKS[locale].strings[key] : undefined;
  return fill(own || shipped || en[key], params);
}

/** The keys that come in two forms: `<key>_one` and `<key>_other`. */
export type PluralKey = {
  [K in StringKey]: K extends `${infer Base}_one` ? (`${Base}_other` extends StringKey ? Base : never) : never;
}[StringKey];

/** One form for exactly one, the other for everything else — Hindi and Tamil count as English does here. */
export function n(locale: string, key: PluralKey, count: number, params?: Params, overrides?: Overrides | null): string {
  const form = (count === 1 ? `${key}_one` : `${key}_other`) as StringKey;
  return t(locale, form, { count, ...params }, overrides);
}

/**
 * Which locale a page is in (§16 #93): the member's own choice if it is a shipped locale, else the household's default
 * language where that is one, else English. A household language with no interface — French, say — leaves the
 * interface in English while every item still takes French.
 */
export function resolveLocale(user: { locale?: string | null } | null | undefined, settings: { language: string }): Locale {
  if (user?.locale && isLocale(user.locale)) return user.locale;
  return isLocale(settings.language) ? settings.language : 'en';
}

/** A locale bound with the household's overrides: what a request renders with. */
export type Translator = {
  locale: Locale;
  /** the shipped strings are a machine draft nobody has checked */
  draft: boolean;
  t: (key: StringKey, params?: Params) => string;
  n: (key: PluralKey, count: number, params?: Params) => string;
};

export function translator(locale: Locale, overrides?: Overrides | null): Translator {
  return {
    locale,
    draft: PACKS[locale].draft,
    t: (key, params) => t(locale, key, params, overrides),
    n: (key, count, params) => n(locale, key, count, params, overrides),
  };
}

/** English, with nothing overridden: what renders outside any request. */
export const ENGLISH: Translator = translator('en');

/** The whole table for a locale as a page would show it — the shipped strings with the household's overrides on top. */
export function stringsFor(locale: Locale, overrides?: Overrides | null): Strings {
  const out = { ...PACKS[locale].strings };
  if (overrides) for (const key of KEYS) if (overrides[key]) out[key] = overrides[key];
  return out;
}

/** What one imported translation may weigh (bytes of JSON): the whole English table is under 30 KB. */
export const MAX_TRANSLATION_BYTES = 200 * 1024;
/** No one string is longer than this: the longest shipped one is a paragraph of about 400 characters. */
export const MAX_STRING_LENGTH = 2000;

/**
 * An imported file, parsed: a JSON object of key → string. Only keys in the table are kept, with a non-empty string
 * of sensible length; everything else is counted as ignored — the file's own notes, a key from a later version, a
 * number. Not an object at all is null. The strings are kept as sent: hono/jsx escapes them when they render, so
 * markup in one is shown as text, never run.
 */
export function parseTranslation(value: unknown): { strings: Overrides; kept: number; ignored: number } | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const strings: Overrides = {};
  let kept = 0;
  let ignored = 0;
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (isStringKey(key) && typeof raw === 'string' && raw.trim() !== '' && raw.length <= MAX_STRING_LENGTH) {
      strings[key] = raw;
      kept++;
    } else {
      ignored++;
    }
  }
  return { strings, kept, ignored };
}
