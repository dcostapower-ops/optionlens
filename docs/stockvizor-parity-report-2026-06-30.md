# StockVizor Supabase Parity Report (Non-Vizardis)

Date: 2026-06-30
Scope: StockVizor-only functions and tables. All `vizardis-*` functions and associated objects are intentionally excluded.

## Source of Truth

Remote project ref: `hkamukkkkpqhdpcradau`
Local path: `supabase/functions/`

## Result

- Remote non-vizardis functions: 22
- Local non-vizardis functions: 22
- Only in remote: none
- Only in local: none

Parity status: PASS

## Included Function Set (StockVizor)

- `ai-summary`
- `backtest-rsi-batch`
- `backtest-rsi-bear-cross`
- `backtest-rsi-cycles`
- `compute-52w-highs`
- `compute-liquidity-history`
- `compute-run-stats`
- `detect-smart-rsi-daily`
- `etf-shares-pull`
- `generate-research-images`
- `generate-research-macro`
- `generate-research-stocks`
- `iv-batch`
- `leonardo-proxy`
- `movers-fan-out`
- `news-fan-out`
- `quote-fan-out`
- `rotation-refresh`
- `sync-tickers`
- `ta-batch`
- `universe-fan-out`
- `watchlist-classify`

## Explicit Exclusion

Ignored by request:
- Any function with slug prefix `vizardis-`
- Any SQL or table concerns tied to the Vizardis pipeline

## Verification Commands

```powershell
supabase functions list --project-ref hkamukkkkpqhdpcradau
Get-ChildItem .\supabase\functions -Directory
```

