// Releases (ARCH.md §16 #42): the version in the code matches package.json, every version has its own
// changelog/vX.Y.Z.md with an Upgrading block, linked from the CHANGELOG.md index, and it is shown to
// signed-in people but never in the public descriptor.
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { Bindings } from '../src/env';
import { VERSION } from '../src/version';
import { instanceA, makeKeys, sessionCookie, setUpA } from './federation-helpers';

const files = import.meta.glob('../{package.json,CHANGELOG.md,changelog/*.md}', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;
const pkg = JSON.parse(files['../package.json']!) as { version?: string };
const index = files['../CHANGELOG.md']!;

/** Each release's notes, by version: changelog/v1.6.2.md is '1.6.2'. Other names (unreleased.md) aren't releases. */
const releases = new Map(
  Object.entries(files).flatMap(([path, text]) => {
    const version = /^\.\.\/changelog\/v(\d+\.\d+\.\d+)\.md$/.exec(path)?.[1];
    return version ? [[version, text] as const] : [];
  }),
);

describe('the release this code is', () => {
  it('is the same version in src/version.ts and package.json', () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(VERSION).toBe(pkg.version);
  });

  it('has its own changelog file, headed with its version and holding an Upgrading block', () => {
    expect(releases.get(pkg.version!), `no changelog/v${pkg.version}.md`).toBeDefined();
    expect(releases.size).toBeGreaterThan(1); // the glob found the folder, not just this release
    for (const [version, text] of releases) {
      // release.yml publishes the file only under this heading, and drops it from the notes.
      expect(text.split('\n')[0], `changelog/v${version}.md`).toMatch(new RegExp(`^## \\[${version.replaceAll('.', '\\.')}\\] - \\d{4}-\\d{2}-\\d{2}$`));
      expect(text, `changelog/v${version}.md`).toContain('\n### Upgrading\n');
    }
  });

  it('is linked from the CHANGELOG.md index, as every release file is, and the index links no missing file', () => {
    for (const version of releases.keys()) {
      expect(index, `CHANGELOG.md doesn't link changelog/v${version}.md`).toContain(`](changelog/v${version}.md)`);
    }
    for (const [, version] of index.matchAll(/\]\(changelog\/v([^)]+)\.md\)/g)) {
      expect(releases.has(version!), `CHANGELOG.md links changelog/v${version}.md, which doesn't exist`).toBe(true);
    }
  });

  it('leaves changelog/unreleased.md for the next release', () => {
    expect(files['../changelog/unreleased.md']?.split('\n')[0]).toBe('## [Unreleased]');
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
    expect(Object.keys(JSON.parse(text)).sort()).toEqual(['accepts', 'name', 'protocol', 'publicKey', 'url', 'version']); // accepts: message types, §16 #58
  });
});
