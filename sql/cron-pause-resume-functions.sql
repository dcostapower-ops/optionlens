-- ═══════════════════════════════════════════════════════════════════
-- Cron Pause/Resume Helper Functions
-- For monitor.html admin pause/resume buttons
-- ═══════════════════════════════════════════════════════════════════

-- ── 1) get_batch_cron_jobs ─────────────────────────────────────────
-- Returns list of cron jobs related to the batch system (jobids that
-- POST to ta-batch or iv-batch). monitor.html captures these schedules
-- before pausing so it can restore them.
CREATE OR REPLACE FUNCTION public.get_batch_cron_jobs()
RETURNS TABLE(jobid bigint, schedule text, command text)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, cron
AS $$
  SELECT jobid, schedule, command
  FROM cron.job
  WHERE command LIKE '%/functions/v1/ta-batch%'
     OR command LIKE '%/functions/v1/iv-batch%';
$$;

-- ── 2) pause_cron_job ──────────────────────────────────────────────
-- Pauses a cron job by setting schedule to a never-fires expression
-- (Feb 31 doesn't exist). Active stays true so the job is "alive but dormant".
CREATE OR REPLACE FUNCTION public.pause_cron_job(p_jobid bigint)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, cron
AS $$
BEGIN
  PERFORM cron.alter_job(p_jobid, schedule := '0 0 31 2 *');
  RETURN 'paused';
END;
$$;

-- ── 3) resume_cron_job ─────────────────────────────────────────────
-- Restores a cron job's schedule to a previous value.
CREATE OR REPLACE FUNCTION public.resume_cron_job(p_jobid bigint, p_schedule text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, cron
AS $$
BEGIN
  PERFORM cron.alter_job(p_jobid, schedule := p_schedule);
  RETURN 'resumed';
END;
$$;

-- ── 4) Grant execute to authenticated users (admin) ────────────────
-- Adjust to match your admin role check pattern
GRANT EXECUTE ON FUNCTION public.get_batch_cron_jobs() TO authenticated;
GRANT EXECUTE ON FUNCTION public.pause_cron_job(bigint) TO authenticated;
GRANT EXECUTE ON FUNCTION public.resume_cron_job(bigint, text) TO authenticated;

-- ── Verification ───────────────────────────────────────────────────
-- After running this script, test with:
--   SELECT * FROM public.get_batch_cron_jobs();
-- Expected: row(s) for jobid=13 schedule='*/2 * * * *' command='SELECT net.http_post(...ta-batch...)'
