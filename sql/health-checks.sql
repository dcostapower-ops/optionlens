-- ═══════════════════════════════════════════════════════════════════════════
-- STOCKVIZOR — RUNTIME HEALTH-CHECK QUERIES
-- Operational diagnostics for batch jobs, cron, and cache freshness.
-- Read-only — none of these queries modify data.
-- Origin: 2026-05-04 ad-hoc health check.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- USAGE
-- Run these in the Supabase SQL editor when:
--   - You suspect batch jobs are stalled or failing silently
--   - The dashboard /v shows stale prices during market hours
--   - You want a periodic operational read on cron / cache freshness
--   - You're triaging a "things look slow / wrong" ticket
--
-- The queries below are self-contained — copy any one and run it.
-- ═══════════════════════════════════════════════════════════════════════════


-- ═══════════════════════════════════
-- QUERY 1: Cron run history (last 24 hours)
-- ═══════════════════════════════════
-- What it shows: every cron job execution with status and timing.
-- Note: cron.job_run_details has jobid only; we JOIN with cron.job to get jobname.
--
-- HEALTHY pattern:
--   - Every row status = 'succeeded'
--   - Job duration (end_time - start_time) is small (typically < 1 second for these jobs)
--   - All scheduled jobs visible (e.g. ta-batch-continue every 10 min, fan-outs every 15 min)
--
-- RED FLAGS:
--   - Any row with status = 'failed' → check return_message for the error
--   - Long durations (multi-second for sub-second jobs) → backend is overloaded
--   - Missing jobs (e.g. quote-fan-out absent for an hour during market hours) → cron may have
--     been paused, network failure, or the job got stuck and is blocking subsequent runs
--   - Repeated 'failed' for the same job → systemic issue (DNS overflow, downstream API outage)
--
-- Increase LIMIT to 200 to see daily jobs (ai-summary-daily, watchlist-classify, universe-fan-out)
-- which only fire once per day and may be pushed off a 30-row window.

SELECT
  j.jobname,
  d.status,
  d.start_time,
  d.end_time,
  COALESCE(d.return_message, '') AS return_message
FROM cron.job_run_details d
LEFT JOIN cron.job j ON j.jobid = d.jobid
WHERE d.start_time > NOW() - INTERVAL '24 hours'
ORDER BY d.start_time DESC
LIMIT 30;


-- ═══════════════════════════════════
-- QUERY 2: batch_run state
-- ═══════════════════════════════════
-- What it shows: most recent ta-batch execution rows. Each is one full pass
-- across the universe of tickers.
--
-- HEALTHY pattern:
--   - Most recent row has status = 'complete'
--   - age_seconds for the most recent complete run < 600 (i.e. ran within last 10 min,
--     since ta-batch-continue fires every 10 minutes)
--   - ticker_count is consistent across rows (drift of <5% between runs is normal as the
--     universe expands; sudden 50%+ drops are a problem)
--   - completed_at is non-null for any started_at older than ~5 minutes
--
-- RED FLAGS:
--   - status = 'running' for >5 minutes → batch is stuck. Use the recovery query in
--     00-ALL-QUERIES-MASTER.sql Section 4 to mark stuck rows as 'stale_reset'
--   - completed_at IS NULL for an old started_at → same issue
--   - ticker_count drops suddenly → universe ingestion broken
--   - trading_date is several days behind the current date during a market week →
--     batch isn't advancing. Cross-check with QUERY 1 to see if cron is firing at all

SELECT
  id,
  trading_date,
  status,
  started_at,
  completed_at,
  EXTRACT(EPOCH FROM (NOW() - started_at))::INTEGER AS age_seconds,
  ticker_count
FROM batch_run
ORDER BY started_at DESC
LIMIT 10;


-- ═══════════════════════════════════
-- QUERY 3: ta_cache freshness by trading date
-- ═══════════════════════════════════
-- What it shows: per-trading-date row count and indicator-completion counts in ta_cache.
-- Used to verify the batch is populating data, and that long-period indicators
-- (SMA200) are computed where enough history exists.
--
-- HEALTHY pattern:
--   - Top row's trading_date = most recent trading day (Friday during weekend; today during week)
--   - ticker_count grows or stays steady over time (universe expansion is normal)
--   - rsi_done / macd_done / sma200_done are close to ticker_count, with sma200_done
--     slightly lower (newer tickers don't have 200 days of history yet — expected)
--
-- RED FLAGS:
--   - Top trading_date is more than 1 trading day old during market hours → batch isn't
--     advancing. Cross-check QUERY 1 + QUERY 2.
--   - rsi_done sharply lower than ticker_count → indicator computation is failing for a
--     significant share of tickers (more than ~10% gap warrants investigation)
--   - ticker_count drops between dates → tickers are dropping out of the universe

SELECT
  trading_date,
  COUNT(*) AS ticker_count,
  COUNT(rsi) AS rsi_done,
  COUNT(macd_h) AS macd_done,
  COUNT(sma200) AS sma200_done
FROM ta_cache
GROUP BY trading_date
ORDER BY trading_date DESC
LIMIT 5;


-- ═══════════════════════════════════
-- QUERY 4: Cron job schedule
-- ═══════════════════════════════════
-- What it shows: every cron job currently registered in pg_cron with its schedule
-- and active flag. This tells you what's SCHEDULED — not what's RUNNING.
-- (Use QUERY 1 for running history.)
--
-- HEALTHY pattern (10 jobs as of 2026-05-04):
--   - ai-summary-daily         '0 9 * * *'           (daily at 5am ET)
--   - iv-batch-run             '*/5 13-20 * * 1-5'   (every 5 min during market hours, weekdays)
--   - movers-fan-out           '*/15 * * * *'        (every 15 min, always)
--   - news-fan-out             '*/15 * * * *'        (every 15 min, always)
--   - quote-fan-out            '*/15 * * * *'        (every 15 min, always)
--   - ta-batch-close           '30 21 * * 1-5'       (weekdays at 5:30pm ET, post-close)
--   - ta-batch-continue        '*/10 * * * *'        (every 10 min, always)
--   - ta-batch-premarket       '0 11 * * 1-5'        (weekdays at 7am ET)
--   - universe-fan-out         '0 6 * * *'           (daily at 2am ET)
--   - watchlist-classify       '0 1 * * *'           (daily at 9pm ET prior)
--   - All active = true
--
-- RED FLAGS:
--   - A job marked active = false that should be running → was disabled (intentionally? check
--     with 00-ALL-QUERIES-MASTER.sql Section 3 for the resume command)
--   - A job missing from the list entirely → cron.unschedule was called and never restored
--   - Schedule drifted from baseline above → someone changed it manually; verify intent

SELECT jobid, jobname, schedule, active
FROM cron.job
ORDER BY jobname;


-- ═══════════════════════════════════
-- QUERY 5 (optional): ticker_reference vs ta_cache gap
-- ═══════════════════════════════════
-- Identifies tickers in the master reference list that didn't make it into ta_cache
-- for a given date. Some gap is normal (newly listed, halted, illiquid, insufficient
-- history for indicators); a sudden growth in the gap suggests a processing issue.
--
-- Schema notes (verified 2026-05-04):
--   - Master ticker reference table: `ticker_reference` (NOT `universe`).
--     Maintained by the `universe-fan-out` edge function.
--   - The IDENTIFIER COLUMN IN ticker_reference IS `symbol`, NOT `ticker`.
--     (ta_cache uses `ticker`. The JOIN is `t.ticker = tr.symbol`.)
--   - `ticker_reference.missing_since` is non-null for tickers that have dropped out
--     of the active universe — exclude them with `WHERE tr.missing_since IS NULL`.
--   - The smaller working list `ta-batch` actually processes is a JSON blob in
--     `app_config` where `key = 'ta_ticker_universe'` — not a relational table.
--     For a strict diff against THAT list, you'd extract from the JSON; the
--     ticker_reference comparison below is the pragmatic operational query.
--
-- Replace 'YYYY-MM-DD' with the trading_date from QUERY 3's top row.

-- List missing tickers (top 50, active reference only)
-- SELECT tr.symbol
-- FROM ticker_reference tr
-- LEFT JOIN ta_cache t
--   ON t.ticker = tr.symbol AND t.trading_date = 'YYYY-MM-DD'
-- WHERE t.ticker IS NULL
--   AND tr.missing_since IS NULL
-- ORDER BY tr.symbol
-- LIMIT 50;

-- Or just the count (faster):
-- SELECT COUNT(*) AS missing_from_cache
-- FROM ticker_reference tr
-- LEFT JOIN ta_cache t
--   ON t.ticker = tr.symbol AND t.trading_date = 'YYYY-MM-DD'
-- WHERE t.ticker IS NULL
--   AND tr.missing_since IS NULL;

-- ─────────────────────────────────────────────────────────────────────────
-- IMPORTANT INTERPRETATION NOTE (verified 2026-05-04):
-- The above query returns a LARGE number (~5,900 on a normal day).
-- That is NOT a problem — `ticker_reference` is the broader master list
-- (~10K active tickers). `ta-batch` only processes a curated subset (~4.8K)
-- defined in `app_config[key='ta_ticker_universe']` — filtered for liquidity,
-- market cap, history, etc. Most of the "missing" 5,900 were never in scope.
--
-- The OPERATIONALLY MEANINGFUL gap is between the curated list and ta_cache —
-- typically ~100-150 tickers per day. That smaller delta is what you actually
-- want to investigate for processing failures. Use the query below for that.
-- ─────────────────────────────────────────────────────────────────────────

-- Better: diff against the curated list ta-batch actually processes
-- (extracts from app_config JSON; ~131 expected on a healthy day)
--
-- Note: `app_config.value` is stored as TEXT, not jsonb — explicit cast required.
-- The CASE handles both shapes (array vs. object with `tickers` key).
--
-- WITH processed AS (
--   SELECT jsonb_array_elements_text(
--            CASE WHEN jsonb_typeof(value::jsonb) = 'array' THEN value::jsonb
--                 ELSE (value::jsonb) -> 'tickers' END
--          ) AS ticker
--   FROM app_config
--   WHERE key = 'ta_ticker_universe'
-- )
-- SELECT COUNT(*) AS attempted_but_missing
-- FROM processed p
-- LEFT JOIN ta_cache t
--   ON t.ticker = p.ticker AND t.trading_date = 'YYYY-MM-DD'
-- WHERE t.ticker IS NULL;

-- If the cast above errors (value isn't valid JSON), peek at the format first:
-- SELECT pg_typeof(value), length(value) AS chars, LEFT(value, 200) AS preview
-- FROM app_config
-- WHERE key = 'ta_ticker_universe';


-- ═══════════════════════════════════════════════════════════════════════════
-- WHEN TO ESCALATE
-- ═══════════════════════════════════════════════════════════════════════════
-- If multiple queries show red flags simultaneously:
--   1. Check Supabase status page for incidents
--   2. Check docs/TECH-DEBT.md Item 3 (DNS cache overflow 503s — recurring known issue)
--   3. Check Supabase Dashboard → Functions → Logs for the affected function
--   4. If batch is genuinely stuck, the recovery commands are in
--      00-ALL-QUERIES-MASTER.sql Section 4 ("Clean up stuck 'running' rows")
--
-- For first-incident debugging, the fastest signal is QUERY 1 — if recent rows show
-- 'failed', the return_message field usually tells you what broke.
-- ═══════════════════════════════════════════════════════════════════════════
