# §16 #10 — Backups are per-table, data-only exports (`scripts/backup.mjs`)

**Decided:** 2026-07-11 (production readiness). Cited as `ARCH.md §16 #10`; "§N" is a section of [ARCH.md](../../ARCH.md), "#N" another decision here.

Backups are per-table, data-only exports (`scripts/backup.mjs`): D1 refuses to export
any database containing virtual tables, so a whole-db dump is impossible with FTS5.
Schema restores from migrations; the FTS index rebuilds via triggers on data insert.
Rehearsed end-to-end (315 items, local → scratch instance), and the same procedure
doubles as the local→production data migration (deploy runbook).
