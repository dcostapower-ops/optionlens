-- ═══════════════════════════════════════════════════════════════════
-- Add updated_at auto-update trigger to ta_cache
-- ═══════════════════════════════════════════════════════════════════
-- This makes ta_cache.updated_at reflect the actual last write time
-- for each row, useful for monitoring/debugging cron-driven batches.
--
-- WITHOUT this trigger, the function's UPSERT only writes the columns
-- it specifies (ticker, trading_date, [ind.key]:val), leaving updated_at
-- frozen at row creation time. That made debugging hard.

-- ── 1) Helper function ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.set_ta_cache_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

-- ── 2) Drop existing trigger if it exists (idempotent re-runs) ────
DROP TRIGGER IF EXISTS ta_cache_set_updated_at ON public.ta_cache;

-- ── 3) Create trigger: fires BEFORE INSERT or UPDATE ──────────────
-- BEFORE so we can modify NEW row inline; covers UPSERTs (which are 
-- INSERT ... ON CONFLICT UPDATE — both paths trigger).
CREATE TRIGGER ta_cache_set_updated_at
BEFORE INSERT OR UPDATE ON public.ta_cache
FOR EACH ROW
EXECUTE FUNCTION public.set_ta_cache_updated_at();

-- ── 4) Verify ─────────────────────────────────────────────────────
-- After running, query:
--   SELECT trigger_name, event_manipulation, action_timing
--   FROM information_schema.triggers
--   WHERE event_object_table = 'ta_cache';
-- Expected: 2 rows (one for INSERT, one for UPDATE), both BEFORE.
