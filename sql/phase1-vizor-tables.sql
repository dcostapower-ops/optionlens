-- ════════════════════════════════════════════════════════════════════════
-- StockVizor — VizorBuys/VizorShorts Phase 1: Database Foundation
-- Run in: Supabase Dashboard → SQL Editor → New Query
-- Project: hkamukkkkpqhdpcradau
-- ════════════════════════════════════════════════════════════════════════
-- This file is IDEMPOTENT — safe to run multiple times.
-- Creates:
--   1. update_timestamp_vizor()  — trigger helper
--   2. user_trade_budgets        — per-user, per-mode budget settings
--   3. vizor_scans               — scan history (opportunities logged)
--   4. vizor_paper_trades        — paper trading ledger (Phase 3)
-- All tables have RLS enabled with policies keyed on auth.uid().
-- ════════════════════════════════════════════════════════════════════════

-- ─── Helper: updated_at trigger function (idempotent via CREATE OR REPLACE) ──
CREATE OR REPLACE FUNCTION update_timestamp_vizor()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;


-- ════════════════════════════════════════════════════════════════════════
-- TABLE 1: user_trade_budgets
-- One row per user. Separate budgets for buy vs short modes.
-- ════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS user_trade_budgets (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  vizorbuy_budget    NUMERIC(12,2) CHECK (vizorbuy_budget   >= 100),
  vizorshort_budget  NUMERIC(12,2) CHECK (vizorshort_budget >= 100),
  currency           TEXT DEFAULT 'USD' NOT NULL,
  vizorshort_risk_accepted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT now() NOT NULL
);

DROP TRIGGER IF EXISTS trg_user_trade_budgets_updated_at ON user_trade_budgets;
CREATE TRIGGER trg_user_trade_budgets_updated_at
  BEFORE UPDATE ON user_trade_budgets
  FOR EACH ROW EXECUTE FUNCTION update_timestamp_vizor();

ALTER TABLE user_trade_budgets ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY "utb_read_own" ON user_trade_budgets
    FOR SELECT USING (auth.uid() = user_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "utb_insert_own" ON user_trade_budgets
    FOR INSERT WITH CHECK (auth.uid() = user_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "utb_update_own" ON user_trade_budgets
    FOR UPDATE USING (auth.uid() = user_id)
                 WITH CHECK (auth.uid() = user_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;


-- ════════════════════════════════════════════════════════════════════════
-- TABLE 2: vizor_scans
-- Each scan run is logged here. Keeps opportunities as JSONB for flexibility.
-- ════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS vizor_scans (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  mode           TEXT CHECK (mode IN ('buy','short')) NOT NULL,
  budget         NUMERIC(12,2) NOT NULL,
  timeframe      TEXT DEFAULT 'D' NOT NULL,
  opportunities  JSONB NOT NULL,
  candidates_considered INT,
  market_session TEXT,  -- 'pre' | 'regular' | 'after' | 'closed'
  scanned_at     TIMESTAMPTZ DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_vizor_scans_user_time
  ON vizor_scans(user_id, scanned_at DESC);

ALTER TABLE vizor_scans ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY "vs_read_own" ON vizor_scans
    FOR SELECT USING (auth.uid() = user_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "vs_insert_own" ON vizor_scans
    FOR INSERT WITH CHECK (auth.uid() = user_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;


-- ════════════════════════════════════════════════════════════════════════
-- TABLE 3: vizor_paper_trades
-- Paper trading ledger. Entry on card click, exit on target/stop/manual.
-- ════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS vizor_paper_trades (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  scan_id      UUID REFERENCES vizor_scans(id) ON DELETE SET NULL,
  ticker       TEXT NOT NULL,
  mode         TEXT CHECK (mode IN ('buy','short')) NOT NULL,
  shares       INT  NOT NULL CHECK (shares > 0),
  entry_price  NUMERIC(10,4) NOT NULL,
  target_price NUMERIC(10,4),
  stop_price   NUMERIC(10,4),
  budget_used  NUMERIC(12,2) NOT NULL,
  entered_at   TIMESTAMPTZ DEFAULT now() NOT NULL,
  exit_price   NUMERIC(10,4),
  exit_reason  TEXT CHECK (exit_reason IN ('target_hit','stop_hit','manual','expired')),
  exited_at    TIMESTAMPTZ,
  pnl_dollars  NUMERIC(10,2),
  pnl_pct      NUMERIC(6,3),
  notes        TEXT
);

CREATE INDEX IF NOT EXISTS idx_vizor_paper_open
  ON vizor_paper_trades(user_id, entered_at DESC)
  WHERE exited_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_vizor_paper_all
  ON vizor_paper_trades(user_id, entered_at DESC);

ALTER TABLE vizor_paper_trades ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY "vpt_read_own" ON vizor_paper_trades
    FOR SELECT USING (auth.uid() = user_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "vpt_insert_own" ON vizor_paper_trades
    FOR INSERT WITH CHECK (auth.uid() = user_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "vpt_update_own" ON vizor_paper_trades
    FOR UPDATE USING (auth.uid() = user_id)
                 WITH CHECK (auth.uid() = user_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;


-- ════════════════════════════════════════════════════════════════════════
-- VERIFICATION: run these to confirm everything was created correctly
-- ════════════════════════════════════════════════════════════════════════

-- Confirm the 3 tables exist
SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN ('user_trade_budgets','vizor_scans','vizor_paper_trades')
ORDER BY table_name;

-- Confirm RLS is ON for all 3
SELECT tablename, rowsecurity
FROM pg_tables
WHERE schemaname = 'public'
  AND tablename IN ('user_trade_budgets','vizor_scans','vizor_paper_trades')
ORDER BY tablename;

-- Confirm policies exist
SELECT tablename, policyname, cmd
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename IN ('user_trade_budgets','vizor_scans','vizor_paper_trades')
ORDER BY tablename, policyname;
