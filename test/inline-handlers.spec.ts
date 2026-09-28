// Nothing typed by a person or sent by another instance may reach an inline event handler. hono/jsx escapes
// a quote to &#39; inside an attribute, but the browser decodes that back into a quote before it runs the
// handler — so a shelf named  x'); alert(1); ('  used to run as script for the admin who pressed Delete.
// Confirmation text now travels in data-confirm, read by one static listener in the page head.
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createLibrary, createShare, createUser } from '../src/db/queries';
import { createSessionToken, SESSION_COOKIE } from '../src/lib/auth';
import { newShareToken } from '../src/lib/share';
import app from '../src/index';

// Vite's import.meta.glob, typed here: vite/client's declarations aren't resolvable from this project's root.
declare global {
  interface ImportMeta {
    glob(pattern: string, options: { query: string; import: string; eager: true }): Record<string, unknown>;
  }
}

// Every source file, as text, at build time — so this guard also catches handlers on pages the rendered
// checks below don't visit.
const sources = import.meta.glob('../src/**/*.{ts,tsx}', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

describe('inline event handlers', () => {
  it('are never built from an expression anywhere in src/', () => {
    expect(Object.keys(sources).length).toBeGreaterThan(20); // the glob really found the source tree
    const offenders = Object.entries(sources).flatMap(([file, text]) =>
      text
        .split('\n')
        .map((line, i) => ({ file, line: i + 1, text: line.trim() }))
        // on<event>={…}, and htmx's hx-on:<event>={…} — both run their value as script
        .filter((l) => /\bon(submit|click|change|input|load|focus|blur|keydown|keyup|mouseover)=\{|\bhx-on[:-][\w:-]*=\{/.test(l.text)),
    );
    expect(offenders).toEqual([]);
  });
});

const HOSTILE = "x'); window.__pwned=1; ('";

async function get(path: string, userId: number) {
  const token = await createSessionToken(env.SESSION_SECRET, userId, Math.floor(Date.now() / 1000));
  const ctx = createExecutionContext();
  const res = await app.fetch(new Request(`http://nalanda.test${path}`, { headers: { cookie: `${SESSION_COOKIE}=${token}` } }), env, ctx);
  await waitOnExecutionContext(ctx);
  return res.text();
}

/** Every inline handler attribute on the page, decoded the way a browser would before running it. */
function handlers(html: string): string[] {
  return [...html.matchAll(/\son[a-z]+="([^"]*)"/g)].map((m) => m[1]!.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
}

describe('names that reach a confirmation prompt', () => {
  it('stay out of every handler, and arrive as inert data-confirm text', async () => {
    const admin = await createUser(env.DB, { username: 'admin', passwordHash: 'pbkdf2$1$x$y', role: 'admin', mustChangePassword: false });
    await createUser(env.DB, { username: `member${HOSTILE}`, passwordHash: 'pbkdf2$1$x$y', role: 'member', mustChangePassword: false });
    const shelf = await createLibrary(env.DB, `Shelf ${HOSTILE}`);
    await createShare(env.DB, { token: newShareToken(), name: `Share ${HOSTILE}`, libraryId: shelf.id });

    for (const path of [`/libraries/${shelf.id}`, '/shares', '/settings/users']) {
      const html = await get(path, admin.id);
      expect(handlers(html).filter((h) => h.includes('__pwned')), path).toEqual([]);
      expect(html, path).toContain('data-confirm=');
      expect(html, path).toContain('__pwned'); // the name is still shown in the prompt, as text
    }
  });
});
