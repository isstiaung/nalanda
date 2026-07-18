-- Intentionally a no-op. This file was created empty and recorded as applied
-- before its SQL landed; the real backfill lives in 0004. The statement below
-- exists only because the test harness's migration runner rejects a migration
-- with zero statements — it changes nothing on any database.
UPDATE libraries SET id = id WHERE 1 = 0;
