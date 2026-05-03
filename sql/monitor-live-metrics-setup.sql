-- ═══════════════════════════════════════════════════════════════════
-- Monitor.html Live Metrics — supporting infrastructure
-- ═══════════════════════════════════════════════════════════════════
-- Created: 2026-04-26
-- Purpose: provide the data sources monitor.html needs to show LIVE
--          batch config and metrics instead of hardcoded labels.

-- ── 1) Seed app_config.ta_batch_config ──────────────────────────────
-- Single source of truth for ta-batch config. UPDATE this whenever 
-- we change SLEEP_MS or BATCH_SIZE in ta-batch.ts.
INSERT INTO public.app_config (key, value)
VALUES (
  'ta_batch_config',
  jsonb_build_object(
    'sleep_ms',         70,
    'batch_size',       10,
    'max_runtime_ms',   115000,
    'budget_buffer_ms', 15000,
    'version',          'v31',
    'deployed_at',      '2026-04-25T19:50:00Z',
    'notes',            '70ms sleep, validated via Test 4b on 100 tickers'
  )
)
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;


-- ── 2) Tighten get_batch_cron_jobs — remove command field exposure ──
-- The previous version returned the full cron command which embeds the
-- anon JWT. Replace with a slimmer version that only returns metadata.
CREATE OR REPLACE FUNCTION public.get_batch_cron_jobs()
RETURNS TABLE(jobid bigint, schedule text, active boolean, jobname text)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, cron
AS $$
  SELECT
    jobid,
    schedule,
    active,
    -- Derive a friendly name from the command without exposing the JWT
    CASE
      WHEN command LIKE '%/ta-batch%' AND command LIKE '%mode%full%' THEN 'ta-batch (full)'
      WHEN command LIKE '%/ta-batch%' THEN 'ta-batch'
      WHEN command LIKE '%/iv-batch%' THEN 'iv-batch'
      ELSE 'unknown'
    END AS jobname
  FROM cron.job
  WHERE command LIKE '%/functions/v1/ta-batch%'
     OR command LIKE '%/functions/v1/iv-batch%'
  ORDER BY jobid;
$$;


-- ── 3) NEW: get_recent_cron_runs ────────────────────────────────────
-- Returns the most recent N runs for a cron job, used by monitor.html
-- to show "last fired: HH:MM:SS UTC, status: succeeded".
CREATE OR REPLACE FUNCTION public.get_recent_cron_runs(p_jobid bigint, p_limit integer DEFAULT 5)
RETURNS TABLE(runid bigint, jobid bigint, start_time timestamptz, end_time timestamptz, status text, return_message text)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, cron
AS $$
  SELECT runid, jobid, start_time, end_time, status, return_message
  FROM cron.job_run_details
  WHERE jobid = p_jobid
  ORDER BY start_time DESC
  LIMIT LEAST(p_limit, 50);
$$;


-- ── 4) Grant execute to authenticated and anon ──────────────────────
-- monitor.html may be accessed before login (login screen overlay), so
-- granting to anon is fine — these RPCs only return metadata, no JWTs.
GRANT EXECUTE ON FUNCTION public.get_batch_cron_jobs() TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_recent_cron_runs(bigint, integer) TO anon, authenticated;


-- ── 5) Verification ─────────────────────────────────────────────────
-- After running, test with:
--   SELECT * FROM public.get_batch_cron_jobs();           -- 4 rows, no JWTs
--   SELECT * FROM public.get_recent_cron_runs(13, 5);     -- last 5 runs of ta-batch
--   SELECT value FROM app_config WHERE key='ta_batch_config';
