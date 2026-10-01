// Money (ARCH.md §16 #61): what the household paid for an item, in the household's currency. Stored as an integer
// count of the currency's minor units — paise, cents; a yen is its own unit — with its ISO 4217 code beside it. Never a
// float: a price is parsed from its digits as text, and a total leaves SQL as text and is formatted as an exact
// decimal string, so nothing passes through binary fractions on the way. Money is never published: no share page,
// connection or feed entry carries it (toPublicItem() also drops a libib file's `price` from details).

/** A billion in any currency is a typo, not a purchase: at most this many whole units. */
export const MAX_MAJOR_UNITS = 999_999_999;

/** Details keys that hold money, kept in the app and dropped from anything published (§16 #61). */
export const MONEY_DETAIL_KEYS: ReadonlySet<string> = new Set(['price', 'purchase_price', 'purchase_currency', 'list_price', 'value']);
// list_price and value: LibraryThing's columns (§16 #87), stripped here too should a file ever put them in details

const CODE = /^[A-Z]{3}$/;

let codes: ReadonlySet<string> | null = null;
/** Every currency the runtime's Intl knows, as ISO 4217 codes. */
function knownCodes(): ReadonlySet<string> {
  if (codes) return codes;
  const supported = (Intl as { supportedValuesOf?: (key: 'currency') => string[] }).supportedValuesOf;
  codes = new Set(supported ? supported('currency') : ['AUD', 'BRL', 'CAD', 'CHF', 'EUR', 'GBP', 'INR', 'JPY', 'MXN', 'NZD', 'SEK', 'USD', 'ZAR']);
  return codes;
}

/** A currency code this app can store and format: three capital letters that Intl knows. */
export const isCurrencyCode = (v: unknown): v is string => typeof v === 'string' && CODE.test(v) && knownCodes().has(v);

/** Every known code, for the admin's currency select. */
export const currencyCodes = (): string[] => [...knownCodes()].sort();

let names: Intl.DisplayNames | null = null;
/** "Indian Rupee" — or the code itself, where the runtime has no name for it. */
export function currencyName(code: string): string {
  try {
    names ??= new Intl.DisplayNames(['en'], { type: 'currency' });
    return names.of(code) ?? code;
  } catch {
    return code;
  }
}

const DIGITS = new Map<string, number>();
/** How many minor units a currency's major unit splits into, as a power of ten: 2 for INR and USD, 0 for JPY, 3 for KWD. */
export function currencyDigits(code: string): number {
  const known = DIGITS.get(code);
  if (known !== undefined) return known;
  let d = 2;
  try {
    d = new Intl.NumberFormat('en', { style: 'currency', currency: code }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    // not a code Intl accepts: callers check isCurrencyCode first, so this is only ever a guard
  }
  DIGITS.set(code, d);
  return d;
}

export type MoneyParse = { ok: true; minor: number | null } | { ok: false; problem: string };

// digits, optionally grouped with commas — in threes ("38,500"), or the Indian way, twos above the last three
// ("1,00,000", a lakh; "1,00,00,000", a crore) — then an optional decimal part after a point. A comma is never a
// decimal separator: "12,50" is refused, not read as 12.50 or 1,250.
const AMOUNT = /^(\d+|\d{1,3}(?:,\d{3})+|\d{1,2}(?:,\d{2})*,\d{3})(?:\.(\d+))?$/;

/**
 * A price as typed — "499", "38,500", "12.50" — in `currency`'s minor units. Blank is no price (`minor: null`).
 * Refused: a negative, anything that isn't a number, more decimal places than the currency has (trailing zeros
 * aside: "12.500" is 12.50), and more than MAX_MAJOR_UNITS. Zero is a price: a gift, or a free copy.
 */
export function parseMoney(raw: unknown, currency: string): MoneyParse {
  const text = typeof raw === 'string' ? raw.trim().replace(/\s+/g, '') : '';
  if (text === '') return { ok: true, minor: null };
  if (/^[-−‒–—]/.test(text)) return { ok: false, problem: 'A purchase price can’t be negative.' };
  const m = AMOUNT.exec(text);
  if (!m) return { ok: false, problem: `Enter the price as a number in ${currency}, like 499 or 12.50.` };
  const whole = m[1]!.replaceAll(',', '').replace(/^0+(?=\d)/, '');
  const digits = currencyDigits(currency);
  const fraction = (m[2] ?? '').replace(/0+$/, '');
  if (fraction.length > digits) {
    return {
      ok: false,
      problem: digits === 0 ? `${currency} has no smaller unit: enter a whole number.` : `${currency} takes at most ${digits} decimal places.`,
    };
  }
  if (whole.length > String(MAX_MAJOR_UNITS).length || Number(whole) > MAX_MAJOR_UNITS) {
    return { ok: false, problem: `That’s more than ${MAX_MAJOR_UNITS.toLocaleString('en')} ${currency} — check the number.` };
  }
  // exact: at most 9 whole digits and 3 or 4 decimals, far inside a safe integer
  return { ok: true, minor: Number(whole + fraction.padEnd(digits, '0')) };
}

/**
 * Whether a stored price can be shown: whole, non-negative minor units with a known currency. Everything the app writes
 * is; a row edited by hand might not be, and is then left out — of the page, the totals and the export — rather than
 * failing any of them.
 */
export const isStoredPrice = (minor: unknown, currency: unknown): currency is string =>
  Number.isSafeInteger(minor) && (minor as number) >= 0 && isCurrencyCode(currency);

/** Minor units as a plain decimal in major units — "302.50", "38500" — for the form, the CSV and Intl. Exact. */
export function minorToDecimal(minor: number | bigint | string, currency: string): string {
  const s = String(minor).trim();
  if (!/^\d+$/.test(s)) throw new RangeError('minor units are a whole, non-negative number');
  const digits = currencyDigits(currency);
  const bare = s.replace(/^0+(?=\d)/, '');
  if (digits === 0) return bare;
  const padded = bare.padStart(digits + 1, '0');
  return `${padded.slice(0, -digits)}.${padded.slice(-digits)}`;
}

const FORMATS = new Map<string, Intl.NumberFormat>();
/**
 * Minor units for people: "₹30,200", "₹302.50", "US$45", "¥3,000". Whole amounts drop their ".00". The amount goes to
 * Intl as a decimal string, which it formats exactly, however large a total grows. `minor` may be SQL's text of a sum.
 */
export function formatMoney(minor: number | bigint | string, currency: string): string {
  const decimal = minorToDecimal(minor, currency);
  try {
    let nf = FORMATS.get(currency);
    if (!nf) {
      // trailingZeroDisplay is ES2023 Intl; TypeScript's lib here doesn't list it yet
      nf = new Intl.NumberFormat('en', { style: 'currency', currency, currencyDisplay: 'symbol', trailingZeroDisplay: 'stripIfInteger' } as Intl.NumberFormatOptions);
      FORMATS.set(currency, nf);
    }
    return nf.format(decimal as unknown as number);
  } catch {
    return `${decimal} ${currency}`;
  }
}

const COUNT = new Intl.NumberFormat('en', { maximumFractionDigits: 0 });
/** A count for people, grouped as prices are ("1,681", "30,200") — the same Intl 'en' grouping formatMoney uses. */
export const formatCount = (n: number): string => COUNT.format(n);

/**
 * A price from an import's cells (§16 #61): the amount, and the currency the file gives — or the household's, when
 * the file gives none. A currency that isn't one, an amount that doesn't parse, or a price with no currency to be
 * in, is no price: an import never guesses at money.
 */
export function cellPrice(
  amount: string | undefined,
  currency: string | undefined,
  household: string | null | undefined,
): { purchasePrice: number; purchaseCurrency: string } | null {
  if (!(amount ?? '').trim()) return null;
  const given = (currency ?? '').trim().toUpperCase();
  const code = given ? (isCurrencyCode(given) ? given : null) : (household ?? null);
  if (!code) return null;
  const parsed = parseMoney(amount, code);
  return parsed.ok && parsed.minor !== null ? { purchasePrice: parsed.minor, purchaseCurrency: code } : null;
}

/** One currency's part of a total: how many items have a price in it, and what they add up to (minor units, as text). */
export type CurrencyTotal = { currency: string; count: number; total: string };

/** Details without any key that holds money, for everything published. */
export function withoutMoney(details: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(details)) if (!MONEY_DETAIL_KEYS.has(k.trim().toLowerCase())) out[k] = v;
  return out;
}
