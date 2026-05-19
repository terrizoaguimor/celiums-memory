-- Rollback for 002 — rename atlas_* tables back to router_*.
-- Use only if you need to roll the deployment back to the old service name.

BEGIN;

ALTER TABLE IF EXISTS atlas_decisions    RENAME TO router_decisions;
ALTER TABLE IF EXISTS atlas_contexts     RENAME TO router_contexts;
ALTER TABLE IF EXISTS atlas_model_stats  RENAME TO router_model_stats;

DO $$
DECLARE
  r       RECORD;
  obj_kind TEXT;
BEGIN
  FOR r IN
    SELECT c.relname AS old_name,
           replace(c.relname, 'atlas_', 'router_') AS new_name,
           c.relkind
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname LIKE 'atlas_%'
       AND c.relkind IN ('i', 'S')
  LOOP
    obj_kind := CASE r.relkind WHEN 'i' THEN 'INDEX' ELSE 'SEQUENCE' END;
    EXECUTE format('ALTER %s %I RENAME TO %I', obj_kind, r.old_name, r.new_name);
  END LOOP;
END $$;

COMMIT;
