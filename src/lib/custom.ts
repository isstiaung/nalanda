// The household's custom fields (ARCH.md §16 #95): what a field is, what a value may be by its kind, how the item
// form's values are read, what a share page may show of them, and the CSV cell they travel in. Values live on each
// item in `items.custom`, a JSON object keyed by the field's id — never in `details`, which share pages render whole.
// This module touches no D1: the fields' reads and writes are in src/db/queries.ts.
import { CUSTOM_KINDS, type CustomField, type CustomKind } from '../db/schema';
import { isIsoDate } from './reads';

/** How many fields a household may define: enough for the facts a shelf of books, games and records carries, few enough that every form stays short. */
export const CUSTOM_FIELD_LIMIT = 10;
export const MAX_CUSTOM_NAME = 40;
export const MAX_CUSTOM_TEXT = 500;

export const KIND_LABEL: Record<CustomKind, string> = { text: 'Text', bool: 'Yes / no', date: 'Date' };

export const isCustomKind = (v: unknown): v is CustomKind => (CUSTOM_KINDS as readonly unknown[]).includes(v);

/**
 * A value as the column keeps it: a line of text, a calendar date (YYYY-MM-DD), or `true` for a yes/no that is ticked.
 * Unset is no key at all — a yes/no left unticked is unset, not `false`, so an item nobody has said anything about
 * says nothing (the page shows set values only).
 */
export type CustomValue = string | true;
/** An item's values, keyed by the field's id as a string. */
export type CustomValues = Record<string, CustomValue>;

/** The field's input on the item form, and the hidden marker that says a form carried the fields at all. */
export const CUSTOM_FORM_MARKER = 'customForm';
export const customInputName = (id: number) => `custom-${id}`;

/**
 * A field's name as typed: one line, whitespace collapsed, control and format characters out (a name goes out on
 * share pages when its switch is on), at most MAX_CUSTOM_NAME characters. Null when nothing usable is left.
 */
export function cleanCustomName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const name = raw.replace(/[\p{Cc}\p{Cf}]/gu, '').replace(/\s+/g, ' ').trim();
  return name && name.length <= MAX_CUSTOM_NAME ? name : null;
}

/**
 * The column's JSON as values. Only what a kind could hold — a string or `true` — is kept; anything else (`false`, a
 * number, a nested object, a column that isn't JSON) reads as unset, so nothing downstream renders a value no field
 * could have produced. Keys are not checked against the fields here: a key of a field deleted since is simply never
 * asked for (customEntries takes the fields).
 */
export function parseCustom(json: string | null | undefined): CustomValues {
  if (!json || json === '{}') return {};
  try {
    const parsed: unknown = JSON.parse(json);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: CustomValues = {};
    for (const [k, v] of Object.entries(parsed)) if (typeof v === 'string' || v === true) out[k] = v;
    return out;
  } catch {
    return {};
  }
}

/**
 * One value checked by its field's kind — from the form, the import's cell or a hand-edited file alike. `value` null
 * means unset (blank, an unticked box, `false`); a problem names the field and says what it takes. A number given for
 * text is read as text, as a spreadsheet writes one.
 */
export function checkCustomValue(field: Pick<CustomField, 'name' | 'kind'>, raw: unknown): { value: CustomValue | null; problem: string | null } {
  const unset = { value: null, problem: null };
  if (field.kind === 'bool') {
    if (raw === true || raw === '1' || raw === 'on' || raw === 'true') return { value: true, problem: null };
    if (raw === undefined || raw === null || raw === false || raw === '' || raw === '0' || raw === 'false') return unset;
    return { value: null, problem: `${field.name} is a yes/no field.` };
  }
  if (raw === undefined || raw === null) return unset;
  const text = typeof raw === 'number' && Number.isFinite(raw) ? String(raw) : typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : null;
  if (text === null) return { value: null, problem: `${field.name} must be ${field.kind === 'date' ? 'a date' : 'text'}.` };
  if (!text) return unset;
  if (field.kind === 'date') return isIsoDate(text) ? { value: text, problem: null } : { value: null, problem: `${field.name} must be a date, as 2026-10-01.` };
  if (text.length > MAX_CUSTOM_TEXT) return { value: null, problem: `${field.name} holds at most ${MAX_CUSTOM_TEXT} characters.` };
  return { value: text, problem: null };
}

/** What the item form said about the fields: `values` to store (null when the form carried no fields — nothing is written then), what to show back, and the first problem with the field it names. */
export type FormCustom = { values: CustomValues | null; shown: CustomValues; problem: string | null; problemField: number | null };

/**
 * The item form's custom values (§16 #95), each read by its field's kind. A form without the marker — a scan's or a
 * search result's add, a form opened before any field existed — says nothing, and the item's values stay as they
 * are; so does a household with no fields. `shown` is what a refused form shows again: the text as typed, a tick as
 * ticked, so nothing is lost to a mistyped date beside it.
 */
export function customFromForm(body: Record<string, unknown>, fields: CustomField[]): FormCustom {
  if (!fields.length || body[CUSTOM_FORM_MARKER] !== '1') return { values: null, shown: {}, problem: null, problemField: null };
  const values: CustomValues = {};
  const shown: CustomValues = {};
  let problem: string | null = null;
  let problemField: number | null = null;
  for (const f of fields) {
    const raw = body[customInputName(f.id)];
    const typed = typeof raw === 'string' ? raw : undefined;
    if (f.kind === 'bool' ? typed === '1' : typed?.trim()) shown[String(f.id)] = f.kind === 'bool' ? true : typed!.trim();
    const checked = checkCustomValue(f, typed);
    if (checked.problem) {
      if (!problem) [problem, problemField] = [checked.problem, f.id];
    } else if (checked.value !== null) values[String(f.id)] = checked.value;
  }
  return { values, shown, problem, problemField };
}

/** An item's set values in the fields' order, each with its field — a key with no field among `fields` is never returned. */
export function customEntries(custom: string | null | undefined, fields: CustomField[]): Array<{ field: CustomField; value: CustomValue }> {
  const values = parseCustom(custom);
  const out: Array<{ field: CustomField; value: CustomValue }> = [];
  for (const field of fields) {
    const value = values[String(field.id)];
    if (value !== undefined) out.push({ field, value });
  }
  return out;
}

/** A custom value on a share page: the field's name and kind, and the value — never the field's id. */
export type PublicCustom = { name: string; kind: CustomKind; value: CustomValue };

/**
 * What a share page may show of an item's custom values (§16 #95): only the fields whose own "Show on share pages"
 * switch is on — checked here, whatever list the caller passed — by name, and only those with a value set. Nothing
 * of a field with its switch off, and never the raw column.
 */
export function publicCustom(custom: string | null | undefined, fields: CustomField[]): PublicCustom[] {
  return customEntries(
    custom,
    fields.filter((f) => f.onShares),
  ).map(({ field, value }) => ({ name: field.name, kind: field.kind, value }));
}

/**
 * The export's `custom` cell: the item's set values by field *name*, as JSON — `{"Signed":true,"Gifted by":"Ravi"}` —
 * so a file moves between households, whose fields have different ids; '' when there are none.
 */
export function formatCustomCell(custom: string | null | undefined, fields: CustomField[]): string {
  const entries = customEntries(custom, fields);
  if (!entries.length) return '';
  return JSON.stringify(Object.fromEntries(entries.map((e) => [e.field.name, e.value])));
}

/** What a `custom` cell brought: the column to store, and what was left behind for the preview to say. */
export type ParsedCustomCell = { custom: string; kept: number; dropped: number; unfit: number };

/**
 * A Nalanda export's `custom` cell mapped onto this household's fields by name (case aside), each value checked by its
 * field's kind. A name with no field here is dropped and counted (`dropped`); a value that doesn't fit its field — a
 * date that isn't one, text past the limit — likewise (`unfit`); a cell that isn't JSON brings nothing and counts as
 * one unfit value. Never into `details`.
 */
export function parseCustomCell(cell: string | undefined, fields: CustomField[]): ParsedCustomCell {
  const none = { custom: '{}', kept: 0, dropped: 0, unfit: 0 };
  if (!cell?.trim()) return none;
  let parsed: unknown;
  try {
    parsed = JSON.parse(cell);
  } catch {
    return { ...none, unfit: 1 };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ...none, unfit: 1 };
  const byName = new Map(fields.map((f) => [f.name.toLowerCase(), f]));
  const out: CustomValues = {};
  let dropped = 0;
  let unfit = 0;
  for (const [name, raw] of Object.entries(parsed)) {
    const field = byName.get(name.replace(/\s+/g, ' ').trim().toLowerCase());
    if (!field) {
      dropped++;
      continue;
    }
    const checked = checkCustomValue(field, raw);
    if (checked.problem) unfit++;
    else if (checked.value !== null) out[String(field.id)] = checked.value;
  }
  return { custom: JSON.stringify(out), kept: Object.keys(out).length, dropped, unfit };
}

/**
 * A `custom` history row's value (§16 #84) as an admin reads it: the row holds the column's JSON by id, cut to 200
 * characters, and ids mean nothing to a person — so it is shown through the household's fields as the item page shows
 * values, `Signed: yes · Gifted by: Ravi`, in the fields' order, a key whose field is gone since as "a field since
 * deleted". Null for none (the page shows a dash); a value the cut left unreadable is shown as stored.
 */
export function describeCustomHistory(stored: string | null, fields: CustomField[]): string | null {
  if (!stored) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    return stored;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return stored;
  const values = parsed as Record<string, unknown>;
  const show = (v: unknown) => (v === true ? 'yes' : typeof v === 'string' ? v : JSON.stringify(v));
  const known = new Set(fields.map((f) => String(f.id)));
  const parts = [
    ...fields.filter((f) => values[String(f.id)] !== undefined).map((f) => `${f.name}: ${show(values[String(f.id)])}`),
    ...Object.entries(values)
      .filter(([k]) => !known.has(k))
      .map(([, v]) => `a field since deleted: ${show(v)}`),
  ];
  return parts.length ? parts.join(' · ') : null;
}

