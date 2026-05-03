# StockVizor — Checkpoint Release

**Date:** 2026-04-24
**Live Worker version:** 5fa1288a-b72b-41a4-97a7-ab2dfb1391e1
**Domain:** stockvizor.com

## What's in this release

This is the **clean checkpoint** before Phase A (watchlist Supabase migration) begins.
Every file below is exactly what's currently live in production.

### public/
- `index.html` — marketing landing page (unchanged from prior release)
- `screener.html` — main chart + screener app (1,002,582 bytes)
  - Includes: SmartDecay AI v2, cache architecture (`_svCache`), RSI/pill layout fixes
  - Built-in indicators: Smart Candles, Smart RSI, SmartDecay, Signal Engine v2.1
  - Full Supabase + Polygon integrations
- `monitor.html` — TA-batch + IV-batch completion status monitor
- `mockup-v1.html` through `mockup-v5.html` — dashboard design variants
  - v1 = Bloomberg Terminal style
  - v2 = Modern Fintech (Robinhood-style)
  - v3 = News-Forward (Seeking Alpha magazine)
  - v4 = Pro Chart Workstation (TradingView-style)
  - v5 = Unified Hybrid (chosen as production base)
- Static assets: logos, favicons, hero images/video

### src/
- `index.js` — Cloudflare Worker (2,912 bytes)
  - Handles /api/* routing (polygon proxy, stripe, finnhub, etc.)
  - Serves /public/* as static assets via ASSETS binding

### sql/
- `phase1-vizor-tables.sql` — VizorBuys/VizorShorts DB schema (not yet run)
- `enable-smartdecay-ai.sql` — already run; kept for reference

### wrangler.toml
Cloudflare Worker config (project: lingering-sun-c298)

## Deploy chain today (most recent last)
1. 21be0942 — SmartDecay AI v1 first deploy
2. d1146c5e — Close button updMenu fix
3. 3959eab9 — computeSmartCandles cache wrapper
4. 3fb73904 — MTF cache wrapper
5. 62764f96 — SmartDecay v2 redesign (Uptrend/Downtrend meters)
6. 75f7a524 — UX polish (LIVE glow, grey LAST, glyph refs)
7. 2512dfc6 — Pill + RSI layout fixes
8. 5fa1288a — 5 mockup dashboards deployed ← **current live**

## Verified state
- [x] screener.html: 5/5 script tags balanced, ends with `</html>`
- [x] SmartDecay AI premium gate: smart_decay=true (premium), false (pro/free)
- [x] All 5 mockups reachable at stockvizor.com/mockup-v{1..5}.html (HTTP 200)
- [x] Polygon real-time feed working (Stocks Starter RT + Options Advanced RT via Massive)

## To push to GitHub (dcostapower-ops/optionlens)
Unzip and commit all files. Structure matches the repo layout.

## Next up (not yet started)
- Phase A: watchlist Supabase migration
- Phase B1: /dashboard production from mockup-v5
- Phase B2: /chart.html (v4 wrapper + extracted chart canvas)
- Phase C: mobile responsive
- Phase D: VizorBuys implementation
