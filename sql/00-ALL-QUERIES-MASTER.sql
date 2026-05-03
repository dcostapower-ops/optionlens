-- ═══════════════════════════════════════════════════════════════════════════
-- STOCKVIZOR — MASTER SQL REFERENCE
-- All database queries needed for the project in logical order
-- Generated: 2026-05-03
-- ═══════════════════════════════════════════════════════════════════════════


-- ═══════════════════════════════════
-- SECTION 1: OVERLAP PROTECTION SETUP
-- Run once to enable ta-batch lock mechanism
-- ═══════════════════════════════════

-- RPC wrappers for pg_try_advisory_lock (required by ta-batch v23.1)
CREATE OR REPLACE FUNCTION public.try_acquire_batch_lock(lock_key bigint)
RETURNS boolean LANGUAGE sql SECURITY DEFINER AS $$
  SELECT pg_try_advisory_lock(lock_key);
$$;

CREATE OR REPLACE FUNCTION public.release_batch_lock(lock_key bigint)
RETURNS boolean LANGUAGE sql SECURITY DEFINER AS $$
  SELECT pg_advisory_unlock(lock_key);
$$;

-- Verify they work
SELECT public.try_acquire_batch_lock(99999) AS acquired;
SELECT public.release_batch_lock(99999) AS released;


-- ═══════════════════════════════════
-- SECTION 2: SCHEMA FIXES (2026-05-03)
-- ═══════════════════════════════════

-- Add ticker_count column (removes warning from ta-batch v23.1)
ALTER TABLE batch_run ADD COLUMN IF NOT EXISTS ticker_count integer;

-- Drop unique constraint on trading_date (allows multiple batch_run rows per date)
-- Required for ta-batch v23.1 which uses .insert() instead of .upsert()
ALTER TABLE batch_run DROP CONSTRAINT IF EXISTS batch_run_trading_date_key;


-- ═══════════════════════════════════
-- SECTION 3: CRON MANAGEMENT
-- ═══════════════════════════════════

-- View all scheduled cron jobs
SELECT jobid, jobname, schedule, active FROM cron.job ORDER BY jobname;

-- Unschedule ta-batch-continue (emergency stop)
SELECT cron.unschedule('ta-batch-continue');

-- Reschedule ta-batch-continue at 10-minute intervals (safe rate)
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

-- View recent cron firing history (last 30 minutes)
SELECT runid, jobid, status, return_message, start_time, end_time
FROM cron.job_run_details
WHERE start_time > NOW() - INTERVAL '30 minutes'
ORDER BY start_time DESC
LIMIT 20;


-- ═══════════════════════════════════
-- SECTION 4: BATCH STATE DIAGNOSTICS
-- ═══════════════════════════════════

-- Check current batch_run state
SELECT id, trading_date, status, started_at, completed_at,
       EXTRACT(EPOCH FROM (NOW() - started_at))::INTEGER AS age_seconds,
       ticker_count
FROM batch_run
ORDER BY started_at DESC
LIMIT 10;

-- Check batch_state (current TA processing progress)
SELECT trading_date, indicator_index, ticker_index, price_bars_done,
       status, last_updated,
       EXTRACT(EPOCH FROM (NOW() - last_updated))::INTEGER AS age_seconds
FROM batch_state
ORDER BY last_updated DESC;

-- Clean up stuck 'running' rows (emergency recovery)
UPDATE batch_run
SET status = 'stale_reset', completed_at = NOW()
WHERE status = 'running'
  AND started_at < NOW() - INTERVAL '5 minutes';

-- Manual reset for a specific trading date (clears and restarts)
-- Replace '2026-05-01' with actual date
DELETE FROM batch_state WHERE trading_date = '2026-05-01';
UPDATE batch_run
  SET status = 'manual_reset', completed_at = NOW()
  WHERE trading_date = '2026-05-01';
DELETE FROM ta_cache WHERE trading_date = '2026-05-01';

-- Verify advisory lock RPCs work
SELECT public.try_acquire_batch_lock(99999) AS acquired;
SELECT public.release_batch_lock(99999) AS released;


-- ═══════════════════════════════════
-- SECTION 5: TA CACHE DIAGNOSTICS
-- ═══════════════════════════════════

-- Count ta_cache rows by trading date
SELECT trading_date, COUNT(*) AS ticker_count,
       COUNT(rsi) AS rsi_done,
       COUNT(macd_h) AS macd_done,
       COUNT(ema9) AS ema9_done,
       COUNT(ema50) AS ema50_done,
       COUNT(sma200) AS sma200_done,
       COUNT(adx14) AS adx_done,
       COUNT(stoch_k) AS stoch_done
FROM ta_cache
GROUP BY trading_date
ORDER BY trading_date DESC;

-- Check distinct tickers in ta_cache
SELECT COUNT(DISTINCT ticker) FROM ta_cache;


-- ═══════════════════════════════════
-- SECTION 6: MFA MANAGEMENT
-- ═══════════════════════════════════

-- Disable MFA for fdcosta account (emergency escape hatch)
-- Only use if TOTP device is lost
DELETE FROM auth.mfa_factors WHERE user_id = 'bca7572d-c59f-4cf0-85e6-9ba5faf4ef36';

-- Check MFA factors for all users
SELECT u.email, mf.factor_type, mf.status, mf.created_at
FROM auth.users u
LEFT JOIN auth.mfa_factors mf ON mf.user_id = u.id
ORDER BY u.email;


-- ═══════════════════════════════════
-- SECTION 7: USER & SUBSCRIPTION MANAGEMENT
-- ═══════════════════════════════════

-- View all users with their tier
SELECT u.email, up.tier, up.is_admin, u.created_at
FROM auth.users u
LEFT JOIN user_profiles up ON up.id = u.id
ORDER BY u.created_at;

-- View subscription tiers and features
SELECT id, name, features FROM subscription_tiers ORDER BY sort_order;

-- AI summary cache management
-- Clear to force regeneration
DELETE FROM dashboard_ai_cache
WHERE cache_key IN ('market', 'fdcosta-watchlist');

-- View current AI cache
SELECT cache_key, generated_at, model, input_tokens, output_tokens, cost_usd
FROM dashboard_ai_cache
ORDER BY generated_at DESC;


-- ═══════════════════════════════════
-- SECTION 8: RESOURCE MONITORING
-- ═══════════════════════════════════

-- Check database connections
SELECT count(*), state FROM pg_stat_activity GROUP BY state;

-- Check advisory locks currently held
SELECT pid, classid, objid, objsubid, mode, granted
FROM pg_locks
WHERE locktype = 'advisory';

-- Check trigger definitions
SELECT trigger_name, event_manipulation, event_object_table, action_statement
FROM information_schema.triggers
WHERE trigger_schema = 'public'
ORDER BY event_object_table;

-- Table row counts (quick overview)
SELECT
  (SELECT COUNT(*) FROM ta_cache) AS ta_cache,
  (SELECT COUNT(*) FROM news_cache) AS news_cache,
  (SELECT COUNT(*) FROM quote_cache) AS quote_cache,
  (SELECT COUNT(*) FROM batch_run) AS batch_run,
  (SELECT COUNT(*) FROM batch_state) AS batch_state,
  (SELECT COUNT(*) FROM dashboard_ai_cache) AS ai_cache,
  (SELECT COUNT(*) FROM options_iv_cache) AS iv_cache,
  (SELECT COUNT(*) FROM user_watchlists) AS watchlists,
  (SELECT COUNT(*) FROM user_profiles) AS profiles;
