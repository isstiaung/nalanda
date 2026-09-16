// Backfills covers and descriptions for the production catalog from this machine instead of the Worker.
//
// The in-app backfill (/import → Cover backfill) runs inside a Worker's free-plan limits — 10 ms CPU and
// 50 subrequests per request — and a large catalog trips them. From a laptop, the same matching code
// (src/metadata, loaded as-is) has no such ceiling, can retry, and can pace itself for the providers.
// runbooks/metadata-backfill.md is the procedure. In short:
//
//   npm run backfill:remote -- rehearse   the whole pipeline against a throwaway local database, checked
//   npm run backfill:remote -- export     snapshot what production is missing
//   npm run backfill:remote -- enrich     look it up — resumable; try --sample 20 first
//   npm run backfill:remote -- upload     covers → R2
//   npm run backfill:remote -- apply      fill the blanks in D1 (wants a backup taken in the last 12 hours)
//   npm run backfill:remote -- status
//
// Every write fills a blank and nothing else. Each UPDATE re-checks that its field is still empty, so
// anything written after the export — by a person, or by the in-app backfill — wins.
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { register } from 'node:module';
import { promisify } from 'node:util';
import { DATABASE, removeRemoteConfig, writeRemoteConfig } from './remote-config.mjs';

const execFileAsync = promisify(execFile);
const BUCKET = 'nalanda-covers';
const ROOT = '.backfill';
const REMOTE_CONFIG = '.wrangler-remote-backfill.jsonc';
const BACKUP_MAX_AGE_HOURS = 12;
const SQL_BATCH = 200;

const COMMANDS = {
  rehearse: [],
  export: ['discard'],
  enrich: ['sample', 'limit', 'concurrency', 'rps', 'require-google-books', 'retry-misses'],
  upload: ['concurrency'],
  apply: [],
  status: ['offline'],
};

// ---------- command line ----------

function fail(message) {
  console.error(message);
  process.exit(1);
}

function parseFlags(args, allowed) {
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('--')) fail(`Unexpected argument: ${arg}`);
    const key = arg.slice(2);
    if (!allowed.includes(key)) fail(`Unknown option --${key}. This command takes: ${allowed.map((a) => `--${a}`).join(' ') || 'no options'}`);
    const next = args[i + 1];
    if (next === undefined || next.startsWith('--')) flags[key] = true;
    else {
      flags[key] = next;
      i++;
    }
  }
  return flags;
}

function positiveInt(value, name, fallback) {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) fail(`--${name} needs a positive number`);
  return n;
}

let interrupted = false;
process.on('SIGINT', () => {
  if (interrupted) process.exit(130);
  interrupted = true;
  console.error('\nStopping after the work in flight… (Ctrl-C again to quit immediately)');
});

// ---------- where the data lives ----------

// Production and rehearsal keep separate state, so a rehearsal's results can never be applied for real.
let remoteConfig = null;
function productionTarget() {
  return {
    label: 'production',
    dir: `${ROOT}/production`,
    get d1() {
      remoteConfig ??= writeRemoteConfig(`npm run backfill:remote -- ${process.argv[2] ?? ''}`.trim(), REMOTE_CONFIG);
      return ['--remote', '--config', remoteConfig];
    },
    r2: ['--remote'],
  };
}

function rehearsalTarget() {
  const state = `${ROOT}/rehearsal/wrangler-state`;
  return {
    label: 'rehearsal',
    dir: `${ROOT}/rehearsal/run`,
    state,
    d1: ['--local', '--persist-to', state],
    r2: ['--local', '--persist-to', state],
  };
}

const paths = (target) => ({
  state: `${target.dir}/state.json`,
  queue: `${target.dir}/queue.json`,
  results: `${target.dir}/results.jsonl`,
  covers: `${target.dir}/covers`,
  uploaded: `${target.dir}/uploaded.txt`,
  sql: `${target.dir}/sql`,
  applied: `${target.dir}/applied.txt`,
});

const readJson = (file, fallback) => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : fallback);
const readLines = (file) => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : []);
const hasPatch = (r) => Object.keys(r.patch ?? {}).length > 0;

/** The newest answer per item — a retry pass appends a second line for the same id. */
function latestResults(target) {
  const byId = new Map();
  for (const line of readLines(paths(target).results)) {
    const r = JSON.parse(line);
    byId.set(r.id, r);
  }
  return [...byId.values()];
}

// ---------- wrangler ----------

async function wrangler(args) {
  try {
    const { stdout } = await execFileAsync('npx', ['wrangler', ...args], {
      maxBuffer: 256 * 1024 * 1024,
      timeout: 10 * 60 * 1000,
    });
    return stdout;
  } catch (err) {
    const lines = `${err.stderr ?? ''}\n${err.stdout ?? ''}`
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !/newer version of Wrangler|npm notice|^─+$|Logs were written/i.test(l));
    const errors = lines.filter((l) => /error|✘|failed|denied|not found|locked/i.test(l));
    const detail = (errors.length ? errors : lines).slice(-4).join('\n');
    throw new Error(`wrangler ${args.slice(0, 3).join(' ')} failed: ${detail || err.message}`);
  }
}

async function d1Json(target, args) {
  const stdout = await wrangler(['d1', 'execute', DATABASE, ...target.d1, '--json', ...args]);
  const start = stdout.indexOf('[');
  if (start < 0) throw new Error(`wrangler printed no JSON:\n${stdout.slice(0, 400)}`);
  return JSON.parse(stdout.slice(start));
}

const query = async (target, sql) => (await d1Json(target, ['--command', sql]))[0].results;

async function counts(target) {
  const [row] = await query(
    target,
    `SELECT COUNT(*) AS total,
       SUM(CASE WHEN cover_key IS NULL THEN 1 ELSE 0 END) AS no_cover,
       SUM(CASE WHEN description IS NULL OR description = '' THEN 1 ELSE 0 END) AS no_description
     FROM items`,
  );
  return { total: row.total ?? 0, noCover: row.no_cover ?? 0, noDescription: row.no_description ?? 0 };
}

// ---------- export ----------

// Same selection as the in-app backfill (backfillable() in src/db/queries.ts).
const QUEUE_SQL = `SELECT id, media_type, title, creators, isbn13, isbn10_upc, publisher, published, length, cover_key,
  CASE WHEN description IS NULL OR trim(description) = '' THEN 0 ELSE 1 END AS has_description
FROM items WHERE cover_key IS NULL OR description IS NULL OR description = '' ORDER BY id`;

function unappliedHits(target) {
  const p = paths(target);
  const state = readJson(p.state, {});
  return readLines(p.results)
    .slice(state.appliedThrough ?? 0)
    .map((l) => JSON.parse(l))
    .filter(hasPatch).length;
}

async function exportQueue(target, flags) {
  const p = paths(target);
  if (existsSync(target.dir)) {
    const pending = unappliedHits(target);
    if (pending && !flags.discard) {
      fail(`${pending} ${pending === 1 ? 'result' : 'results'} from the last run ${pending === 1 ? "hasn't" : "haven't"} been applied yet. Run apply first, or pass --discard to drop them.`);
    }
    const archive = `${ROOT}/archive/${target.label}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    mkdirSync(`${ROOT}/archive`, { recursive: true });
    renameSync(target.dir, archive);
    console.log(`Previous run moved to ${archive}`);
  }
  mkdirSync(p.covers, { recursive: true });

  const queue = await query(target, QUEUE_SQL);
  writeFileSync(p.queue, JSON.stringify(queue));
  writeFileSync(p.state, JSON.stringify({ exportedAt: new Date().toISOString(), queueSize: queue.length, appliedThrough: 0 }));

  const noCover = queue.filter((q) => !q.cover_key).length;
  const noDescription = queue.filter((q) => !q.has_description).length;
  console.log(`Exported ${queue.length} items from ${target.label}: ${noCover} missing a cover, ${noDescription} missing a description.`);
  return queue;
}

// ---------- enrich ----------

function secret(name) {
  if (process.env[name]) return process.env[name].trim();
  if (!existsSync('.dev.vars')) return '';
  const match = readFileSync('.dev.vars', 'utf8').match(new RegExp(`^${name}\\s*=\\s*"?([^"\\n]*)"?`, 'm'));
  return (match?.[1] ?? '').trim();
}

async function loadMetadata() {
  if (process.features?.typescript !== 'strip' && process.features?.typescript !== 'transform') {
    fail(`This needs Node 22.18 or newer, which runs TypeScript natively (this is ${process.version}).`);
  }
  register(new URL('./ts-resolve.mjs', import.meta.url));
  const [metadata, env] = await Promise.all([import('../src/metadata/index.ts'), import('../src/env.ts')]);
  return { findCover: metadata.findCover, findDescription: metadata.findDescription, fetchWithTimeout: env.fetchWithTimeout, USER_AGENT: env.USER_AGENT };
}

const GOOGLE_BOOKS = 'www.googleapis.com';
const OPEN_LIBRARY = 'openlibrary.org';
const FAILURES_BEFORE_STOPPING = 15;

/**
 * Wraps global fetch — which the app's providers call — with what a bulk run from one IP needs:
 *  - per-host pacing. Open Library has no published quota, but refused connections outright after a burst
 *    of 14 concurrent workers; it gets `rps`, other hosts a steadier 4/s.
 *  - a fresh deadline once a request's turn comes. The app arms a 6 s timeout before calling fetch; waiting
 *    for a slot inside that window made queued requests abort, and providers report an abort as "not found".
 *  - a breaker for Google Books' daily quota (1,000 queries): once it answers 429, retrying is pure delay.
 *  - a stop when one host fails repeatedly, rather than recording false misses. Counted per host, so a
 *    healthy iTunes can't mask a failing Open Library.
 */
function instrumentFetch({ rps }) {
  const realFetch = globalThis.fetch;
  const health = { stats: new Map(), stopReason: null, googleBooksExhausted: false };
  const slots = new Map();
  const failures = new Map();
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const bump = (host, what) => {
    const s = health.stats.get(host) ?? { ok: 0, notFound: 0, limited: 0, failed: 0, skipped: 0 };
    s[what]++;
    health.stats.set(host, s);
  };
  const noteFailure = (host, why) => {
    const n = (failures.get(host) ?? 0) + 1;
    failures.set(host, n);
    if (n >= FAILURES_BEFORE_STOPPING) health.stopReason ??= `${n} consecutive failures from ${host} (${why})`;
  };
  const waitForSlot = async (host) => {
    const gap = 1000 / (host === OPEN_LIBRARY ? rps : 4);
    const now = Date.now();
    const at = Math.max(now, slots.get(host) ?? 0);
    slots.set(host, at + gap);
    if (at > now) await sleep(at - now);
  };

  globalThis.fetch = async (input, init = {}) => {
    const host = new URL(input instanceof Request ? input.url : String(input)).host;
    if (host === GOOGLE_BOOKS && health.googleBooksExhausted) {
      bump(host, 'skipped');
      return new Response('{}', { status: 429, headers: { 'content-type': 'application/json' } });
    }
    for (let attempt = 0; ; attempt++) {
      try {
        await waitForSlot(host);
        const res = await realFetch(input, { ...init, signal: AbortSignal.timeout(25_000) });
        if (res.status === 429 && host === GOOGLE_BOOKS) {
          if (!health.googleBooksExhausted) console.log('  ! Google Books quota exhausted — skipping it from here on');
          health.googleBooksExhausted = true;
          bump(host, 'limited');
          return res;
        }
        if ((res.status === 429 || res.status === 503) && attempt < 2) {
          bump(host, 'limited');
          await sleep(2000 * (attempt + 1));
          continue;
        }
        bump(host, res.ok ? 'ok' : res.status === 404 ? 'notFound' : 'failed');
        if (res.ok || res.status === 404) failures.set(host, 0);
        else noteFailure(host, `HTTP ${res.status}`);
        return res;
      } catch (err) {
        if (attempt < 2) {
          await sleep(1000 * (attempt + 1));
          continue;
        }
        bump(host, 'failed');
        noteFailure(host, String(err?.message ?? err).slice(0, 60));
        throw err;
      }
    }
  };
  return { health, realFetch };
}

async function preflight(realFetch, googleBooksKey) {
  const ol = await realFetch('https://openlibrary.org/search.json?q=title%3A%22Hamlet%22&fields=key&limit=1', {
    signal: AbortSignal.timeout(25_000),
  }).catch(() => null);
  if (!ol?.ok) {
    fail('Open Library is not answering from this machine right now, so nothing was looked up (and nothing recorded as a miss). Try again later.');
  }
  if (!googleBooksKey) return 'no key';
  const gb = await realFetch(`https://www.googleapis.com/books/v1/volumes?q=isbn:9780141439471&maxResults=1&key=${googleBooksKey}`, {
    signal: AbortSignal.timeout(25_000),
  }).catch(() => null);
  if (gb?.status === 429) return 'exhausted';
  return gb?.ok ? 'available' : `unavailable (${gb ? `HTTP ${gb.status}` : 'no answer'})`;
}

async function enrich(target, flags) {
  const p = paths(target);
  if (!existsSync(p.queue)) fail('Nothing exported yet — run export first.');
  const concurrency = positiveInt(flags.concurrency, 'concurrency', 3);
  const rps = positiveInt(flags.rps, 'rps', 1);
  const limit = positiveInt(flags.limit, 'limit', Infinity);
  const requireGoogleBooks = Boolean(flags['require-google-books']);

  const M = await loadMetadata();
  const env = { GOOGLE_BOOKS_KEY: secret('GOOGLE_BOOKS_KEY'), DISCOGS_TOKEN: secret('DISCOGS_TOKEN') };
  const { health, realFetch } = instrumentFetch({ rps });

  const googleBooks = await preflight(realFetch, env.GOOGLE_BOOKS_KEY);
  console.log(`Open Library: answering · Google Books: ${googleBooks}`);
  if (googleBooks === 'exhausted') {
    health.googleBooksExhausted = true;
    if (requireGoogleBooks) {
      fail('Google Books has no quota left today (it resets at midnight Pacific), and --require-google-books was given. Nothing was looked up.');
    }
    console.log('  Continuing with Open Library and iTunes only. Covers mostly come from Google Books, so expect few.');
  }
  if (googleBooks === 'no key') console.log('  No GOOGLE_BOOKS_KEY in the environment or .dev.vars — the keyless quota is shared and small.');

  const queue = readJson(p.queue, []);
  const latest = new Map(latestResults(target).map((r) => [r.id, r]));
  let pending = flags['retry-misses']
    ? queue.filter((item) => latest.has(item.id) && !hasPatch(latest.get(item.id)))
    : queue.filter((item) => !latest.has(item.id));
  if (flags.sample) {
    // every Nth item, so a sample reflects the whole queue rather than its oldest corner
    const step = Math.max(1, Math.floor(pending.length / positiveInt(flags.sample, 'sample')));
    pending = pending.filter((_, n) => n % step === 0).slice(0, positiveInt(flags.sample, 'sample'));
  }
  const todo = pending.slice(0, limit);
  console.log(`Queue ${queue.length} · already looked up ${latest.size} · this run ${todo.length} · ${concurrency} at a time`);
  if (!todo.length) return;

  const contentTypes = new Map();
  async function storeCoverLocally(url) {
    // mirrors storeCover() in src/lib/covers.ts, but to disk — the upload step puts it in R2
    if (!url || !/^https?:\/\//.test(url)) return null;
    try {
      const res = await M.fetchWithTimeout(url, { headers: { 'User-Agent': M.USER_AGENT } });
      if (!res.ok) return null;
      const contentType = res.headers.get('content-type') ?? 'image/jpeg';
      if (!contentType.startsWith('image/')) return null;
      const body = Buffer.from(await res.arrayBuffer());
      if (body.byteLength < 500 || body.byteLength > 5 * 1024 * 1024) return null;
      const key = randomUUID();
      writeFileSync(`${p.covers}/${key}`, body);
      contentTypes.set(key, contentType);
      return key;
    } catch {
      return null;
    }
  }

  // mirrors the patch rules in POST /api/backfill-covers (src/routes/importexport.tsx)
  async function lookUp(item) {
    const needsCover = !item.cover_key;
    const result = await M.findCover(
      env,
      { barcode: item.isbn13 ?? item.isbn10_upc, title: item.title, creators: item.creators, mediaType: item.media_type },
      needsCover ? storeCoverLocally : async () => null,
    );
    const patch = {};
    if (needsCover && result?.key) patch.cover_key = result.key;
    const match = result?.candidate;
    if (match) {
      if (!item.has_description && match.description) patch.description = match.description;
      if (!item.publisher?.trim() && match.publisher) patch.publisher = match.publisher;
      if (!item.published?.trim() && match.published) patch.published = String(match.published);
      if (item.length === null && match.length) patch.length = match.length;
    }
    if (!patch.description && !item.has_description) {
      const fromWork = await M.findDescription(match ?? null);
      if (fromWork) patch.description = fromWork;
    }
    return {
      id: item.id,
      title: item.title,
      patch,
      method: result?.method ?? null,
      contentType: patch.cover_key ? (contentTypes.get(patch.cover_key) ?? 'image/jpeg') : null,
    };
  }

  const tally = { done: 0, covers: 0, details: 0, errors: 0, unrecorded: 0 };
  const started = Date.now();
  let cursor = 0;
  const stopReason = () =>
    interrupted
      ? 'interrupted'
      : health.stopReason ?? (requireGoogleBooks && health.googleBooksExhausted ? 'Google Books quota ran out' : null);

  async function worker() {
    while (cursor < todo.length && !stopReason()) {
      const item = todo[cursor++];
      let out;
      try {
        out = await lookUp(item);
      } catch (err) {
        out = { id: item.id, title: item.title, patch: {}, error: String(err?.message ?? err).slice(0, 200) };
        tally.errors++;
      }
      // An empty answer given while the run was failing is not evidence the book can't be found.
      // Leave it unrecorded so the next run looks again.
      if (!hasPatch(out) && stopReason()) {
        tally.unrecorded++;
        continue;
      }
      if (out.patch.cover_key) tally.covers++;
      if (out.patch.description || out.patch.publisher || out.patch.published || out.patch.length) tally.details++;
      appendFileSync(p.results, `${JSON.stringify(out)}\n`);
      tally.done++;
      if (tally.done % 25 === 0 || tally.done === todo.length) {
        const rate = tally.done / ((Date.now() - started) / 1000);
        const left = Math.round((todo.length - tally.done) / rate);
        console.log(
          `  ${tally.done}/${todo.length}  covers ${tally.covers}  details ${tally.details}  errors ${tally.errors}` +
            `  ~${Math.floor(left / 60)}m${String(left % 60).padStart(2, '0')}s left`,
        );
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));

  console.log('\nRequests by provider:');
  for (const [host, s] of [...health.stats].sort((a, b) => b[1].ok - a[1].ok)) {
    console.log(`  ${host.padEnd(24)} ok ${String(s.ok).padStart(5)}  404 ${String(s.notFound).padStart(4)}  retried ${s.limited}  failed ${s.failed}  skipped ${s.skipped}`);
  }
  console.log(`\nLooked up ${tally.done}: ${tally.covers} covers, ${tally.details} with details, ${tally.errors} errors.`);
  const reason = stopReason();
  if (reason) {
    console.log(`Stopped early: ${reason}. ${tally.unrecorded} answers given during the failure were not recorded, so they'll be looked up again next run.`);
    process.exitCode = 1;
  }
}

// ---------- upload ----------

async function upload(target, flags) {
  const p = paths(target);
  // Local storage is a SQLite file that takes one writer at a time; the real bucket takes several.
  const concurrency = target.label === 'production' ? positiveInt(flags.concurrency, 'concurrency', 4) : 1;
  const done = new Set(readLines(p.uploaded));
  const todo = latestResults(target)
    .filter((r) => r.patch?.cover_key && !done.has(r.patch.cover_key))
    .filter((r) => existsSync(`${p.covers}/${r.patch.cover_key}`));
  console.log(`Covers to upload: ${todo.length} (${done.size} already in the bucket)`);

  const failed = [];
  let cursor = 0;
  async function worker() {
    while (cursor < todo.length && !interrupted) {
      const r = todo[cursor++];
      const key = r.patch.cover_key;
      const args = ['r2', 'object', 'put', `${BUCKET}/${key}`, '--file', `${p.covers}/${key}`, '--content-type', r.contentType ?? 'image/jpeg', ...target.r2];
      try {
        await wrangler(args).catch(() => wrangler(args)); // one retry: a single put failing is usually transient
        appendFileSync(p.uploaded, `${key}\n`); // only after the put succeeded — apply trusts this list
      } catch (err) {
        failed.push({ id: r.id, title: r.title, error: String(err.message).replace(/\s+/g, ' ').slice(0, 240) });
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  console.log(`Uploaded ${todo.length - failed.length}, failed ${failed.length}.`);
  for (const f of failed) console.log(`  #${f.id} ${String(f.title).slice(0, 40)} — ${f.error}`);
  if (failed.length) {
    console.log('Items whose cover failed to upload get no cover_key from apply. Run upload again to retry them.');
    process.exitCode = 1;
  }
}

// ---------- apply ----------

// Text goes in as CAST(X'<hex>' AS TEXT), never as a quoted literal: descriptions carry apostrophes,
// semicolons and non-ASCII, and wrangler splits a SQL file on semicolons. Hex has none of those.
const text = (value) => `CAST(X'${Buffer.from(String(value), 'utf8').toString('hex')}' AS TEXT)`;
const stamp = "updated_at = datetime('now')";

function buildStatements(target) {
  const uploaded = new Set(readLines(paths(target).uploaded));
  const statements = [];
  const tally = { cover: 0, description: 0, publisher: 0, published: 0, length: 0, coverNotUploaded: 0 };
  for (const r of latestResults(target)) {
    const p = r.patch ?? {};
    const id = Number(r.id);
    if (p.cover_key && !uploaded.has(p.cover_key)) tally.coverNotUploaded++;
    // only ever point at a cover that is actually in the bucket
    if (p.cover_key && uploaded.has(p.cover_key)) {
      if (!/^[0-9a-f-]{36}$/.test(p.cover_key)) throw new Error(`Unexpected cover key for #${id}: ${p.cover_key}`);
      statements.push(`UPDATE items SET cover_key = '${p.cover_key}', ${stamp} WHERE id = ${id} AND cover_key IS NULL;`);
      tally.cover++;
    }
    if (p.description) {
      statements.push(`UPDATE items SET description = ${text(p.description)}, ${stamp} WHERE id = ${id} AND (description IS NULL OR trim(description) = '');`);
      tally.description++;
    }
    if (p.publisher) {
      statements.push(`UPDATE items SET publisher = ${text(p.publisher)}, ${stamp} WHERE id = ${id} AND (publisher IS NULL OR trim(publisher) = '');`);
      tally.publisher++;
    }
    if (p.published) {
      statements.push(`UPDATE items SET published = ${text(p.published)}, ${stamp} WHERE id = ${id} AND (published IS NULL OR trim(published) = '');`);
      tally.published++;
    }
    if (p.length && Number.isInteger(Number(p.length))) {
      statements.push(`UPDATE items SET length = ${Number(p.length)}, ${stamp} WHERE id = ${id} AND length IS NULL;`);
      tally.length++;
    }
  }
  return { statements, tally };
}

function recentBackup() {
  if (!existsSync('backups')) return null;
  const candidates = readdirSync('backups')
    .filter((d) => d.startsWith('remote-'))
    .map((d) => `backups/${d}/items.sql`)
    .filter((f) => existsSync(f))
    .map((f) => ({ file: f, ageHours: (Date.now() - statSync(f).mtimeMs) / 3_600_000 }))
    .sort((a, b) => a.ageHours - b.ageHours);
  return candidates[0] ?? null;
}

const describeCounts = (c) => `${c.noCover} missing a cover, ${c.noDescription} missing a description (of ${c.total})`;

async function apply(target) {
  const p = paths(target);
  if (target.label === 'production') {
    // runbooks/backup-and-restore.md: hand-run writes to production need a fresh backup first
    const backup = recentBackup();
    if (!backup || backup.ageHours > BACKUP_MAX_AGE_HOURS) {
      fail(`Take a backup first — npm run backup. (${backup ? `The newest is ${backup.ageHours.toFixed(1)} hours old.` : 'None found.'})`);
    }
    console.log(`Backup: ${backup.file}, ${backup.ageHours.toFixed(1)} hours old`);
  }

  const resultLines = readLines(p.results).length;
  const { statements, tally } = buildStatements(target);
  console.log(
    `Statements: ${statements.length} — ${tally.cover} covers, ${tally.description} descriptions, ` +
      `${tally.publisher + tally.published + tally.length} other fields`,
  );
  if (tally.coverNotUploaded) console.log(`  ${tally.coverNotUploaded} covers left out because they aren't in the bucket — run upload.`);
  if (!statements.length) return;

  rmSync(p.sql, { recursive: true, force: true });
  mkdirSync(p.sql, { recursive: true });
  const files = [];
  for (let i = 0; i < statements.length; i += SQL_BATCH) {
    const body = `${statements.slice(i, i + SQL_BATCH).join('\n')}\n`;
    const file = `${p.sql}/${String(files.length).padStart(3, '0')}.sql`;
    writeFileSync(file, body);
    files.push({ file, hash: createHash('sha256').update(body).digest('hex') });
  }

  const before = await counts(target);
  console.log(`Before: ${describeCounts(before)}`);

  // Progress is recorded by content, not file name: files are rebuilt on every run.
  const applied = new Set(readLines(p.applied));
  for (const { file, hash } of files) {
    if (interrupted) break;
    if (applied.has(hash)) {
      console.log(`  ${file.split('/').pop()}  already applied`);
      continue;
    }
    const results = await d1Json(target, ['--file', file]);
    // a wrangler run can exit cleanly having done nothing, so judge it by what D1 reports
    const reported = results.every((r) => r?.success !== false && r?.meta);
    if (!reported) throw new Error(`D1 gave no result for ${file}; stopping. Nothing after it was applied.`);
    appendFileSync(p.applied, `${hash}\n`);
    const written = results.map((r) => r.meta.rows_written).filter((n) => typeof n === 'number');
    console.log(`  ${file.split('/').pop()}  applied${written.length ? ` — ${written.reduce((a, b) => a + b, 0)} rows written` : ''}`);
  }

  const after = await counts(target);
  console.log(`After:  ${describeCounts(after)}`);
  console.log(`Filled: ${before.noCover - after.noCover} covers, ${before.noDescription - after.noDescription} descriptions`);
  if (!interrupted) {
    const state = readJson(p.state, {});
    writeFileSync(p.state, JSON.stringify({ ...state, appliedThrough: resultLines, appliedAt: new Date().toISOString() }));
  }
}

// ---------- status ----------

async function status(target, flags) {
  const p = paths(target);
  const state = readJson(p.state, null);
  if (!state) {
    console.log(`No ${target.label} run yet — start with export.`);
  } else {
    const results = latestResults(target);
    const hits = results.filter(hasPatch);
    console.log(`Exported ${state.exportedAt}: ${state.queueSize} items`);
    console.log(`Looked up ${results.length} (${state.queueSize - results.length} to go): ${hits.length} with something to fill`);
    console.log(`  covers ${hits.filter((r) => r.patch.cover_key).length} (${readLines(p.uploaded).length} uploaded)`);
    console.log(`  descriptions ${hits.filter((r) => r.patch.description).length}`);
    console.log(`  misses ${results.length - hits.length}, errors ${results.filter((r) => r.error).length}`);
    const pending = unappliedHits(target);
    console.log(pending ? `Not yet applied: ${pending} results` : `Applied: ${state.appliedAt ?? 'nothing yet'}`);
  }
  if (!flags.offline) console.log(`Live now: ${describeCounts(await counts(target))}`);
}

// ---------- rehearse ----------

/** A digest of every field apply can touch, updated_at included — any real write changes it. */
async function fingerprint(target) {
  const [row] = await query(
    target,
    `SELECT group_concat(id || '|' || coalesce(cover_key, '') || '|' || coalesce(description, '') || '|' ||
       coalesce(publisher, '') || '|' || coalesce(published, '') || '|' || coalesce(length, '') || '|' || updated_at,
       char(10)) AS rows FROM (SELECT * FROM items ORDER BY id)`,
  );
  return createHash('sha256').update(row.rows ?? '').digest('hex');
}

// A realistic spread: an ISBN hit, a title-only rescue, a description from an Open Library work record,
// an item that already has a cover, one no provider carries, and one edited by hand after the export.
const REHEARSAL_BOOKS = [
  { id: 1, title: 'Things Fall Apart', creators: 'Chinua Achebe', isbn13: '9780385474542' },
  { id: 2, title: 'Frankenstein', creators: 'Mary Wollstonecraft Shelley' },
  { id: 3, title: 'The Left Hand of Darkness', creators: 'Ursula K. Le Guin' },
  { id: 4, title: 'A Room with a View', creators: 'E. M. Forster', cover: 'rehearsal-cover-already-set' },
  { id: 5, title: 'Avani Sundari Katha Sara', creators: 'Dandin' },
  { id: 6, title: 'The Time Machine', creators: 'H.G. Wells' },
];
const EDITED_ID = 6;
const HAND_WRITTEN = 'Written by hand after the export, so the backfill must leave it alone.';
const sqlString = (s) => `'${String(s).replace(/'/g, "''")}'`;

async function rehearse() {
  const target = rehearsalTarget();
  rmSync(`${ROOT}/rehearsal`, { recursive: true, force: true });
  mkdirSync(target.state, { recursive: true });

  console.log('— setting up a throwaway database (your dev database is not touched)');
  await wrangler(['d1', 'migrations', 'apply', DATABASE, ...target.d1]);
  const seed = [
    "INSERT INTO libraries (id, name) VALUES (1, 'Rehearsal shelf');",
    ...REHEARSAL_BOOKS.map(
      (b) =>
        `INSERT INTO items (id, library_id, media_type, title, creators, isbn13, cover_key, status, copies, details) VALUES ` +
        `(${b.id}, 1, 'book', ${sqlString(b.title)}, ${sqlString(b.creators)}, ${b.isbn13 ? sqlString(b.isbn13) : 'NULL'}, ` +
        `${b.cover ? sqlString(b.cover) : 'NULL'}, 'completed', 1, '{}');`,
    ),
  ];
  const seedFile = `${ROOT}/rehearsal/seed.sql`;
  writeFileSync(seedFile, `${seed.join('\n')}\n`);
  await d1Json(target, ['--file', seedFile]);

  console.log('\n— export');
  await exportQueue(target, {});

  console.log('\n— enrich (live providers, read-only)');
  await enrich(target, { concurrency: 2 });

  console.log('\n— someone edits a book after the export');
  await query(target, `UPDATE items SET description = ${sqlString(HAND_WRITTEN)} WHERE id = ${EDITED_ID}`);

  console.log('\n— upload');
  await upload(target, {});

  console.log('\n— apply');
  await apply(target);

  console.log('\n— checking the result');
  const rows = await query(target, `SELECT id, title, cover_key, description FROM items ORDER BY id`);
  const results = new Map(latestResults(target).map((r) => [r.id, r]));
  const checks = [];
  const check = (ok, label) => {
    checks.push(ok);
    console.log(`  ${ok ? '✓' : '✗'} ${label}`);
  };

  console.log('');
  for (const row of rows) {
    const seeded = REHEARSAL_BOOKS.find((b) => b.id === row.id);
    const cover = seeded.cover ? 'kept' : row.cover_key ? 'added' : '—';
    const desc = row.id === EDITED_ID ? 'hand-written' : row.description ? `added (${row.description.length} chars)` : '—';
    console.log(`  ${row.title.padEnd(28)} cover ${cover.padEnd(6)} description ${desc}`);
  }
  console.log('');

  for (const row of rows.filter((r) => r.cover_key && !r.cover_key.startsWith('rehearsal-'))) {
    const local = readFileSync(`${paths(target).covers}/${row.cover_key}`);
    const fetched = `${ROOT}/rehearsal/check-${row.cover_key}`;
    await wrangler(['r2', 'object', 'get', `${BUCKET}/${row.cover_key}`, '--file', fetched, ...target.r2]);
    check(readFileSync(fetched).equals(local), `${row.title}: its cover is in the bucket, byte for byte`);
  }
  check(rows.find((r) => r.id === 4).cover_key === 'rehearsal-cover-already-set', 'A cover that was already set is untouched');

  // Only meaningful if the lookup found a description to write over the edit.
  const edited = rows.find((r) => r.id === EDITED_ID);
  if (results.get(EDITED_ID)?.patch?.description) {
    check(edited.description === HAND_WRITTEN, 'An edit made after the export survived the write that would have replaced it');
  } else {
    console.log('  – Edit-survives check not exercised: no description was found for that book this time');
  }

  check(
    rows.filter((r) => r.description && r.id !== EDITED_ID).every((r) => !/\]\[\d+\]|^\s*>|<[a-z/]/im.test(r.description)),
    'Descriptions carry no leftover markup',
  );

  const found = [...results.values()].filter(hasPatch);
  const uploaded = new Set(readLines(paths(target).uploaded));
  const coversFound = found.filter((res) => res.patch.cover_key);
  check(
    coversFound.every((res) => uploaded.has(res.patch.cover_key)),
    `Every cover found reached the bucket (${coversFound.filter((res) => uploaded.has(res.patch.cover_key)).length} of ${coversFound.length})`,
  );
  const exact = found.every((res) => {
    const row = rows.find((r) => r.id === res.id);
    const coverOk = !uploaded.has(res.patch.cover_key) || row.cover_key === res.patch.cover_key;
    const descOk = !res.patch.description || res.id === EDITED_ID || row.description === res.patch.description;
    return coverOk && descOk;
  });
  check(exact, `Every uploaded cover and every description found is in the database exactly as found (${found.length} items)`);

  // Every statement re-checks its blank, so running the same SQL again must change nothing — not even
  // updated_at, which any matching UPDATE would bump. The pause makes a bump visible at second resolution.
  const beforeAgain = await fingerprint(target);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  for (const f of readdirSync(paths(target).sql)) await d1Json(target, ['--file', `${paths(target).sql}/${f}`]);
  check((await fingerprint(target)) === beforeAgain, 'Applying the same SQL a second time changed nothing');

  const passed = checks.every(Boolean);
  console.log(`\n${passed ? 'Rehearsal passed.' : 'Rehearsal FAILED — do not run this against production.'}`);
  console.log(`Everything it created is under ${ROOT}/rehearsal/ — delete it whenever you like.`);
  if (!passed) process.exitCode = 1;
}

// ---------- main ----------

const [command, ...rest] = process.argv.slice(2);
if (!(command in COMMANDS)) {
  fail(
    'Usage: npm run backfill:remote -- <command>\n\n' +
      '  rehearse   try the whole pipeline against a throwaway local database\n' +
      '  export     snapshot what production is missing        [--discard]\n' +
      '  enrich     look it up                                 [--sample N] [--limit N] [--concurrency N]\n' +
      '                                                        [--rps N] [--require-google-books] [--retry-misses]\n' +
      '  upload     put the covers found into R2               [--concurrency N]\n' +
      '  apply      fill the blanks in production\n' +
      '  status     where the run stands                       [--offline]\n\n' +
      'The procedure is in runbooks/metadata-backfill.md.',
  );
}
const flags = parseFlags(rest, COMMANDS[command]);

try {
  if (command === 'rehearse') await rehearse();
  else {
    const target = productionTarget();
    if (command === 'export') await exportQueue(target, flags);
    if (command === 'enrich') await enrich(target, flags);
    if (command === 'upload') await upload(target, flags);
    if (command === 'apply') await apply(target);
    if (command === 'status') await status(target, flags);
  }
} catch (err) {
  console.error(`\n${err.message}`);
  process.exitCode = 1;
} finally {
  if (remoteConfig) removeRemoteConfig(remoteConfig);
}
