// Where a backup goes: backups/<kind>-<date>, dated by day. A second backup the same day gets -2, -3… rather
// than writing over the first, which is usually the one taken before a deploy: the one you'd restore.
import { existsSync } from 'node:fs';

export function backupDir(kind, date, exists = existsSync) {
  const base = `backups/${kind}-${date}`;
  let dir = base;
  for (let n = 2; exists(dir); n++) dir = `${base}-${n}`;
  return dir;
}
