// The CSRF middleware, exercised the way real browsers behave — including the
// referrer-policy interaction that once broke login: under no-referrer, browsers
// send `Origin: null` on SAME-origin form posts (but Sec-Fetch-Site stays honest).
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import app from '../src/index';

async function postLogin(headers: Record<string, string>): Promise<number> {
  const ctx = createExecutionContext();
  const res = await app.fetch(
    new Request('http://nalanda.test/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
      body: 'username=x&password=y',
    }),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res.status;
}

describe('CSRF middleware', () => {
  it('allows same-origin browser posts, even with Origin: null (no-referrer policy)', async () => {
    expect(await postLogin({ 'sec-fetch-site': 'same-origin', origin: 'http://nalanda.test' })).not.toBe(403);
    expect(await postLogin({ 'sec-fetch-site': 'same-origin', origin: 'null' })).not.toBe(403);
    expect(await postLogin({ 'sec-fetch-site': 'none' })).not.toBe(403);
  });

  it('blocks cross-site posts', async () => {
    expect(await postLogin({ 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' })).toBe(403);
    expect(await postLogin({ 'sec-fetch-site': 'same-site' })).toBe(403);
  });

  it('legacy clients without Sec-Fetch-Site fall back to Origin comparison', async () => {
    expect(await postLogin({ origin: 'https://evil.example' })).toBe(403);
    expect(await postLogin({ origin: 'http://nalanda.test' })).not.toBe(403);
    expect(await postLogin({})).not.toBe(403); // non-browser clients carry no ambient cookies
  });
});
