-- ═══════════════════════════════════════════════════════════════════
-- Re-schedule ta-batch-continue at */10 (was */2)
-- Run AFTER ta-batch v23 is deployed and verified working
-- ═══════════════════════════════════════════════════════════════════

-- Step 1: Verify ta-batch-continue is currently NOT scheduled
-- (should return zero rows)
SELECT jobname, schedule FROM cron.job WHERE jobname = 'ta-batch-continue';

-- Step 2: Schedule it at */10 with the same auth pattern as ta-batch-premarket/close
SELECT cron.schedule(
  'ta-batch-continue',
  '*/10 * * * *',
  $$
    SELECT net.http_post(
      url := 'https://hkamukkkkpqhdpcradau.supabase.co/functions/v1/ta-batch',
      body := '{"mode":"auto"}'::jsonb,
      headers := '{"Content-Type":"application/json","Authorization":"Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhrYW11a2tra3BxaGRwY3JhZGF1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQwMDMxMzMsImV4cCI6MjA4OTU3OTEzM30.bvdk2U-oBW5bxF3uGqfdhXIZ8GdeGWmhJzUqPCC8tjY"}'::jsonb
    )
  $$
);

-- Step 3: Verify it's scheduled
SELECT jobname, schedule, active FROM cron.job ORDER BY jobname;
-- Expected to include: ta-batch-continue   */10 * * * *   true
