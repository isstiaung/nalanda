// The household switches (1.6.1): Shared links' reading progress and names, Connections' progress, names and goals,
// and Members' currency are one layout — the control and its label, then what it does, then Save — and each still
// posts what it did before. The layout itself is .switch-form in public/app.css.
import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getSiteSettings } from '../src/db/queries';
import type { Bindings } from '../src/env';
import { answerOutbound, instanceA, json, makeKeys, sessionCookie, setUpA } from './federation-helpers';

let a: ReturnType<typeof instanceA>;
let admin: string;

beforeEach(async () => {
  a = instanceA({ ...env, FEDERATION_PRIVATE_KEY: (await makeKeys()).secret } as Bindings);
  answerOutbound(() => json({}, 404));
  await setUpA();
  admin = await sessionCookie('admin');
});
afterEach(() => vi.unstubAllGlobals());

/** The one switch form on `html` that posts to `action` and holds `marker`. */
function switchForm(html: string, action: string, marker: string): string {
  const forms = [...html.replace(/\s+/g, ' ').matchAll(/<form method="post" action="([^"]+)" class="switch-form[^"]*"[^>]*>(.*?)<\/form>/g)]
    .filter((m) => m[1] === action && m[2]!.includes(marker))
    .map((m) => m[2]!);
  expect(forms, `${action} ${marker}`).toHaveLength(1);
  return forms[0]!;
}

/** Control, then the help text, then Save — in that order, each once. */
function expectLayout(form: string, control: string, help: string) {
  const at = [form.indexOf(control), form.indexOf(help), form.search(/<button type="submit"( disabled="")?>\s*Save\s*<\/button>/)];
  expect(at.every((i) => i >= 0), form).toBe(true);
  expect(at, form).toEqual([...at].sort((x, y) => x - y));
  expect(form.match(/<button/g)).toHaveLength(1);
}

type Switch = {
  name: string;
  page: string;
  action: string;
  control: string;
  help: string;
  post: Record<string, string>;
  read: () => Promise<unknown>;
  before: unknown;
};

const SWITCHES: Switch[] = [
  {
    name: "Shared links' reading progress",
    page: '/shares',
    action: '/shares/settings',
    control: 'name="progressOnShares"',
    help: 'Off by default. When on, a book being read now',
    post: { setting: 'progress', progressOnShares: 'on' },
    read: async () => (await getSiteSettings(env.DB)).progressOnShares,
    before: false,
  },
  {
    name: "Shared links' names",
    page: '/shares',
    action: '/shares/settings',
    control: 'name="namesOnShares"',
    help: 'Off, a shared book shows the household',
    post: { setting: 'names' }, // unchecked: off
    read: async () => (await getSiteSettings(env.DB)).namesOnShares,
    before: true,
  },
  {
    name: "Connections' reading progress",
    page: '/connections',
    action: '/connections/progress-sharing',
    control: 'name="progressToConnections"',
    help: 'On by default. Each page you record',
    post: {},
    read: async () => (await getSiteSettings(env.DB)).progressToConnections,
    before: true,
  },
  {
    name: "Connections' names",
    page: '/connections',
    action: '/connections/names-sharing',
    control: 'name="namesToConnections"',
    help: 'Off, they see your household as one',
    post: {},
    read: async () => (await getSiteSettings(env.DB)).namesToConnections,
    before: true,
  },
  {
    name: "Connections' reading goals",
    page: '/connections',
    action: '/connections/goals-sharing',
    control: 'name="goalsToConnections"',
    help: 'With it on, their feed gets an entry when a member sets a reading goal',
    post: {},
    read: async () => (await getSiteSettings(env.DB)).goalsToConnections,
    before: true,
  },
  {
    name: "Members' household currency",
    page: '/settings/users',
    action: '/settings/currency',
    control: 'id="household-currency"',
    help: 'id="currency-help"',
    post: { currency: 'INR' },
    read: async () => (await getSiteSettings(env.DB)).currency,
    before: null,
  },
];

describe('the household switches', () => {
  it.each(SWITCHES.map((s) => [s.name, s]))('%s: the control, then what it does, then Save', async (_name, s) => {
    const html = await (await a.get(s.page, admin)).text();
    expectLayout(switchForm(html, s.action, s.control), s.control, s.help);
  });

  it.each(SWITCHES.map((s) => [s.name, s]))('%s: still posts, and changes only its own setting', async (_name, s) => {
    expect(await s.read()).toBe(s.before);
    const res = await a.postForm(s.action, s.post, admin);
    expect(res.status).toBe(302);
    expect(await s.read()).not.toBe(s.before);
  });

  it('re-renders a refused currency with its error inside the form, above the help and Save', async () => {
    const res = await a.postForm('/settings/currency', { currency: 'XXQ' }, admin);
    expect(res.status).toBe(400);
    const form = switchForm(await res.text(), '/settings/currency', 'id="household-currency"');
    const at = [
      form.indexOf('id="household-currency"'),
      form.indexOf('<p class="field-error" id="currency-error">Choose a currency from the list.</p>'),
      form.indexOf('id="currency-help"'),
      form.indexOf('<button type="submit">Save</button>'),
    ];
    expect(at.every((i) => i >= 0)).toBe(true);
    expect(at).toEqual([...at].sort((x, y) => x - y));
    expect(form).toContain('aria-describedby="currency-error currency-help"');
    expect((await getSiteSettings(env.DB)).currency).toBe(null);
  });

  it('greys only the goals switch’s checkbox and Save while names are off, never its note', async () => {
    await a.postForm('/connections/names-sharing', {}, admin);
    const html = (await (await a.get('/connections', admin)).text()).replace(/\s+/g, ' ');
    expect(html).toContain('class="switch-form switch-off" id="goals-to-connections"');
    const css = await (await env.ASSETS.fetch('http://assets/app.css')).text();
    expect(css).toContain('.switch-off > label, .switch-off > button { opacity: 0.5; }');
    expect(css).not.toMatch(/\.switch-off \{[^}]*opacity/);
  });
});
