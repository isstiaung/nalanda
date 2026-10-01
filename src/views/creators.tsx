// The creators line on an item's page (ARCH.md §16 #72): each person a link to their page, the string shown as it is.
import type { FC } from 'hono/jsx';
import { splitCreators } from '../lib/creators';

/**
 * "Terry Pratchett, Neil Gaiman" with each name linked — or, when the split finds nobody to link (a lone "Jr."), or
 * finds names that aren't substrings of the text as written ("Le Guin, Ursula K." turns round), the text as it is with
 * one link per person after it.
 */
export const CreatorLinks: FC<{ creators: string }> = ({ creators }) => {
  const names = splitCreators(creators);
  if (!names.length) return <p>{creators}</p>;
  // link the names in place when every one appears verbatim in the text, in order
  let rest = creators;
  const parts: Array<string | { name: string }> = [];
  for (const name of names) {
    const at = rest.indexOf(name);
    if (at < 0) {
      parts.length = 0;
      break;
    }
    parts.push(rest.slice(0, at), { name });
    rest = rest.slice(at + name.length);
  }
  if (parts.length) {
    parts.push(rest);
    return (
      <p>
        {parts.map((p) => (typeof p === 'string' ? p : <a href={`/creators/${encodeURIComponent(p.name)}`}>{p.name}</a>))}
      </p>
    );
  }
  return (
    <p>
      {creators}{' '}
      <small class="muted">
        (
        {names.map((n, i) => (
          <>
            {i ? ', ' : ''}
            <a href={`/creators/${encodeURIComponent(n)}`}>{n}</a>
          </>
        ))}
        )
      </small>
    </p>
  );
};
