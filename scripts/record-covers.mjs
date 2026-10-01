// Replaces the record covers production stored from Discogs with the Cover Art Archive's, or drops them (ARCH.md §16
// #67): a one-off, run from this machine like the metadata backfill. runbooks/record-covers.md is the procedure:
//
//   npm run record-covers:remote -- rehearse   the whole pipeline on a local copy of a backup, with counts and checks
//   npm run record-covers:remote -- export     which production record covers came from Discogs, by the data
//   npm run record-covers:remote -- enrich     look each one up on MusicBrainz and the Cover Art Archive — resumable
//   npm run record-covers:remote -- upload     the archive's covers → R2
//   npm run record-covers:remote -- apply      swap or drop, in batches (wants a backup taken in the last 12 hours)
//   npm run record-covers:remote -- status
//
// Only covers whose provenance the data proves are touched (coverProvenance() in src/lib/record-covers.ts): a record
// added from a Discogs result and never saved since. A cover typed in by hand is kept, and so is any cover the data
// can't place — counted, for the owner. Every UPDATE re-checks the row still holds the cover it had at export, so a
// cover changed since wins. An old object leaves R2 only once its batch has landed and no item points at it.
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { register } from 'node:module';
import { promisify } from 'node:util';
import { DATABASE, removeRemoteConfig, writeRemoteConfig } from './remote-config.mjs';

const execFileAsync = promisify(execFile);
const BUCKET = 'nalanda-covers';
const ROOT = '.record-covers';
const REMOTE_CONFIG = `.wrangler-remote-record-covers-${process.pid}.jsonc`;
const BACKUP_MAX_AGE_HOURS = 12;
/** Statements per D1 call. The R2 objects a batch frees are deleted once that batch is confirmed. */
const SQL_BATCH = 50;
/** The rehearsal's live lookups: MusicBrainz and the archive are asked about this many records at most. */
const REHEARSAL_SAMPLE = 20;

const COMMANDS = {
  rehearse: ['backup', 'offline', 'sample'],
  export: ['discard'],
  enrich: ['sample', 'limit'],
  upload: [],
  apply: [],
  status: ['offline'],
};

// ---------- command line ----------

function fail(message) {
  console.error(message);
  process.exit(1);
}

const NUMBER_FLAGS = new Set(['sample', 'limit']);
const VALUE_FLAGS = new Set(['backup']);

function parseFlags(args, allowed) {
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('--')) fail(`Unexpected argument: ${arg}`);
    const key = arg.slice(2);
    if (!allowed.includes(key)) fail(`Unknown option --${key}. This command takes: ${allowed.map((a) => `--${a}`).join(' ') || 'no options'}`);
    const next = args[i + 1];
    if (NUMBER_FLAGS.has(key) || VALUE_FLAGS.has(key)) {
      if (next === undefined || next.startsWith('--')) fail(`--${key} needs a value after it`);
      flags[key] = next;
      i++;
    } else flags[key] = true;
  }
  return flags;
}

function positiveInt(value, name, fallback) {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) fail(`--${name} needs a positive whole number`);
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
      remoteConfig ??= writeRemoteConfig(`npm run record-covers:remote -- ${process.argv[2] ?? ''}`.trim(), REMOTE_CONFIG);
      return ['--remote', '--config', remoteConfig];
    },
    r2: ['--remote'],
  };
}

function rehearsalTarget() {
  const state = `${ROOT}/rehearsal/wrangler-state`;
  return { label: 'rehearsal', dir: `${ROOT}/rehearsal/run`, state, d1: ['--local', '--persist-to', state], r2: ['--local', '--persist-to', state] };
}

const paths = (target) => ({
  state: `${target.dir}/state.json`,
  queue: `${target.dir}/queue.json`,
  results: `${target.dir}/results.jsonl`,
  covers: `${target.dir}/covers`,
  uploaded: `${target.dir}/uploaded.txt`,
  deleted: `${target.dir}/deleted.txt`,
  sql: `${target.dir}/sql`,
});

const readJson = (file, fallback) => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : fallback);
const readLines = (file) => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : []);

/** The newest answer per item: a second enrich run may answer an item again. */
function latestResults(target) {
  const byId = new Map();
  for (const line of readLines(paths(target).results)) {
    const r = JSON.parse(line);
    byId.set(r.id, r);
  }
  return [...byId.values()];
}

// ---------- the app's own code ----------

async function loadModules() {
  if (process.features?.typescript !== 'strip' && process.features?.typescript !== 'transform') {
    fail(`This needs Node 22.18 or newer, which runs TypeScript natively (this is ${process.version}).`);
  }
  register(new URL('./ts-resolve.mjs', import.meta.url));
  const [musicbrainz, covers, plan, pressing] = await Promise.all([
    import('../src/metadata/musicbrainz.ts'),
    import('../src/lib/covers.ts'),
    import('../src/lib/record-covers.ts'),
    import('../src/lib/pressing.ts'),
  ]);
  return { ...musicbrainz, ...covers, ...plan, recordBarcode: pressing.recordBarcode };
}

// ---------- wrangler ----------

async function wrangler(args) {
  try {
    const { stdout } = await execFileAsync('npx', ['wrangler', ...args], { maxBuffer: 256 * 1024 * 1024, timeout: 10 * 60 * 1000 });
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

/** Every record cover, with its provenance worked out. */
async function classified(target, M) {
  return (await query(target, M.RECORD_COVERS_SQL)).map((row) => ({ ...row, ...M.coverProvenance(row) }));
}

function tally(rows) {
  const t = { total: rows.length, discogs: 0, user: 0, unknown: 0, savedSince: 0, fromConnection: 0 };
  for (const r of rows) {
    t[r.provenance]++;
    if (r.reason === 'saved-since') t.savedSince++;
    if (r.reason === 'from-connection') t.fromConnection++;
  }
  return t;
}

const describeTally = (t) =>
  `${t.total} record ${t.total === 1 ? 'cover' : 'covers'}: ${t.discogs} from Discogs (to replace or drop), ` +
  `${t.user} typed in by hand (kept), ${t.unknown} that can't be placed (kept: ${t.savedSince} saved since added, ` +
  `${t.fromConnection} from a connection)`;

// ---------- export ----------

async function exportQueue(target, flags, M) {
  const p = paths(target);
  if (existsSync(target.dir)) {
    const pending = latestResults(target).length && !readJson(p.state, {}).appliedAt;
    if (pending && !flags.discard) fail('The last run has results that haven\'t been applied. Run apply first, or pass --discard to drop them.');
    const archive = `${ROOT}/archive/${target.label}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    mkdirSync(`${ROOT}/archive`, { recursive: true });
    renameSync(target.dir, archive);
    console.log(`Previous run moved to ${archive}`);
  }
  mkdirSync(p.covers, { recursive: true });
  const rows = await classified(target, M);
  writeFileSync(p.queue, JSON.stringify(rows));
  writeFileSync(p.state, JSON.stringify({ exportedAt: new Date().toISOString(), queueSize: rows.length }));
  console.log(`Exported from ${target.label}: ${describeTally(tally(rows))}.`);
  return rows;
}

// ---------- the network ----------

const familyOf = (host) =>
  host === 'musicbrainz.org' ? 'musicbrainz' : host === 'coverartarchive.org' ? 'coverartarchive' : host === 'archive.org' || host.endsWith('.archive.org') ? 'archive' : null;
const FAILURES_BEFORE_STOPPING = 8;

/**
 * Wraps fetch for the lookups: MusicBrainz, the Cover Art Archive and the Internet Archive one request a second each
 * (MusicBrainz's published limit, kept for all three), a fresh 25 s deadline once a request's turn comes, a retry on
 * 503 (MusicBrainz's "slow down"), and a count of failures — an answer given while a host was failing is not taken as
 * "no cover". Anything else is refused: this run talks to those three hosts and no other.
 */
function pacedFetch() {
  const realFetch = globalThis.fetch;
  const net = { stats: new Map(), failures: 0, consecutive: 0, stopReason: null, requests: 0 };
  const slots = new Map();
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const bump = (family, what) => {
    const s = net.stats.get(family) ?? { ok: 0, redirect: 0, notFound: 0, retried: 0, failed: 0 };
    s[what]++;
    net.stats.set(family, s);
  };
  const failed = (why) => {
    net.failures++;
    net.consecutive++;
    if (net.consecutive >= FAILURES_BEFORE_STOPPING) net.stopReason ??= `${net.consecutive} failures in a row (${why})`;
  };
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const family = familyOf(url.hostname);
    if (!family) throw new Error(`refused: this run doesn't talk to ${url.hostname}`);
    for (let attempt = 0; ; attempt++) {
      const now = Date.now();
      const at = Math.max(now, slots.get(family) ?? 0);
      slots.set(family, at + 1000);
      if (at > now) await sleep(at - now);
      try {
        net.requests++;
        const res = await realFetch(url, { ...init, signal: AbortSignal.timeout(25_000) });
        if ((res.status === 503 || res.status === 429) && attempt < 2) {
          bump(family, 'retried');
          await sleep(2000 * (attempt + 1));
          continue;
        }
        if (res.ok) bump(family, 'ok');
        else if (res.status >= 300 && res.status < 400) bump(family, 'redirect');
        else if (res.status === 404) bump(family, 'notFound');
        else {
          bump(family, 'failed');
          failed(`HTTP ${res.status} from ${url.hostname}`);
          return res;
        }
        net.consecutive = 0;
        return res;
      } catch (err) {
        if (attempt < 2) {
          await sleep(1000 * (attempt + 1));
          continue;
        }
        bump(family, 'failed');
        failed(String(err?.message ?? err).slice(0, 60));
        throw err;
      }
    }
  };
  return net;
}

/**
 * The rehearsal's stand-in for the network, with --offline: MusicBrainz finds a release for any search except one for
 * an artist called "Nobody…", and the archive answers as it does — a 307, a 302, then a JPEG.
 */
function offlineFetch() {
  const net = { stats: new Map(), failures: 0, consecutive: 0, stopReason: null, requests: 0 };
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2000, 7)]);
  globalThis.fetch = async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    net.requests++;
    if (url.hostname === 'musicbrainz.org') {
      const q = url.searchParams.get('query') ?? '';
      const title = /release:"((?:[^"\\]|\\.)*)"/.exec(q)?.[1]?.replace(/\\(.)/g, '$1');
      const artist = /artist:"((?:[^"\\]|\\.)*)"/.exec(q)?.[1]?.replace(/\\(.)/g, '$1');
      const releases =
        title && artist && !artist.startsWith('Nobody')
          ? [{ id: '11111111-2222-4333-8444-555555555555', title, 'artist-credit': [{ name: artist }], 'release-group': { id: '66666666-7777-4888-8999-000000000000', 'primary-type': 'Album' } }]
          : [];
      return new Response(JSON.stringify({ releases }), { headers: { 'content-type': 'application/json' } });
    }
    if (url.hostname === 'coverartarchive.org') return new Response(null, { status: 307, headers: { location: 'https://archive.org/download/mbid-x/front.jpg' } });
    if (url.hostname === 'archive.org') return new Response(null, { status: 302, headers: { location: 'https://ia800000.us.archive.org/0/items/mbid-x/front.jpg' } });
    if (url.hostname.endsWith('.archive.org')) return new Response(jpeg, { headers: { 'content-type': 'image/jpeg' } });
    throw new Error(`refused: this run doesn't talk to ${url.hostname}`);
  };
  return net;
}

// one network for the whole run, however many enrich passes it makes
let network = null;

// ---------- enrich ----------

async function enrich(target, flags, M) {
  const p = paths(target);
  if (!existsSync(p.queue)) fail('Nothing exported yet — run export first.');
  const queue = readJson(p.queue, []);
  const answered = new Set(latestResults(target).map((r) => r.id));
  let todo = queue.filter((r) => r.provenance === 'discogs' && !answered.has(r.id) && (!flags.ids || flags.ids.includes(r.id)));
  if (flags.sample) {
    // every Nth record, so a sample reflects the whole queue rather than its oldest corner
    const n = positiveInt(flags.sample, 'sample');
    const step = Math.max(1, Math.floor(todo.length / n));
    todo = todo.filter((_, i) => i % step === 0).slice(0, n);
  }
  todo = todo.slice(0, positiveInt(flags.limit, 'limit', Infinity));
  console.log(`From Discogs: ${queue.filter((r) => r.provenance === 'discogs').length} · already looked up ${answered.size} · this run ${todo.length}`);
  if (!todo.length) return { looked: 0 };

  network ??= flags.offline ? offlineFetch() : pacedFetch();
  const net = network;
  const contentTypes = new Map();
  const storeLocally = async (url) => {
    // fetchCover() is the app's own: http(s) only, never Discogs, the archive's redirects only to its hosts, raster only
    const got = await M.fetchCover(url);
    if (!got) return null;
    const key = randomUUID();
    writeFileSync(`${p.covers}/${key}`, Buffer.from(got.body));
    contentTypes.set(key, got.contentType);
    return key;
  };

  const counts = { replaced: 0, dropped: 0, unrecorded: 0 };
  for (const row of todo) {
    if (interrupted || net.stopReason) break;
    const failuresBefore = net.failures;
    const details = (() => {
      try {
        return JSON.parse(row.details ?? '{}') ?? {};
      } catch {
        return {};
      }
    })();
    const found = await M.recordCover(
      { barcode: M.recordBarcode({ isbn13: row.isbn13, isbn10Upc: row.isbn10_upc }), musicbrainzId: details.musicbrainz_id, title: row.title, creators: row.creators },
      storeLocally,
    );
    const label = `#${row.id} ${row.title}${row.creators ? ` — ${row.creators}` : ''}`;
    // "no cover" said while a request was failing isn't an answer: looked up again next run, and nothing is dropped
    if (!found.key && net.failures > failuresBefore) {
      counts.unrecorded++;
      console.log(`  ? ${label}: a request failed, so not recorded — the next run asks again`);
      continue;
    }
    const match = found.match ? `${found.match.credit} — ${found.match.title} (${found.via}, release ${found.match.release})` : null;
    console.log(
      found.key
        ? `  ✓ ${label}: the archive's cover, via ${match}`
        : `  – ${label}: ${match ? `matched ${match}, but the archive has no front cover for it` : 'no confident MusicBrainz match'} — the cover will be dropped`,
    );
    appendFileSync(
      p.results,
      `${JSON.stringify({ id: row.id, addedAt: row.added_at, title: row.title, oldKey: row.cover_key, newKey: found.key, via: found.via, match: found.match, contentType: found.key ? contentTypes.get(found.key) : null })}\n`,
    );
    if (found.key) counts.replaced++;
    else counts.dropped++;
  }

  console.log(`Requests so far: ${net.requests}`);
  for (const [family, s] of net.stats) {
    console.log(`  ${family.padEnd(16)} ok ${s.ok}  redirects ${s.redirect}  404 ${s.notFound}  retried ${s.retried}  failed ${s.failed}`);
  }
  console.log(`Looked up ${counts.replaced + counts.dropped}: ${counts.replaced} replaced by the archive's cover, ${counts.dropped} to drop, ${counts.unrecorded} not recorded.`);
  if (net.stopReason) {
    console.log(`Stopped early: ${net.stopReason}.`);
    process.exitCode = 1;
  }
  return { looked: counts.replaced + counts.dropped, requests: net.requests, unrecorded: counts.unrecorded };
}

// ---------- upload ----------

async function upload(target) {
  const p = paths(target);
  const done = new Set(readLines(p.uploaded));
  const todo = latestResults(target).filter((r) => r.newKey && !done.has(r.newKey) && existsSync(`${p.covers}/${r.newKey}`));
  console.log(`Covers to upload: ${todo.length} (${done.size} already in the bucket)`);
  const failed = [];
  for (const r of todo) {
    if (interrupted) break;
    const args = ['r2', 'object', 'put', `${BUCKET}/${r.newKey}`, '--file', `${p.covers}/${r.newKey}`, '--content-type', r.contentType ?? 'image/jpeg', ...target.r2];
    try {
      await wrangler(args).catch(() => wrangler(args)); // one retry: a single put failing is usually transient
      appendFileSync(p.uploaded, `${r.newKey}\n`); // only after the put succeeded — apply trusts this list
    } catch (err) {
      failed.push(`#${r.id} ${r.title}: ${String(err.message).replace(/\s+/g, ' ').slice(0, 200)}`);
    }
  }
  console.log(`Uploaded ${todo.length - failed.length}, failed ${failed.length}.`);
  for (const f of failed) console.log(`  ${f}`);
  if (failed.length) {
    console.log('A record whose cover failed to upload is left as it is by apply. Run upload again.');
    process.exitCode = 1;
  }
}

// ---------- apply ----------

function recentBackup() {
  if (!existsSync('backups')) return null;
  return (
    readdirSync('backups')
      .filter((d) => d.startsWith('remote-'))
      .map((d) => `backups/${d}/items.sql`)
      .filter((f) => existsSync(f))
      .map((f) => ({ file: f, ageHours: (Date.now() - statSync(f).mtimeMs) / 3_600_000 }))
      .sort((a, b) => a.ageHours - b.ageHours)[0] ?? null
  );
}

/** Whether a backup's items file is whole: it ends on a complete statement and holds nearly every item there is now. */
function backupLooksComplete(file, liveTotal) {
  const lines = readFileSync(file, 'utf8').split('\n').filter((l) => l.trim());
  const rows = lines.filter((l) => l.startsWith('INSERT INTO')).length;
  const endsWhole = !lines.length || lines.at(-1).trimEnd().endsWith(';');
  return { ok: endsWhole && rows >= Math.floor(liveTotal * 0.98), rows, endsWhole };
}

/** What apply will do: a replacement for every answer whose new cover is in the bucket, a drop for every "none". */
function plannedReplacements(target) {
  const p = paths(target);
  const uploaded = new Set(readLines(p.uploaded));
  const deleted = new Set(readLines(p.deleted));
  const replacements = [];
  let waiting = 0;
  for (const r of latestResults(target)) {
    if (r.newKey && deleted.has(r.newKey)) continue; // its row had changed: settled by an earlier apply, nothing to do
    if (r.newKey && !uploaded.has(r.newKey)) {
      waiting++;
      continue;
    }
    replacements.push({ id: Number(r.id), addedAt: r.addedAt, oldKey: r.oldKey, newKey: r.newKey ?? null });
  }
  return { replacements, waiting };
}

async function deleteObject(target, key) {
  const args = ['r2', 'object', 'delete', `${BUCKET}/${key}`, ...target.r2];
  await wrangler(args).catch(() => wrangler(args));
}

async function apply(target, M) {
  const p = paths(target);
  if (target.label === 'production') {
    // runbooks/backup-and-restore.md: hand-run writes to production need a fresh backup first
    const backup = recentBackup();
    if (!backup || backup.ageHours > BACKUP_MAX_AGE_HOURS) {
      fail(`Take a backup first — npm run backup. (${backup ? `The newest is ${backup.ageHours.toFixed(1)} hours old.` : 'None found.'})`);
    }
    const [{ total }] = await query(target, 'SELECT COUNT(*) AS total FROM items');
    const whole = backupLooksComplete(backup.file, total);
    if (!whole.ok) {
      fail(`The newest backup looks incomplete (${whole.rows} items${whole.endsWhole ? '' : ', cut off mid-statement'}). Take a fresh one — npm run backup — and apply again.`);
    }
    console.log(`Backup: ${backup.file}, ${backup.ageHours.toFixed(1)} hours old, ${whole.rows} items`);
  }

  const { replacements, waiting } = plannedReplacements(target);
  const swaps = replacements.filter((r) => r.newKey).length;
  console.log(`Planned: ${swaps} covers replaced by the archive's, ${replacements.length - swaps} dropped, in batches of ${SQL_BATCH}.`);
  if (waiting) console.log(`  ${waiting} left out: their new cover isn't in the bucket — run upload, then apply again.`);
  if (!replacements.length) return { landed: 0, skipped: 0, freed: 0 };

  rmSync(p.sql, { recursive: true, force: true });
  mkdirSync(p.sql, { recursive: true });
  const deleted = new Set(readLines(p.deleted));
  const total = { landed: 0, skipped: 0, freed: 0, written: 0 };
  const batches = M.inBatches(replacements, SQL_BATCH);
  for (const [n, batch] of batches.entries()) {
    if (interrupted) break;
    const body = `${batch.map(M.replacementStatement).join('\n')}\n`;
    const file = `${p.sql}/${String(n).padStart(3, '0')}-${createHash('sha256').update(body).digest('hex').slice(0, 12)}.sql`;
    writeFileSync(file, body);
    // Every statement re-checks its row, so a batch run twice — a retry after a failure — changes nothing twice.
    const results = await d1Json(target, ['--file', file]);
    const reported = results.length > 0 && results.every((r) => r?.success !== false && r?.meta);
    if (!reported) throw new Error(`D1 gave no result for ${file}; stopping. No object of this batch was deleted.`);
    total.written += results.map((r) => r.meta.rows_written).filter((w) => typeof w === 'number').reduce((a, b) => a + b, 0);

    // What landed is read back from the database, not assumed; only then is anything deleted from the bucket.
    const rows = await query(target, M.batchCheckSql(batch));
    const keys = batch.flatMap((r) => (r.newKey ? [r.oldKey, r.newKey] : [r.oldKey]));
    const referenced = new Set((await query(target, M.referencedKeysSql(keys))).map((r) => r.cover_key));
    const outcome = M.settleBatch(batch, rows, referenced);
    let freedNow = 0;
    for (const key of outcome.freed) {
      if (deleted.has(key)) continue;
      await deleteObject(target, key);
      appendFileSync(p.deleted, `${key}\n`);
      deleted.add(key);
      freedNow++;
    }
    for (const r of outcome.skipped) console.log(`  #${r.id} changed since the export — left as it is`);
    total.landed += outcome.landed.length;
    total.skipped += outcome.skipped.length;
    total.freed += freedNow;
    console.log(`  batch ${n + 1}/${batches.length}: ${outcome.landed.length} in place, ${outcome.skipped.length} left as they were, ${freedNow} objects deleted`);
  }
  console.log(`Applied: ${total.landed} records hold the archive's cover or none, ${total.skipped} left as they were, ${total.freed} objects deleted from the bucket.`);
  if (!interrupted && !waiting) writeFileSync(p.state, JSON.stringify({ ...readJson(p.state, {}), appliedAt: new Date().toISOString() }));
  return total;
}

// ---------- status ----------

async function status(target, flags, M) {
  const p = paths(target);
  const state = readJson(p.state, null);
  if (!state) console.log(`No ${target.label} run yet — start with export.`);
  else {
    const queue = readJson(p.queue, []);
    const results = latestResults(target);
    console.log(`Exported ${state.exportedAt}: ${describeTally(tally(queue))}`);
    console.log(`Looked up ${results.length} of ${queue.filter((r) => r.provenance === 'discogs').length}: ${results.filter((r) => r.newKey).length} with the archive's cover, ${results.filter((r) => !r.newKey).length} to drop`);
    console.log(`Uploaded ${readLines(p.uploaded).length} · objects deleted ${readLines(p.deleted).length} · ${state.appliedAt ? `applied ${state.appliedAt}` : 'not applied yet'}`);
  }
  if (!flags.offline) console.log(`Live now: ${describeTally(tally(await classified(target, M)))}`);
}

// ---------- rehearse ----------

// The backup's tables in the order scripts/backup.mjs exports them (TABLES there): references before referrers.
const RESTORE_ORDER = [
  'users', 'libraries', 'shares', 'site_settings', 'series', 'items', 'reads', 'reading_progress', 'reviews', 'plays',
  'reading_goals', 'wants', 'purchase_links', 'tags', 'item_tags', 'loans', 'federation_settings', 'connection_invites',
  'connections', 'connection_views', 'activity_log', 'member_activity', 'feed_subscriptions', 'remote_activities',
  'comments', 'outbox', 'borrow_requests', 'connection_loans', 'borrowed_items', 'recommendations', 'notifications',
];

function newestBackup() {
  if (!existsSync('backups')) return null;
  const dirs = readdirSync('backups').filter((d) => d.startsWith('remote-') && existsSync(`backups/${d}/items.sql`));
  dirs.sort((a, b) => statSync(`backups/${b}/items.sql`).mtimeMs - statSync(`backups/${a}/items.sql`).mtimeMs);
  return dirs[0] ? `backups/${dirs[0]}` : null;
}

// Records added to the copy only, past every real id: one for each way a cover is kept, and one that's edited after
// the export, whose new cover must not land.
const FIXTURE_BASE = 9_000_000;
const sqlString = (s) => `'${String(s).replace(/'/g, "''")}'`;

async function rehearse(flags) {
  const backup = flags.backup ?? newestBackup();
  if (!backup || !existsSync(`${backup}/items.sql`)) fail(`No backup to rehearse on${backup ? ` at ${backup}` : ''} — pass --backup backups/remote-<date>.`);
  const target = rehearsalTarget();
  const M = await loadModules();
  rmSync(`${ROOT}/rehearsal`, { recursive: true, force: true });
  mkdirSync(target.state, { recursive: true });

  console.log(`— restoring ${backup} into a throwaway local database (your dev database is not touched)`);
  await wrangler(['d1', 'migrations', 'apply', DATABASE, ...target.d1]);
  const files = readdirSync(backup).filter((f) => f.endsWith('.sql')).map((f) => f.slice(0, -4));
  const order = [...RESTORE_ORDER.filter((t) => files.includes(t)), ...files.filter((t) => !RESTORE_ORDER.includes(t))];
  for (const table of order) await d1Json(target, ['--file', `${backup}/${table}.sql`]);
  // A restored backup once reached a real household: every peer address points nowhere before anything else runs.
  await query(target, "UPDATE connections SET base_url = 'http://127.0.0.1:9/' || id");

  const users = await query(target, 'SELECT id FROM users ORDER BY id LIMIT 1');
  const shelves = await query(target, 'SELECT id FROM libraries ORDER BY id LIMIT 1');
  const connection = (await query(target, 'SELECT id FROM connections ORDER BY id LIMIT 1'))[0]?.id ?? null;
  const shelf = shelves[0]?.id;
  if (!shelf) fail('The backup has no shelf to put the rehearsal records on.');
  // "Nobody At All Rehearsal Fixture" is an artist no search finds, live or offline: its records' lookups come back empty
  const NOBODY = 'Nobody At All Rehearsal Fixture';
  const fixtures = [
    { id: FIXTURE_BASE + 1, kind: 'typed', title: 'Rehearsal: a cover typed in by hand', details: '{}', saved: false },
    { id: FIXTURE_BASE + 2, kind: 'saved-since', title: 'Rehearsal: added from Discogs, edited since', details: '{"discogs_id":1}', saved: true },
    { id: FIXTURE_BASE + 3, kind: 'nothing-found', title: 'Rehearsal: no cover anywhere', details: '{"discogs_id":2}', saved: false, creators: NOBODY },
    { id: FIXTURE_BASE + 4, kind: 'edited-after-export', title: 'Rehearsal: edited after the export', details: '{"discogs_id":3}', saved: false },
    ...(connection ? [{ id: FIXTURE_BASE + 5, kind: 'from-connection', title: 'Rehearsal: wanted from a connection', details: '{"discogs_id":4}', saved: false }] : []),
  ].map((f) => ({ ...f, coverKey: randomUUID() }));
  const seed = fixtures.map(
    (f) =>
      `INSERT INTO items (id, library_id, media_type, title, creators, cover_key, status, copies, details, added_by, added_at, updated_at) VALUES ` +
      `(${f.id}, ${shelf}, 'vinyl', ${sqlString(f.title)}, ${sqlString(f.creators ?? 'The Rehearsal Band')}, '${f.coverKey}', 'not_started', 1, ` +
      `${sqlString(f.details)}, ${users[0]?.id ?? 'NULL'}, '2026-01-01 00:00:00', '${f.saved ? '2026-02-01 00:00:00' : '2026-01-01 00:00:00'}');`,
  );
  if (connection) {
    seed.push(
      `INSERT INTO recommendations (activity_id, connection_id, incoming, media_type, title, creators, recommender, status, wanted_item_id) VALUES ` +
        `('rehearsal-${randomUUID()}', ${connection}, 1, 'vinyl', 'Rehearsal: wanted from a connection', 'The Rehearsal Band', 'A member', 'wanted', ${FIXTURE_BASE + 5});`,
    );
  }
  const seedFile = `${ROOT}/rehearsal/fixtures.sql`;
  writeFileSync(seedFile, `${seed.join('\n')}\n`);
  await d1Json(target, ['--file', seedFile]);
  const isFixture = (id) => Number(id) > FIXTURE_BASE;

  // Every record cover the copy points at gets an object in the throwaway bucket, so the deletes can be checked.
  const before = await classified(target, M);
  const oldBody = (key) => Buffer.concat([Buffer.from(`rehearsal stand-in for ${key}\n`), Buffer.alloc(1000, 1)]);
  for (const row of before) {
    writeFileSync(`${ROOT}/rehearsal/object`, oldBody(row.cover_key));
    await wrangler(['r2', 'object', 'put', `${BUCKET}/${row.cover_key}`, '--file', `${ROOT}/rehearsal/object`, '--content-type', 'image/jpeg', ...target.r2]);
  }

  console.log('\n— export');
  const queue = await exportQueue(target, {}, M);
  const fromBackup = tally(queue.filter((r) => !isFixture(r.id)));
  console.log(`  of them, the backup's own: ${describeTally(fromBackup)}`);

  console.log(`\n— enrich (${flags.offline ? 'offline: canned answers' : 'live MusicBrainz and Cover Art Archive, read-only'})`);
  // The backup's own records, every Nth of them up to the sample, then the fixtures that need a lookup. A record left
  // out of the sample is never looked up, so apply leaves it as it is.
  const fixtureLookups = fixtures.filter((f) => f.kind === 'nothing-found' || f.kind === 'edited-after-export').map((f) => f.id);
  const sample = Math.max(1, positiveInt(flags.sample, 'sample', REHEARSAL_SAMPLE) - fixtureLookups.length);
  const real = queue.filter((r) => r.provenance === 'discogs' && !isFixture(r.id));
  const step = Math.max(1, Math.floor(real.length / sample));
  const sampledIds = real.filter((_, i) => i % step === 0).slice(0, sample).map((r) => r.id);
  await enrich(target, { offline: flags.offline, ids: sampledIds }, M);
  await enrich(target, { offline: flags.offline, ids: fixtureLookups }, M);
  const results = latestResults(target);
  const realResults = results.filter((r) => !isFixture(r.id));
  const sampled = realResults.length;
  const replaced = realResults.filter((r) => r.newKey).length;
  const dropped = sampled - replaced;

  console.log('\n— someone changes a record\'s cover after the export');
  const edited = fixtures.find((f) => f.kind === 'edited-after-export');
  const editedKey = randomUUID();
  writeFileSync(`${ROOT}/rehearsal/object`, oldBody(editedKey));
  await wrangler(['r2', 'object', 'put', `${BUCKET}/${editedKey}`, '--file', `${ROOT}/rehearsal/object`, '--content-type', 'image/jpeg', ...target.r2]);
  await query(target, `UPDATE items SET cover_key = '${editedKey}', updated_at = datetime('now') WHERE id = ${edited.id}`);

  console.log('\n— upload');
  await upload(target);

  console.log('\n— apply');
  await apply(target, M);

  console.log('\n— checking the result');
  const checks = [];
  const check = (ok, label) => {
    checks.push(ok);
    console.log(`  ${ok ? '✓' : '✗'} ${label}`);
  };
  const exists = async (key) => {
    try {
      await wrangler(['r2', 'object', 'get', `${BUCKET}/${key}`, '--file', `${ROOT}/rehearsal/check`, ...target.r2]);
      return true;
    } catch {
      return false;
    }
  };
  const rowsNow = new Map((await query(target, `SELECT id, cover_key, updated_at FROM items WHERE media_type IN ('vinyl', 'music')`)).map((r) => [r.id, r]));
  for (const r of results.filter((x) => x.id !== edited.id)) {
    const row = rowsNow.get(r.id);
    if (r.newKey) {
      const stored = (await exists(r.newKey)) && readFileSync(`${ROOT}/rehearsal/check`).equals(readFileSync(`${paths(target).covers}/${r.newKey}`));
      check(row?.cover_key === r.newKey && stored, `#${r.id} ${r.title}: the archive's cover, in the bucket byte for byte`);
    } else check(row && row.cover_key === null, `#${r.id} ${r.title}: its Discogs cover dropped, so it shows the placeholder`);
    check(!(await exists(r.oldKey)), `#${r.id}: the old object is gone from the bucket`);
  }
  for (const row of before.filter((x) => x.provenance !== 'discogs')) {
    check(rowsNow.get(row.id)?.cover_key === row.cover_key && (await exists(row.cover_key)), `#${row.id} (${row.reason}): its cover is kept, row and object`);
  }
  const editedResult = results.find((r) => r.id === edited.id);
  check(rowsNow.get(edited.id)?.cover_key === editedKey && (await exists(editedKey)), 'A cover changed after the export is left as it was changed');
  if (editedResult?.newKey) check(!(await exists(editedResult.newKey)), 'The archive cover it would have had is deleted, unused');
  const unlooked = queue.filter((r) => r.provenance === 'discogs' && !results.some((x) => x.id === r.id));
  for (const r of unlooked) check(rowsNow.get(r.id)?.cover_key === r.cover_key, `#${r.id}: not in the sample, untouched`);

  const fingerprint = async () =>
    createHash('sha256')
      .update(JSON.stringify(await query(target, 'SELECT id, cover_key, updated_at FROM items ORDER BY id')))
      .digest('hex');
  const once = await fingerprint();
  await new Promise((resolve) => setTimeout(resolve, 1100)); // a second's pause makes a bumped updated_at visible
  const again = await apply(target, M);
  check((await fingerprint()) === once && again.freed === 0, 'Applying again changes nothing, in the database or the bucket');

  console.log('\nCounts, for the backup alone:');
  console.log(`  record covers                ${fromBackup.total}`);
  console.log(`  from Discogs                 ${fromBackup.discogs}`);
  console.log(`  kept, typed in by hand       ${fromBackup.user}`);
  console.log(`  kept, can't be placed        ${fromBackup.unknown}  (${fromBackup.savedSince} saved since added, ${fromBackup.fromConnection} from a connection)`);
  console.log(`  looked up ${flags.offline ? '(offline)' : '(live)'}           ${sampled} of ${fromBackup.discogs}, in ${network?.requests ?? 0} requests (fixtures included)`);
  console.log(`  the archive replaces         ${replaced}${sampled < fromBackup.discogs && sampled ? `  (≈ ${Math.round((replaced / sampled) * fromBackup.discogs)} of ${fromBackup.discogs}, from the sample)` : ''}`);
  console.log(`  dropped                      ${dropped}${sampled < fromBackup.discogs && sampled ? `  (≈ ${fromBackup.discogs - Math.round((replaced / sampled) * fromBackup.discogs)} of ${fromBackup.discogs})` : ''}`);

  const passed = checks.every(Boolean);
  console.log(`\n${passed ? 'Rehearsal passed.' : 'Rehearsal FAILED — do not run this against production.'}`);
  console.log(`Everything it created is under ${ROOT}/rehearsal/ — delete it whenever you like.`);
  if (!passed) process.exitCode = 1;
}

// ---------- main ----------

const [command, ...rest] = process.argv.slice(2);
if (!(command in COMMANDS)) {
  fail(
    'Usage: npm run record-covers:remote -- <command>\n\n' +
      '  rehearse   the whole pipeline on a local copy of a backup     [--backup DIR] [--offline] [--sample N]\n' +
      '  export     which production record covers came from Discogs  [--discard]\n' +
      '  enrich     look each one up on the Cover Art Archive          [--sample N] [--limit N]\n' +
      '  upload     put the archive\'s covers into R2\n' +
      '  apply      swap or drop them in production, in batches\n' +
      '  status     where the run stands                              [--offline]\n\n' +
      'The procedure is in runbooks/record-covers.md.',
  );
}
const flags = parseFlags(rest, COMMANDS[command]);

try {
  if (command === 'rehearse') await rehearse(flags);
  else {
    const M = await loadModules();
    const target = productionTarget();
    if (command === 'export') await exportQueue(target, flags, M);
    if (command === 'enrich') await enrich(target, flags, M);
    if (command === 'upload') await upload(target);
    if (command === 'apply') await apply(target, M);
    if (command === 'status') await status(target, flags, M);
  }
} catch (err) {
  console.error(`\n${err.message}`);
  process.exitCode = 1;
} finally {
  if (remoteConfig) removeRemoteConfig(remoteConfig);
}
