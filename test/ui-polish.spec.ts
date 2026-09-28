// Markup behind the visual polish pass: the few places where a CSS fix needed the page to say something
// different — a class, a wrapper, a line of copy. The styling itself is checked by eye (screenshots); these
// pin the markup it depends on, so a later edit can't quietly undo it.
import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSubscription } from '../src/db/federation';
import type { Bindings } from '../src/env';
import { answerOutbound, connectPeer, instanceA, json, makeKeys, makePeer, sessionCookie, setUpA } from './federation-helpers';

afterEach(() => {
  vi.unstubAllGlobals();
});

/** An instance with connections on, one active connection, and every outbound request answered 404. */
async function connected() {
  const keys = await makeKeys();
  const a = instanceA({ ...env, FEDERATION_PRIVATE_KEY: keys.secret } as Bindings);
  answerOutbound(() => json({}, 404));
  await setUpA();
  const peer = await makePeer('Riverbank library');
  const { id } = await connectPeer(peer);
  return { a, connectionId: id };
}

describe('row actions', () => {
  it('draws Purge as a danger action, like Unfollow beside it', async () => {
    const { a, connectionId } = await connected();
    await createSubscription(env.DB, {
      connectionId,
      viewId: 7,
      viewName: 'Finished this year',
      intervalMinutes: 60,
      retentionDays: 90,
      maxEntries: 500,
    });
    const html = await (await a.get(`/connections/${connectionId}/feed`, await sessionCookie('admin'))).text();
    expect(html).toMatch(/<button class="btn-danger" type="submit">\s*Purge/);
    expect(html).toMatch(/<button class="btn-danger" type="submit">\s*Unfollow/);
    // the per-view Save stays a plain secondary button
    expect(html).toMatch(/<button class="btn" type="submit">\s*Save/);
  });

  it('leaves the per-view storage column to wider screens — the page head carries the total', async () => {
    const { a, connectionId } = await connected();
    await createSubscription(env.DB, {
      connectionId,
      viewId: 7,
      viewName: 'Finished this year',
      intervalMinutes: 60,
      retentionDays: 90,
      maxEntries: 500,
    });
    const html = await (await a.get(`/connections/${connectionId}/feed`, await sessionCookie('admin'))).text();
    expect(html).toContain('<th class="hide-sm">Stored</th>');
    expect(html).toContain('<td class="num hide-sm">');
    expect(html).toMatch(/FEED · 0 ENTRIES · [^<]+ STORED/); // the total stays in the head, on every screen
  });
});
