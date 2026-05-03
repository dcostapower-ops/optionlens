-- ═══════════════════════════════════════════════════════════════════
-- StockVizor — Phase 2: Centralized Data Cache Schema
-- ═══════════════════════════════════════════════════════════════════
-- Architecture: server-side fan-out
-- Data flow: upstream data provider (15-min delayed) → Supabase tables → users read
-- Refresh cadence: every 15 minutes during market hours, slower off-hours
-- All tables use UPSERT pattern (no row growth except news_cache, which has 3-day retention)
-- Date: 2026-04-26
-- ═══════════════════════════════════════════════════════════════════

-- ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
-- ┃ TABLE 1: quote_cache                                            ┃
-- ┃ Purpose: Latest snapshot for ~1,481 tickers + commodities + crypto ┃
-- ┃ Used by:  Ticker tape, watchlist quotes, anywhere needing price ┃
-- ┃ Pattern:  UPSERT (1 row per symbol forever)                     ┃
-- ┃ Refresh:  Every 15 min market hours, hourly off-hours          ┃
-- ┃ Source:   Upstream data provider snapshot (stocks + commodities)┃
-- ┃           Crypto: free public API (no key required)             ┃
-- ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
CREATE TABLE IF NOT EXISTS public.quote_cache (
  symbol           text PRIMARY KEY,
  asset_class      text NOT NULL,            -- 'stock' | 'commodity' | 'crypto' | 'etf'
  last_price       numeric(18,6),
  prev_close       numeric(18,6),
  change_abs       numeric(18,6),            -- last_price - prev_close
  change_pct       numeric(10,4),            -- as percentage, e.g. 1.27
  day_volume       bigint,
  day_high         numeric(18,6),
  day_low          numeric(18,6),
  data_source      text DEFAULT 'primary',   -- internal routing only — never shown to users
  fetched_at       timestamptz NOT NULL,     -- when WE fetched from upstream
  data_as_of       timestamptz,              -- timestamp the data itself represents (~15min behind real time)
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_quote_cache_asset_class ON public.quote_cache (asset_class);
CREATE INDEX IF NOT EXISTS idx_quote_cache_updated_at  ON public.quote_cache (updated_at);

ALTER TABLE public.quote_cache ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon_read_quote_cache" ON public.quote_cache FOR SELECT TO anon USING (true);
CREATE POLICY "auth_read_quote_cache" ON public.quote_cache FOR SELECT TO authenticated USING (true);
-- writes only via service_role (Edge Functions / cron)

COMMENT ON TABLE public.quote_cache IS '15-min delayed price snapshots. UPSERT pattern: one row per symbol forever. data_source field is internal routing only and never shown to users.';


-- ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
-- ┃ TABLE 2: index_cache                                            ┃
-- ┃ Purpose: 5 major indices + 30-day sparkline data               ┃
-- ┃ Used by:  Dashboard top sparkline cards                         ┃
-- ┃ Pattern:  UPSERT (5 rows forever)                              ┃
-- ┃ Refresh:  Every 15 min for prices, daily for sparklines        ┃
-- ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
CREATE TABLE IF NOT EXISTS public.index_cache (
  symbol           text PRIMARY KEY,         -- 'I:DJI', 'I:SPX', 'I:NDX', 'I:RUT', 'I:VIX'
  display_name     text NOT NULL,            -- 'Dow', 'S&P 500', 'Nasdaq', 'Russell 2K', 'VIX'
  display_order    int NOT NULL,             -- 1..5 for left-to-right ordering
  last_value       numeric(18,4),
  prev_close       numeric(18,4),
  change_abs       numeric(18,4),
  change_pct       numeric(10,4),
  day_high         numeric(18,4),
  day_low          numeric(18,4),
  -- 30-day sparkline as array of {date, close} objects
  sparkline_30d    jsonb,                    -- e.g. [{"d":"2026-03-27","c":5142.18}, ...]
  sparkline_updated_at timestamptz,          -- sparklines refresh once daily, separate from price
  fetched_at       timestamptz NOT NULL,
  data_as_of       timestamptz,
  updated_at       timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.index_cache ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon_read_index_cache" ON public.index_cache FOR SELECT TO anon USING (true);
CREATE POLICY "auth_read_index_cache" ON public.index_cache FOR SELECT TO authenticated USING (true);

COMMENT ON TABLE public.index_cache IS '5 major US indices (DOW/SPX/NDX/RUT/VIX) with 30-day sparklines.';

-- Pre-seed the 5 index rows so dashboard shows skeleton even before first cron run
INSERT INTO public.index_cache (symbol, display_name, display_order, fetched_at) VALUES
  ('I:DJI', 'Dow',         1, now()),
  ('I:SPX', 'S&P 500',     2, now()),
  ('I:NDX', 'Nasdaq',      3, now()),
  ('I:RUT', 'Russell 2K',  4, now()),
  ('I:VIX', 'VIX',         5, now())
ON CONFLICT (symbol) DO NOTHING;


-- ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
-- ┃ TABLE 3: top_movers_cache                                       ┃
-- ┃ Purpose: Top 10 gainers + top 10 losers of the day             ┃
-- ┃ Used by:  Dashboard top movers panels (Phase 4)                ┃
-- ┃ Pattern:  UPSERT on (kind, rank) — at most 20 rows total       ┃
-- ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
CREATE TABLE IF NOT EXISTS public.top_movers_cache (
  kind             text NOT NULL,            -- 'gainer' | 'loser'
  rank             int NOT NULL,             -- 1..10
  symbol           text NOT NULL,
  last_price       numeric(18,6),
  change_abs       numeric(18,6),
  change_pct       numeric(10,4),
  day_volume       bigint,
  fetched_at       timestamptz NOT NULL,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, rank)
);

CREATE INDEX IF NOT EXISTS idx_movers_cache_updated ON public.top_movers_cache (updated_at);

ALTER TABLE public.top_movers_cache ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon_read_movers"  ON public.top_movers_cache FOR SELECT TO anon USING (true);
CREATE POLICY "auth_read_movers"  ON public.top_movers_cache FOR SELECT TO authenticated USING (true);

COMMENT ON TABLE public.top_movers_cache IS 'Top 10 gainers + top 10 losers per day. Refreshed every 15 min during market hours.';


-- ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
-- ┃ TABLE 4: news_cache                                             ┃
-- ┃ Purpose: Recent news headlines for our tracked tickers          ┃
-- ┃ Used by:  Dashboard news section (Phase 5)                      ┃
-- ┃ Pattern:  Append + retention (delete > 3 days old)              ┃
-- ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
CREATE TABLE IF NOT EXISTS public.news_cache (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  external_id      text UNIQUE,              -- prevents duplicate ingestion
  publisher        text,                     -- e.g. 'Reuters', 'Bloomberg'
  headline         text NOT NULL,
  description      text,
  url              text,
  image_url        text,
  tickers          text[],                   -- multiple tickers per article
  sentiment        text,                     -- 'positive' | 'negative' | 'neutral' | NULL
  published_at     timestamptz NOT NULL,
  fetched_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_news_published    ON public.news_cache (published_at DESC);
CREATE INDEX IF NOT EXISTS idx_news_tickers_gin  ON public.news_cache USING GIN (tickers);

ALTER TABLE public.news_cache ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon_read_news" ON public.news_cache FOR SELECT TO anon USING (true);
CREATE POLICY "auth_read_news" ON public.news_cache FOR SELECT TO authenticated USING (true);

COMMENT ON TABLE public.news_cache IS 'News articles for tracked tickers. 3-day retention via daily cleanup job.';


-- ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
-- ┃ TABLE 5: cache_health                                           ┃
-- ┃ Purpose: Per-cache pipeline health for monitor.html            ┃
-- ┃ Pattern:  UPSERT on cache_name                                  ┃
-- ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
CREATE TABLE IF NOT EXISTS public.cache_health (
  cache_name           text PRIMARY KEY,     -- 'quote_cache', 'index_cache', etc.
  last_run_at          timestamptz,
  last_success_at      timestamptz,
  symbols_attempted    int,
  symbols_updated      int,
  symbols_failed       int,
  duration_ms          int,
  last_error           text,
  status               text,                 -- 'healthy' | 'stale' | 'failed' | 'never_run'
  updated_at           timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.cache_health ENABLE ROW LEVEL SECURITY;
-- Only admins read this (used by monitor.html which already authenticates as admin)
CREATE POLICY "auth_read_health" ON public.cache_health FOR SELECT TO authenticated USING (true);

COMMENT ON TABLE public.cache_health IS 'Per-cache pipeline status: last run time, success/failure counts, errors. Populated by Edge Functions on each run.';

-- (Pre-seeding deferred — table starts empty, Edge Functions will UPSERT their own rows on first run)


-- ═══════════════════════════════════════════════════════════════════
-- POST-DEPLOY: Cron schedule changes
-- ═══════════════════════════════════════════════════════════════════
-- These are NOT run as part of the schema migration — they're documented here
-- so we know what to do once Edge Functions are deployed.
--
-- 1) Change ta-batch-continue from every 3 min to every 15 min:
--    SELECT cron.alter_job(jobid := 13, schedule := '*/15 * * * *');
--
-- 2) Add 4 new cron jobs (after Edge Functions are deployed):
--    SELECT cron.schedule('quote-fan-out',  '*/15 * * * *', $$ ...call quote-fan-out... $$);
--    SELECT cron.schedule('index-fan-out',  '*/15 * * * *', $$ ...call index-fan-out... $$);
--    SELECT cron.schedule('movers-fan-out', '*/15 * * * *', $$ ...call movers-fan-out... $$);
--    SELECT cron.schedule('news-fan-out',   '*/15 * * * *', $$ ...call news-fan-out... $$);
--
-- 3) Add daily sparkline rebuild (6am ET = 11am UTC):
--    SELECT cron.schedule('sparkline-rebuild', '0 11 * * *', $$ ...call sparkline-rebuild... $$);
--
-- 4) Add daily news cleanup (delete articles > 3 days old, runs 3am UTC):
--    SELECT cron.schedule('news-cleanup', '0 3 * * *', $$ DELETE FROM public.news_cache WHERE published_at < now() - interval '3 days'; $$);

-- ═══════════════════════════════════════════════════════════════════
-- Tables created:
--   - quote_cache       (1,481+ rows after first fan-out, UPSERT)
--   - index_cache       (5 rows pre-seeded with display names + order, UPSERT)
--   - top_movers_cache  (20 rows after first run, UPSERT)
--   - news_cache        (grows + 3-day retention)
--   - cache_health      (empty initially; Edge Functions UPSERT rows on first run)
-- Total live row count after warmup: ~1,510 (excluding news growth)
-- Daily growth: 0 (UPSERT pattern), except news ~50-200 rows/day with 3-day TTL
-- ═══════════════════════════════════════════════════════════════════
