// The interface language as the views read it (ARCH.md §16 #93): a hono/jsx context carrying the request's
// Translator, provided around every page and partial by page()/partial() in layout.tsx and renderShare() in
// routes/share.tsx. A component anywhere in the tree reads it with useI18n() — no prop to thread through the pills
// and tables that every page shares. Rendering here is synchronous, so the context's fallback store holds for the
// whole tree; a component rendered outside any provider gets English, as a test's bare render does.
import { createContext, useContext, type Child, type FC } from 'hono/jsx';
import type { ItemStatus, MediaType } from '../db/schema';
import { ENGLISH, type Translator } from '../i18n';
import type { ShareVisibility } from '../lib/share';

export const I18n = createContext<Translator>(ENGLISH);

/** The request's translator, from inside a component. */
export const useI18n = (): Translator => useContext(I18n);

/**
 * A translated sentence with elements in it: `{name}` slots filled with JSX, so a translation decides the word order
 * around a link, a <strong> or a monospace date — "Lent to {borrower} on {date}" reads in any order a language needs.
 * The text between slots is escaped as any string is; a slot with nothing given shows its name, as fill() does.
 */
export const Fill: FC<{ text: string; with: Record<string, Child> }> = ({ text, with: slots }) => {
  const parts = text.split(/\{(\w+)\}/); // text, slot name, text, slot name, …, text
  return <>{parts.map((part, i) => (i % 2 === 1 ? (part in slots ? slots[part] : `{${part}}`) : part))}</>;
};

// The label constants in components.tsx stay as they are — the CSV, connections and the pages not yet covered read
// them — and the covered pages translate through these.
export const mediaLabel = (i18n: Translator, type: MediaType): string => i18n.t(`media.${type}`);
export const mediaCount = (i18n: Translator, type: MediaType, count: number): string => i18n.n(`media.${type}_count`, count);
export const statusLabel = (i18n: Translator, status: ItemStatus): string => i18n.t(`status.${status}`);
export const lengthUnit = (i18n: Translator, type: MediaType): string => (type === 'other' ? '' : i18n.t(`unit.${type}`));

/** shareVisibilityLabel() (src/lib/share.ts) in the page's language: title case, uppercased at a call site that wants it. */
export function visibilityLabel(i18n: Translator, v: ShareVisibility): string {
  if (v.kind === 'private') return i18n.t('visibility.private');
  if (v.kind === 'shelf') return v.links === 1 ? i18n.t('visibility.shared') : i18n.t('visibility.shared_links', { count: v.links });
  return i18n.n('visibility.views', v.links);
}
