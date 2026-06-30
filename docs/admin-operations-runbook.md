# StockVizor Admin Operations Runbook

This runbook covers daily upkeep for Supabase batch processing, health checks, and activity logs.

## Scope

- Admin console: `public/m.html`
- Core batch pipelines: `ta-batch`, `iv-batch`
- Supporting fan-out jobs: `quote-fan-out`, `news-fan-out`, `movers-fan-out`, `universe-fan-out`
- Worker middleware and dashboard data freshness

Vizardis functions and tables are intentionally out of scope.

## Daily startup checks

1. Open Admin Console (`/m`) and sign in as admin.
2. In `Batch Monitor`:
   - Confirm TA-BATCH status is healthy.
   - Confirm IV-BATCH status is healthy.
   - Confirm Health Check badge is healthy.
3. Confirm `Cron Schedule Status` shows active schedules.
4. Review `Activity Log` for errors from the last run window.

## Mid-day checks (market hours)

1. Verify `Batch state` is progressing and not stuck in `running` too long.
2. Check latest run metadata (`started_at`, `completed_at`, ticker counts).
3. Ensure no repeated failures in log lines for TA/IV triggers.

## End-of-day checks

1. Confirm latest trading date rows exist in `ta_cache` and `options_iv_cache`.
2. Confirm quote/news fan-out jobs updated during market sessions.
3. Confirm no cron jobs remain paused.

## Incident response

### A. Batch appears stalled

1. Run SQL diagnostics in `sql/health-checks.sql`:
   - Query 1 (cron run history)
   - Query 2 (batch_run state)
   - Query 3 (ta_cache freshness)
2. If stuck rows are confirmed, use recovery steps from `sql/00-ALL-QUERIES-MASTER.sql`.
3. Trigger `Run All Batches` from Admin Console.
4. Re-check Health and Activity Log sections.

### B. Cron paused by mistake

1. Use `Resume Cron` in Admin Console.
2. Verify restored schedules in `Cron Schedule Status`.
3. Validate with Query 4 from `sql/health-checks.sql`.

### C. Stale dashboard data

1. Check `quote_cache` freshness and latest `ta_cache` trading date.
2. Trigger `quote-fan-out` and `ta-batch` manually if needed.
3. Verify dashboard endpoints:
   - `/api/dashboard/index`
   - `/api/dashboard/ticker/{symbol}`

## Weekly maintenance

1. Review `cache_health` and batch event trends.
2. Confirm function inventory is present:
   - `supabase functions list --project-ref hkamukkkkpqhdpcradau`
3. Run release gate smoke checks:
   - `scripts/release-gate.ps1`

## Ownership model

- Business decisions: product owner.
- Technical execution, deployment, environment integrity: engineering workflow in this workspace.
