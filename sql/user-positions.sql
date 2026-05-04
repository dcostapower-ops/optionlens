-- ─────────────────────────────────────────────────────────────────────────────
-- user_positions — manually tracked stock/ETF positions per user
-- Deployed: 2026-05-04
--
-- P&L formulas (all fees applied at cost price only, entry side):
--   Long  (Buy / Margin Buy):   P&L = (close - entry) × qty - commission_entry - exit_commission - vat
--   Short (Sell / Margin Short): P&L = (entry - close) × qty - commission_entry - exit_commission - vat
--
-- commission_entry = flat fee charged by broker at entry leg
-- exit_commission  = flat fee charged by broker at exit leg (set when marking realized)
-- vat              = entry_price × qty × vat_rate%  (transaction tax, buy-side only)
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Create table
CREATE TABLE IF NOT EXISTS public.user_positions (
  id               uuid          DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id          uuid          NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  ticker           text          NOT NULL,
  type             text          NOT NULL DEFAULT 'Buy'
                                 CHECK (type IN ('Buy','Sell','Margin Buy','Margin Short')),
  qty              integer       NOT NULL CHECK (qty > 0),
  entry            numeric(14,4) NOT NULL CHECK (entry > 0),
  commission       numeric(14,4) NOT NULL DEFAULT 0,   -- entry leg flat fee
  exit_commission  numeric(14,4) NOT NULL DEFAULT 0,   -- exit leg flat fee (set on close)
  vat              numeric(14,4) NOT NULL DEFAULT 0,   -- entry_price × qty × vat_rate%
  open_date        date          NOT NULL DEFAULT CURRENT_DATE,
  status           text          NOT NULL DEFAULT 'open'
                                 CHECK (status IN ('open','realized')),
  close_price      numeric(14,4),
  close_date       date,
  created_at       timestamptz   NOT NULL DEFAULT now()
);

-- 2. Enable Row Level Security
ALTER TABLE public.user_positions ENABLE ROW LEVEL SECURITY;

-- 3. RLS policies — users can only access their own rows
CREATE POLICY "positions_select_own" ON public.user_positions
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "positions_insert_own" ON public.user_positions
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "positions_update_own" ON public.user_positions
  FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "positions_delete_own" ON public.user_positions
  FOR DELETE USING (auth.uid() = user_id);

-- 4. Index for fast per-user queries
CREATE INDEX IF NOT EXISTS user_positions_user_status_idx
  ON public.user_positions (user_id, status);


-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 2026-05-04: add exit_commission column
-- Run this if the table already exists without exit_commission.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.user_positions
  ADD COLUMN IF NOT EXISTS exit_commission numeric(14,4) NOT NULL DEFAULT 0;
