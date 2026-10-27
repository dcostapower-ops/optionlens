-- ═══════════════════════════════════════════════════════════════════
-- Option Buy Picks (long call / long put dashboard)
-- Table read by the dashboard via Supabase Realtime; written by the
-- option-buy-picks Edge Function (service role). Applied 2026-10-27.
-- ═══════════════════════════════════════════════════════════════════

create table if not exists public.option_buy_picks (
  id text primary key,            -- 'latest' (picks) | 'events' (earnings/dividend cache)
  payload jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.option_buy_picks enable row level security;
create policy "option_buy_picks public read" on public.option_buy_picks for select to anon, authenticated using (true);
alter publication supabase_realtime add table public.option_buy_picks;

-- Every minute, Mon–Fri 13:00–21:59 UTC. The function itself skips ticks
-- outside the regular NYSE/NASDAQ session, runs the full selection on
-- 5-minute marks and refreshes quotes on the others.
-- SELECT cron.schedule('option-buy-picks', '* 13-21 * * 1-5', $$ SELECT net.http_post(
--   url := 'https://hkamukkkkpqhdpcradau.supabase.co/functions/v1/option-buy-picks',
--   body := '{}'::jsonb,
--   headers := '{"Content-Type":"application/json","Authorization":"Bearer <anon key>"}'::jsonb) $$);
