// A minimal stand-in for the `fetchMock` that `cloudflare:test` exported before
// vitest-pool-workers v0.20 (and miniflare 5) dropped undici's MockAgent.
//
// The replacement is a global `fetch` stub: the pool runs the worker under test in the
// same isolate as the test itself, so a global mock reaches the app's outbound calls.
// Only the behaviour our tests relied on is reproduced, and deliberately keeps the two
// properties that made the old one trustworthy:
//
//   - an unmatched request throws, rather than escaping to the real network
//   - unconsumed interceptors are an assertion failure, so a test that stops exercising
//     a provider path fails instead of quietly passing
//
// Interceptors match one request each, in registration order, so repeated calls to the
// same URL need one interceptor apiece — same as undici.
import { vi } from 'vitest';

type Matcher = string | ((path: string) => boolean);

type Interceptor = {
  origin: string;
  matcher: Matcher;
  status: number;
  body: string;
  headers: Record<string, string>;
  consumed: boolean;
};

const interceptors: Interceptor[] = [];

/**
 * Queue one reply. `path` is matched against the raw, still-encoded `pathname + search`
 * — decoding inside matchers is fragile — or, as a string, against the bare pathname.
 */
export function intercept(
  origin: string,
  path: Matcher,
  reply: { status?: number; body?: string; headers?: Record<string, string> } = {},
): void {
  interceptors.push({
    origin,
    matcher: path,
    status: reply.status ?? 200,
    body: reply.body ?? '',
    headers: reply.headers ?? {},
    consumed: false,
  });
}

export const json = (value: unknown) => ({
  body: JSON.stringify(value),
  headers: { 'content-type': 'application/json' },
});

/** Big enough to clear the 500-byte "this is a tracking pixel" floor in covers.ts. */
export const jpeg = () => ({
  body: 'x'.repeat(1200),
  headers: { 'content-type': 'image/jpeg' },
});

function matches(i: Interceptor, url: URL): boolean {
  if (i.consumed || url.origin !== i.origin) return false;
  const path = `${url.pathname}${url.search}`;
  return typeof i.matcher === 'string' ? i.matcher === path || i.matcher === url.pathname : i.matcher(path);
}

/** Install the stub. Call in `beforeAll`/`beforeEach`. */
export function activateFetchMock(): void {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
    const raw = input instanceof Request ? input.url : String(input);
    const url = new URL(raw);
    const hit = interceptors.find((i) => matches(i, url));
    if (!hit) {
      throw new Error(`Unmocked outbound request: ${raw}`);
    }
    hit.consumed = true;
    return new Response(hit.body, { status: hit.status, headers: hit.headers });
  });
}

/** Fail if anything queued went unused, then clear. Call in `afterEach`. */
export function assertNoPendingInterceptors(): void {
  const pending = interceptors.filter((i) => !i.consumed);
  interceptors.length = 0;
  if (pending.length > 0) {
    const list = pending.map((i) => `  ${i.origin} ${String(i.matcher)}`).join('\n');
    throw new Error(`${pending.length} interceptor(s) never matched a request:\n${list}`);
  }
}
