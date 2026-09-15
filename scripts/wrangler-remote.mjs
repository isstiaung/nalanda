// Runs one wrangler command against the production D1 database, which a bare `wrangler … --remote` can't find
// (scripts/remote-config.mjs explains why).
//
//   npm run db:migrate:remote
//   npm run wrangler:remote -- d1 execute nalanda --remote --command "SELECT count(*) FROM items"
import { spawnSync } from 'node:child_process';
import { removeRemoteConfig, writeRemoteConfig } from './remote-config.mjs';

const args = process.argv.slice(2);
if (!args.length) {
  console.error('Usage: npm run wrangler:remote -- <wrangler arguments>');
  process.exit(1);
}

const event = process.env.npm_lifecycle_event;
const usage = event === 'wrangler:remote' ? 'npm run wrangler:remote -- …' : event ? `npm run ${event}` : 'node scripts/wrangler-remote.mjs …';
const config = writeRemoteConfig(usage);

// Ctrl-C reaches wrangler too, which stops. Ignored here so this process outlives it and still deletes the
// config copy.
process.on('SIGINT', () => {});

try {
  const { status } = spawnSync('npx', ['wrangler', ...args, '--config', config], { stdio: 'inherit' });
  process.exitCode = status ?? 130;
} finally {
  removeRemoteConfig();
}
