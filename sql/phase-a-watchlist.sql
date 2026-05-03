-- ════════════════════════════════════════════════════════════════════════
-- StockVizor — Phase A: Watchlist Supabase Migration
-- Run in: Supabase Dashboard → SQL Editor → New Query
-- Project: hkamukkkkpqhdpcradau
-- Purpose: Move watchlist storage from localStorage to Supabase for cross-device sync
-- Design: Row-per-item table (one row per user-ticker pair) — supports leaderboard query
-- Idempotent: safe to re-run
-- ════════════════════════════════════════════════════════════════════════

-- ──────────────────────────────────────────────────────────────────────
-- 1. Create user_watchlists table (row-per-item design)
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.user_watchlists (
  user_id   UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  ticker    TEXT NOT NULL CHECK (ticker ~ '^[A-Z0-9.-]{1,12}$'),
  sort_idx  INT  NOT NULL DEFAULT 0,
  added_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, ticker)
);

COMMENT ON TABLE  public.user_watchlists IS 'Per-user watchlist tickers. One row per user-ticker pair.';
COMMENT ON COLUMN public.user_watchlists.sort_idx IS 'Display order; client-managed.';
COMMENT ON COLUMN public.user_watchlists.added_at IS 'When the user added this ticker.';

-- ──────────────────────────────────────────────────────────────────────
-- 2. Indexes for fast reads
-- ──────────────────────────────────────────────────────────────────────
-- For "load my watchlist in display order"
CREATE INDEX IF NOT EXISTS idx_user_watchlists_user_sort
  ON public.user_watchlists (user_id, sort_idx);

-- For "most-watched leaderboard" (logged-out dashboard preview)
CREATE INDEX IF NOT EXISTS idx_user_watchlists_ticker
  ON public.user_watchlists (ticker);

-- ──────────────────────────────────────────────────────────────────────
-- 3. Row-Level Security
-- ──────────────────────────────────────────────────────────────────────
ALTER TABLE public.user_watchlists ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  -- Read own
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='user_watchlists' AND policyname='uw_read_own') THEN
    CREATE POLICY uw_read_own ON public.user_watchlists
      FOR SELECT USING (auth.uid() = user_id);
  END IF;

  -- Insert own
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='user_watchlists' AND policyname='uw_insert_own') THEN
    CREATE POLICY uw_insert_own ON public.user_watchlists
      FOR INSERT WITH CHECK (auth.uid() = user_id);
  END IF;

  -- Update own (for re-ordering via sort_idx)
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='user_watchlists' AND policyname='uw_update_own') THEN
    CREATE POLICY uw_update_own ON public.user_watchlists
      FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
  END IF;

  -- Delete own
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='user_watchlists' AND policyname='uw_delete_own') THEN
    CREATE POLICY uw_delete_own ON public.user_watchlists
      FOR DELETE USING (auth.uid() = user_id);
  END IF;
END
$$;

-- ──────────────────────────────────────────────────────────────────────
-- 4. Public leaderboard view (for logged-out dashboard preview)
--    Aggregate-only — no PII exposed
-- ──────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW public.public_watchlist_leaderboard AS
SELECT
  ticker,
  COUNT(*)::INT AS watcher_count
FROM public.user_watchlists
GROUP BY ticker
ORDER BY watcher_count DESC, ticker ASC;

COMMENT ON VIEW public.public_watchlist_leaderboard IS
  'Most-watched tickers across all users. Aggregate-only; no PII. Safe for anon read.';

-- Grant anon SELECT on the view (it's already aggregate-safe)
GRANT SELECT ON public.public_watchlist_leaderboard TO anon, authenticated;

-- ══════════════════════════════════════════════════════════════════════
-- 5. Verification queries (auto-run; check the bottom of output)
-- ══════════════════════════════════════════════════════════════════════

-- 5a. Confirm table created with correct columns
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema='public' AND table_name='user_watchlists'
ORDER BY ordinal_position;

-- 5b. Confirm RLS is enabled
SELECT tablename, rowsecurity
FROM pg_tables
WHERE schemaname='public' AND tablename='user_watchlists';

-- 5c. Confirm policies exist (should return 4)
SELECT policyname, cmd
FROM pg_policies
WHERE tablename='user_watchlists'
ORDER BY policyname;

-- 5d. Confirm leaderboard view works (returns empty when no data — expected on first run)
SELECT * FROM public.public_watchlist_leaderboard LIMIT 5;

-- ══════════════════════════════════════════════════════════════════════
-- DONE. Expected output:
--   5a → 4 rows (user_id, ticker, sort_idx, added_at)
--   5b → 1 row, rowsecurity=true
--   5c → 4 rows (uw_delete_own, uw_insert_own, uw_read_own, uw_update_own)
--   5d → 0 rows (empty until users add watchlists)
-- ══════════════════════════════════════════════════════════════════════
