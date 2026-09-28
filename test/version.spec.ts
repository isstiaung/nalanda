// Releases (ARCH.md §16 #42): the version in the code matches package.json, every version has its CHANGELOG
// section with an Upgrading block, and it is shown to signed-in people but never in the public descriptor.
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { Bindings } from '../src/env';
import { VERSION } from '../src/version';
import { instanceA, makeKeys, sessionCookie, setUpA } from './federation-helpers';

const files = import.meta.glob('../{package.json,CHANGELOG.md}', { query: '?raw', import: 'default', eager: true }) as Record<
  string,
  string
>;
const pkg = JSON.parse(files['../package.json']!) as { version?: string };
const changelog = files['../CHANGELOG.md']!;

/** A version's CHANGELOG section: from its heading to the next release's. */
const section = (version: string) => {
  const start = changelog.indexOf(`\n## [${version}]`);
  if (start < 0) return null;
  const next = changelog.indexOf('\n## [', start + 1);
  return changelog.slice(start, next < 0 ? undefined : next);
};

describe('the release this code is', () => {
  it('is the same version in src/version.ts and package.json', () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(VERSION).toBe(pkg.version);
  });

  it('has a CHANGELOG section with an Upgrading block, as every release does', () => {
    const notes = section(VERSION);
    expect(notes, `CHANGELOG.md has no section for ${VERSION}`).not.toBeNull();
    expect(notes).toContain('### Upgrading');
    for (const heading of changelog.match(/^## \[\d+\.\d+\.\d+\]/gm) ?? []) {
      expect(section(heading.slice(4, -1)), heading).toContain('### Upgrading');
    }
  });

  it('shows on the Account page, with a link to its release notes', async () => {
    const html = await (await instanceA(env).get('/account', await sessionCookie('member'))).text();
    expect(html).toContain(`v${VERSION}`);
    expect(html).toContain(`https://github.com/isstiaung/nalanda/releases/tag/v${VERSION}`);
  });

  it('is never in the public descriptor, which carries only the connections protocol version', async () => {
    const keys = await makeKeys();
    await setUpA();
    const res = await instanceA({ ...env, FEDERATION_PRIVATE_KEY: keys.secret } as Bindings).get('/.well-known/nalanda');
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(VERSION);
    expect(Object.keys(JSON.parse(text)).sort()).toEqual(['name', 'protocol', 'publicKey', 'url', 'version']);
  });
});
