# SQL — apply status

These files are **not Supabase migrations** (deliberately). The schema currently in production was applied via the Dashboard SQL editor and never registered in `supabase_migrations.schema_migrations`. Putting these files in `supabase/migrations/` and running `supabase db push` would attempt to re-apply already-applied SQL, with unpredictable results. Until a proper migration baseline is captured, **apply SQL via the Supabase Dashboard SQL editor** with eyes-on review.

## Read this first

**`00-ALL-QUERIES-MASTER.sql`** is the canonical reference — 8 sections covering overlap protection, schema fixes, cron management, batch diagnostics, TA cache diagnostics, MFA management, user/subscription management, and resource monitoring. Generated 2026-05-03. When in doubt, start here.

## Apply status

| File | Status | Notes |
|---|---|---|
| `00-ALL-QUERIES-MASTER.sql` | reference | Master organized view of all SQL — read first |
| `enable-smartdecay-ai.sql` | ✅ applied | Per `docs/README.md` — already run, kept for reference |
| `phase2-schema.sql` | ✅ applied | Live schema |
| `monitor-live-metrics-setup.sql` | ✅ applied | Live metrics views |
| `cron-pause-resume-functions.sql` | ✅ applied | Cron control RPCs |
| `cron-reschedule-ta-batch-continue.sql` | ✅ applied | ta-batch cron schedule |
| `ta-cache-updated-at-trigger.sql` | ✅ applied | ta_cache update trigger |
| `phase-a-watchlist.sql` | ⏳ pending | Phase A — watchlist Supabase migration |
| `phase1-vizor-tables.sql` | ⏳ pending | Phase D — VizorBuys/VizorShorts tables |
| `health-checks.sql` | 🔍 read-only | Operational diagnostics — does NOT modify data; safe to run any time |

If you apply something, change the status. If you discover something marked applied is actually not, fix it — this table is the source of truth for "what's in prod."

## Operational diagnostics

**`health-checks.sql`** is the runtime health-check runbook. Five queries covering cron run history, `batch_run` state, `ta_cache` freshness, cron schedule, and a universe-vs-cache gap diagnostic. Each query has inline commentary on what "healthy" looks like vs. red flags.

When to run:
- The dashboard `/v` shows stale prices during market hours
- You suspect batch jobs are stalled or failing silently
- Periodic operational read on cron / cache freshness
- First-line triage for "things look slow / wrong" tickets

These queries are read-only — no risk to production data. Run them in the Supabase SQL editor.

## Security note

`00-ALL-QUERIES-MASTER.sql` Section 3 contains a JWT bearer token used for cron `net.http_post` calls. That token is the Supabase **anon key**, which is public-by-design (it carries the `role: anon` claim and is gated by RLS). It is safe to commit.

The Supabase **service role key** and the **PAT** in `docs/TECH-DEBT.md` Item 5 are NOT public. Do not paste either into any SQL file or commit.

## Future: migration baseline

When ready to switch to CLI-driven SQL deploys:
1. `supabase db dump --schema public --data-only=false` to capture current schema
2. Save as `supabase/migrations/00000000000000_baseline.sql` and mark applied via `supabase migration repair`
3. From then on, new SQL goes in `supabase/migrations/` with timestamps and applies via `supabase db push`

This is a separate project — do not start until pending SQL above (Phase A, Phase D) has either been applied or moved into the migration system as forward migrations.
