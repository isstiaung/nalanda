// Route-level: GET /add must load scanner.js, or the camera scan feature silently
// does nothing — the button exists, its click handler never attaches, no error is
// ever shown. That exact bug shipped in the very first commit that introduced this
// page and went unnoticed across every browser/device until debugged live. Locking
// it in with a test rather than trusting a future edit not to drop the <script> tag
// again the same way.
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createUser } from '../src/db/queries';
import { createSessionToken, SESSION_COOKIE } from '../src/lib/auth';
import app from '../src/index';

describe('GET /add', () => {
  it('loads scanner.js, the script that wires up the Start camera button', async () => {
    const user = await createUser(env.DB, {
      username: `u-${crypto.randomUUID().slice(0, 8)}`,
      passwordHash: 'pbkdf2$100000$x$y',
      role: 'member',
      mustChangePassword: false,
    });
    const token = await createSessionToken(env.SESSION_SECRET, user.id, Math.floor(Date.now() / 1000));

    const ctx = createExecutionContext();
    const res = await app.fetch(
      new Request('http://nalanda.test/add', { headers: { cookie: `${SESSION_COOKIE}=${token}` } }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('src="/scanner.js"');
    // the button and the script that wires it up must both be present, or one half
    // of the pairing going missing again would still slip through
    expect(html).toContain('id="scanner-start"');
  });
});
