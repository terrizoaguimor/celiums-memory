-- 002 — rename router_* tables to atlas_*. ALTER RENAME preserves data + indexes.
-- Apply order: rename indexes/sequences first if they have prefixed names, then tables.
-- Idempotent: re-running after a successful rename is a no-op (IF EXISTS guards
-- on tables; the DO block scans the live catalog so it only renames whatever
-- still has a router_ prefix).

BEGIN;

ALTER TABLE IF EXISTS router_decisions    RENAME TO atlas_decisions;
ALTER TABLE IF EXISTS router_contexts     RENAME TO atlas_contexts;
ALTER TABLE IF EXISTS router_model_stats  RENAME TO atlas_model_stats;

-- If indexes / sequences are router_*, rename them too (otherwise pg keeps the
-- old name internally — harmless but inconsistent).
DO $$
DECLARE
  r       RECORD;
  obj_kind TEXT;
BEGIN
  FOR r IN
    SELECT c.relname AS old_name,
           replace(c.relname, 'router_', 'atlas_') AS new_name,
           c.relkind
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname LIKE 'router_%'
       AND c.relkind IN ('i', 'S')   -- index or sequence
  LOOP
    obj_kind := CASE r.relkind WHEN 'i' THEN 'INDEX' ELSE 'SEQUENCE' END;
    EXECUTE format('ALTER %s %I RENAME TO %I', obj_kind, r.old_name, r.new_name);
  END LOOP;
END $$;

COMMIT;
