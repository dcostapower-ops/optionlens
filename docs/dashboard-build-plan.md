# StockVizor Dashboard Build Plan — Phase B1
**For session starting:** Sunday April 26, 2026 (or Monday)
**Target:** `/dashboard` page on stockvizor.com — replaces or augments current landing

---

## ✅ Decisions already made

- **Base layout:** mockup-v5
- **Chart workspace:** mockup-v4's 3-panel design (will be Phase B2 at `/chart.html`)
- **Tech stack:** Vanilla HTML/CSS/JS (same as screener.html), no framework
- **Auth:** Reuses existing Supabase auth from screener.html
- **Data source:** Polygon (via Cloudflare worker proxy `/api/polygon/...`)
- **Tier gating:** Free tier sees limited features; Premium sees full dashboard
- **Hosting:** Cloudflare Worker `lingering-sun-c298`, static asset

---

## 🎯 v5 mockup sections to build (in priority order)

### Section 1 — Header (`hdr`)
- Logo + brand name "StockVizor"
- Nav buttons: Charts | Screener | Options | Trades | Journal
- Center search box (ticker autocomplete)
- Right: market clock (live ET time), user avatar with initials
- **Wiring needed:** logged-in user from Supabase, link Screener button to `/screener`, link Charts to `/chart.html` (Phase B2)

### Section 2 — Index Bands (`idx-bands`)
4 horizontal cards across the top showing:
- NASDAQ Composite — price + %change + sparkline (90×42 SVG)
- NYSE Composite
- S&P 500
- VIX
**Data wiring:**
- Polygon: `/v2/aggs/ticker/I:COMP/prev` for NASDAQ, `/v2/aggs/ticker/I:NYA/prev` for NYSE, `/v2/aggs/ticker/I:SPX/prev` for S&P, `/v2/aggs/ticker/I:VIX/prev` for VIX
- Sparkline: `/v2/aggs/ticker/I:SPX/range/1/day/<from>/<to>` last 30 days
- Refresh: every 60s during market hours, every 5min after-hours
- Cache via _svCache with 60s TTL

### Section 3 — AI Summary Strip (`ai-strip`)
Single full-width card with:
- AI icon
- Title "Today's market" + timestamp
- 2-3 sentence narrative summary (e.g., "Tech leads with NVDA up 3.2%, energy lags after oil dips. Strong volume in financials.")
**Data wiring:**
- Compute server-side via Anthropic API call
- Inputs: top 5 gainers/losers from Polygon snapshot, sector ETF performance (XLK, XLE, XLF), VIX move
- Cache result for 15 minutes
- Edge Function `dashboard-ai-summary` (NEW — needs to be created)

### Section 4 — Main Body Grid (3-column layout)

#### 4a. Left/Center — Watchlist (`wl-`)
- Table view of user's watched tickers
- Columns: Ticker | Price | Change% | Volume | 1D mini-chart | News count badge
- Click ticker → opens chart workspace (Phase B2)
- Click news badge → expands news drawer for that ticker
**Data wiring:**
- Read from Supabase `user_watchlists` table (filtered by user_id, list_name='default')
- Per-ticker live quote: Polygon snapshot endpoint
- News count: query Polygon news API filtered to ticker, count results since 00:00 ET
- Refresh quotes every 30s, news every 5min

#### 4b. Right — Signals Sidebar (`signals-`)
- Vertical list of recent BUY/SELL/HOLD signals
- Each: ticker, signal type, confluence score, timestamp
- "View all" button → screener.html with filter pre-applied
**Data wiring:**
- Compute client-side from `_svCache` (existing screener cache structure)
- For each watched ticker: pull RSI, MACD, EMA cross from ta_cache
- Apply Smart Candle Engine v2.1 logic (already in screener.html — reusable)
- Sort by recency + signal strength

### Section 5 — News Section (`news-`)
- Horizontal scrolling cards or tabbed view
- Tabs: "All Watchlist" | "Top Stories" | "Earnings" | "Crypto"
- Each card: source logo, headline, ticker chip(s), timestamp, sentiment indicator
**Data wiring:**
- Polygon news API: `/v2/reference/news?limit=50&ticker={watchlist}`
- Sentiment: parse Polygon's `insights` field (positive/negative/neutral)
- Cache 5min, refresh in background

### Section 6 — Movers Bottom (`movers-`)
Two side-by-side mini-tables:
- **Top Gainers** (top 10 by % change today)
- **Top Losers** (bottom 10)
**Data wiring:**
- Polygon: `/v2/snapshot/locale/us/markets/stocks/gainers?limit=10`
- Polygon: `/v2/snapshot/locale/us/markets/stocks/losers?limit=10`
- Refresh every 60s during market hours
- Click row → open ticker in chart

---

## 🔧 What needs to be built/changed in code

### NEW FILES
1. **`/public/dashboard.html`** — main file (~1500-2000 lines, vanilla HTML+CSS+JS)
2. **`supabase/functions/dashboard-ai-summary/index.ts`** — Edge Function for Anthropic-powered market summary

### MODIFIED FILES
3. **`/public/screener.html`** — add nav link to `/dashboard` in user menu
4. **`/src/index.js`** (CF worker) — route `/dashboard` and `/dashboard.html` to dashboard asset

### NEW SUPABASE TABLES (if needed)
- `dashboard_ai_cache` — stores last AI summary with TTL (avoid re-calling Anthropic on every page load)
  ```sql
  CREATE TABLE dashboard_ai_cache (
    cache_key text PRIMARY KEY,
    summary text NOT NULL,
    sources jsonb,
    generated_at timestamptz DEFAULT NOW(),
    expires_at timestamptz
  );
  ```

### NEW SECRETS
- `ANTHROPIC_API_KEY` — for the AI summary Edge Function

---

## 🔒 Auth / Tier Gating Strategy

| Feature | Free | Pro | Premium |
|---------|------|-----|---------|
| Index bands | ✅ | ✅ | ✅ |
| AI summary | ❌ (preview blur) | ✅ | ✅ |
| Watchlist (max items) | 5 | 25 | unlimited |
| Watchlist live refresh | 5min | 30s | 30s |
| Signals sidebar | ❌ | ✅ | ✅ |
| News | ✅ (delayed 15min) | ✅ live | ✅ live |
| Top movers | ✅ | ✅ | ✅ |

Reuse existing tier-check logic from screener.html (`AUTH.profile.tier_id`).

---

## 📋 Execution order for tomorrow's session

### Phase 1 — Scaffold (30 min)
- [ ] Copy mockup-v5 → `/home/claude/dashboard-build/dashboard.html`
- [ ] Strip placeholder data, add Supabase auth boilerplate from screener.html
- [ ] Wire CF worker route `/dashboard` and verify it serves
- [ ] Test sign-in flow, redirect from index.html when authed

### Phase 2 — Index Bands (45 min)
- [ ] Wire Polygon calls for 4 indices
- [ ] SVG sparkline rendering from 30-day aggs
- [ ] Auto-refresh logic (different rates market vs after-hours)
- [ ] Color coding (green/red/yellow for VIX)

### Phase 3 — Watchlist (60 min)
- [ ] Read user_watchlists from Supabase
- [ ] Per-ticker quote fetch + render
- [ ] Mini-chart sparklines
- [ ] News count badges
- [ ] Click handlers (expand news drawer, link to chart)
- [ ] Free-tier "max 5" enforcement with upsell

### Phase 4 — Top Movers (30 min)
- [ ] Polygon gainers/losers endpoints
- [ ] Two side-by-side tables
- [ ] Click → open ticker

### Phase 5 — News Section (45 min)
- [ ] Polygon news API integration
- [ ] Tabbed UI
- [ ] Sentiment badges
- [ ] Card layout

### Phase 6 — Signals Sidebar (45 min)
- [ ] Reuse computeSmartCandles + SmartDecay from screener.html
- [ ] Filter to watchlist tickers
- [ ] Sort by signal strength
- [ ] "View all" → screener.html with filter URL params

### Phase 7 — AI Summary (90 min)
- [ ] Build Edge Function `dashboard-ai-summary` with Anthropic call
- [ ] Cache table + TTL logic (15min)
- [ ] Front-end fetch + render
- [ ] Free-tier blur with upgrade CTA

### Phase 8 — Polish & Deploy (30 min)
- [ ] Mobile responsive review (phase C will fully address; just don't break it)
- [ ] Check all tier gates
- [ ] Deploy via wrangler
- [ ] Verify on stockvizor.com/dashboard
- [ ] Update screener.html nav link

**Total estimated: 6-7 hours of focused work.** Can split across 2 sessions if needed.

---

## ⚠️ Open questions for tomorrow's discussion

Before we start coding, please confirm:

1. **Default landing page** — should signed-in users land on `/dashboard` instead of `/screener`?
2. **AI summary tone** — bullet list of facts, or narrative paragraph? Mockup has narrative.
3. **Watchlist sync source** — Supabase only, or also localStorage fallback for offline?
4. **News provider** — Polygon news only, or also fetch from a second source for redundancy?
5. **Auto-refresh rates** — confirm:
   - Index bands: 60s during market hours
   - Watchlist quotes: 30s
   - News: 5min
   - AI summary: 15min cache, refresh on page load if expired
6. **Top movers scope** — all stocks in market, or limited to S&P 500? Limited to NASDAQ?
7. **Anthropic API key** — do you have an Anthropic console account ready, or do we need to set that up?

---

## 📁 Files to reference tomorrow

- `/mnt/project/mockup-v5.html` — base layout (35 KB)
- `/mnt/project/mockup-v4.html` — chart workspace (Phase B2, save for later)
- `/mnt/project/screener.html` — auth, _svCache, tier-check patterns to reuse
- `/mnt/user-data/outputs/phase-a-watchlist.sql` — already-deployed watchlist schema
- `/mnt/project/index.js` — Cloudflare worker (will need 1-2 new routes)

---

## 🔗 Production state going into tomorrow's session

- ta-batch v31 deployed, 70ms sleeps, **cron now `*/3 * * * *`** (just changed)
- All 4 cron 401 bugs fixed
- ta_cache `updated_at` trigger live
- monitor.html with Pause/Resume/Reset buttons live
- Apr 24 batch will be `complete` by tomorrow morning
- Production ticker_universe: 1,481

## Pending after dashboard

- **Phase B2** — chart.html with mockup-v4 workspace + screener.html chart canvas
- **Phase C** — mobile responsive audit across all pages
- **Phase D** — VizorBuys/VizorShorts (SQL ready at phase1-vizor-tables.sql, not deployed)
- **GitHub push** — sync dcostapower-ops/optionlens

---

## 🗝️ Credentials reference

Both tokens previously listed here were rotated on 2026-05-03 — the originals are revoked. Active credentials are stored in your password manager and must never be committed.

- Cloudflare deploy token: stored in password manager
- Supabase Personal Access Token: stored in password manager
- Supabase project ref: `hkamukkkkpqhdpcradau` (not a secret — public project slug)
- Admin user: `fdcosta@yahoo.com` (only is_admin=true user)
