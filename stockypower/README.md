# Stockypower

Type a stock symbol and get a **BUY / SELL** call from **Stocky**, your Claude Managed Agent.
For each symbol, Stockypower starts a Stocky session. Stocky pulls the symbol's history
from the **Massive** (formerly Polygon.io) stocks developer feed, runs the indicators it was
programmed with, and returns a verdict. The page shows the call, Stocky's confidence, and
each indicator's reading. Recent symbols are kept as one-click chips.

```
Browser ──POST /api/analyze──▶ server.mjs ──Managed Agents API──▶ Stocky (agent_01Vs8…, env_01Djvq…)
   ◀──── live progress (SSE) ────┘     │                              │
                                       └─ Massive snapshot (backup)   └─ Massive live (via vault)
```

## Setup on Windows (easiest)

1. Install **Node.js LTS** from https://nodejs.org if you don't have it.
2. Open the `stockypower` folder and **double-click `setup.bat`**.
   - Or, to skip typing: right-click `setup.bat` → **Edit** (or open it in Notepad), put
     your keys in the two lines `set "ANTHROPIC_KEY="` and `set "MASSIVE_KEY="` near the top,
     for example `set "ANTHROPIC_KEY=sk-ant-api03-..."`, save, then double-click it. Don't share
     the file afterwards.
3. When asked, paste your **Anthropic API key**, then your **Massive API key**. Right-click
   pastes in the black window. What you paste stays hidden.
   - Each key is tested right away. If one is wrong, the window explains why and asks again.
   - Your Anthropic key must come from https://platform.claude.com → **API Keys**, in the
     **same workspace as Stocky**.
4. Setup saves the keys to `.env`, connects Stocky to Massive, starts Stockypower, and opens
   http://localhost:8790.

To get a newer version later, **double-click `update.bat`**. It downloads the latest files
into this same folder, keeps your `.env` and `setup.bat` (your keys) as they are, and starts
the app.

After that, **double-click `start.bat`** to run Stockypower. Keep its window open while you
use the app, and close it to stop. Run `setup.bat` again whenever you change a key.

Keys in `.env` take priority over any `ANTHROPIC_API_KEY` set in Windows itself, so an old
key stored in Windows can't get in the way.

## Setup from a terminal (any OS)

You need Node 20.12 or newer.

```bash
cd stockypower
npm install
npm run setup     # asks for both keys, tests them, writes .env, connects Massive
npm start
```

Or by hand: copy `.env.example` to `.env`, fill in the keys below, and run
`npm run connect-massive`.

| Variable | What it is |
|---|---|
| `ANTHROPIC_API_KEY` | API key from the Claude Console workspace where Stocky lives |
| `MASSIVE_API_KEY` | Your Massive stocks developer subscription key |
| `STOCKY_AGENT_ID` / `STOCKY_ENVIRONMENT_ID` | Already filled in with Stocky's IDs |
| `STOCKY_VAULT_ID` | Written for you by setup / `connect-massive` |

What `connect-massive` does:

1. Stores your Massive key in an Anthropic **vault** as the `MASSIVE_API_KEY` environment-variable
   credential. Stocky's sandbox only ever sees a placeholder. Anthropic substitutes the real key
   into request headers on the way out, and only for `api.massive.com` and `api.polygon.io`.
2. If Stocky's environment uses `limited` networking, adds those two hosts to its `allowed_hosts`.
3. Writes `STOCKY_VAULT_ID` to `.env` so every session attaches the vault.

## How Stocky gets Massive data

Stocky gets the data two ways, so it still has data if one fails:

- **Live.** With the vault attached, the prompt tells Stocky to call Massive with
  `Authorization: Bearer $MASSIVE_API_KEY`. The key has to go in that header: a key in the
  URL (`?apiKey=`) is not substituted.
- **Snapshot.** If `MASSIVE_API_KEY` is set, Stockypower also downloads about 2 years of
  adjusted daily bars (`STOCKY_HISTORY_YEARS`) and mounts them in the session at
  `/workspace/data/<SYMBOL>_daily.csv`.

The startup log shows which of the two are active.

## Timeframes, levels and charts

Stocky does the calculations and the app draws everything.

- **Timeframes:** 15 min, 1 hour, 4 hours, 1 day, 1 week, 1 month. Click a timeframe, or a row
  in the table, to switch instantly. Switching doesn't start a new Stocky run.
- **Sessions:** intraday bars are regular trading hours only (09:30–16:00 New York), like
  TradingView's default. 1h and 4h bars are built from 30-minute bars anchored at the open
  (1h: 9:30, 10:30 … 15:30; 4h: 9:30 and 13:30). Massive's own hourly bars are clock-aligned
  and include extended hours, so they don't match. Set `STOCKY_EXTENDED_HOURS=1` to include
  pre/after-market bars.
- **Data:** for each timeframe, the server loads up to 500 Massive candles. It shows them on
  the chart and mounts the same candles in Stocky's session as CSV files (`/workspace/data/`),
  so Stocky's numbers line up with what you see.
- **Stocky's results:** for every timeframe, Stocky writes `/mnt/session/outputs/stockypower.json`
  with: signal, confidence, Target 1/2, Stop loss 1/2, forecast high/low for the next bar
  (next 15 min, hour, 4 hours, day, week or month), a 10-bar forecast path, and its
  indicator series.
- **Chart:** TradingView Lightweight Charts (bundled in `public/vendor/`). Candles plus Stocky's
  overlay indicators, panel indicators such as RSI or MACD in their own pane, the forecast
  path and range, and labelled T1/T2/SL1/SL2 lines with forecast high/low. Times are New York
  market time.

## Indicators and speed

The app calculates the two indicators from the user's TradingView layout itself (`lib/indicators.mjs`),
draws them as soon as the candles load, and adds them as columns to the CSVs Stocky reads:

- **Smoothed HA** (from its Inputs tab): HA price input smoothing 12, Exponential; double-smoothing
  3, Exponential; wicks on; bullish yellow, bearish purple. That's EMA(12) of OHLC, then
  Heikin-Ashi, then EMA(3) of the HA OHLC. The ALMA sigma/offset only apply to ALMA. It's drawn
  as its own candles alongside the green/red Heikin-Ashi candles.
- **Ultra RSI [DW]** (from its Inputs tab): Source close, Sampling Period 12, Filter Type EMA,
  RSI Type Standard, Volume Type Default, levels 75/25. With these choices it is a standard RSI
  whose gains/losses are averaged with EMA(12), no volume weighting. The ALMA, KAMA and Laguerre
  inputs don't apply.

On the chart, the price bars are standard Heikin-Ashi candles, green/red (toggle: regular
candles), with the Smoothed HA candles in yellow/purple alongside them. Ultra RSI [DW] is
drawn with its Style-tab colours: a 5-colour RSI line, per-bar shaded fill to the 50 midline
(orange), and green 75 / red 25 threshold lines. All of this matches the TradingView layout.

Stocky then only writes its decisions and levels, not chart data, which is much faster.
Results are remembered per symbol for `STOCKY_CACHE_MINUTES` (default 10; 0 turns it off).
Re-entering a symbol in that window is instant, and **Run again** forces a fresh run.

## Live chart and alerts

While a result is open, the page asks the server for the newest Massive bars every
`STOCKY_LIVE_SECONDS` (default 60; 0 turns it off). The server re-fetches only the last few
days, merges them in, and recalculates Heikin-Ashi, Smoothed HA and Ultra RSI. Stocky isn't
called, so this costs nothing. Updates pause while the tab is hidden, and your zoom and scroll
position are kept.

The label says how fresh the data is. The Massive Stocks Developer plan is 15 minutes delayed
(`MASSIVE_DELAY_MINUTES=15`; set 0 for a real-time plan). Stocky's TP/SL/forecast stay as
calculated until **Run again**.

Alerts, for the timeframe you're viewing, appear in the card (and as desktop notifications if
you switch them on): price crossing Target 1/2 or Stop loss 1/2, Smoothed HA turning bullish
or bearish, and Ultra RSI crossing 50, 75 or 25.

## Best Option Chains

The **Best Option Chains** menu scans every listed contract expiring more than N days out
(default: more than 60) for one or more symbols, using Massive's options chain snapshot
(`/v3/snapshot/options/{symbol}`; the API key must include the options plan). It picks the
5 best calls and 5 best puts to buy (`lib/options.mjs`):

1. **Strikes preference:**
   - **Balanced** (default): |delta| 0.25–0.75, best near 0.55.
   - **At / out of the money:** in-the-money strikes left out, |delta| 0.25–0.60, best near 0.45.
   - **In the money:** out-of-the-money strikes left out, |delta| 0.45–0.85, best near 0.65.

   ATM (strike within 2% of the price) is always allowed.

   **Filters:** two-sided quote, |delta| in the preference's range, open interest ≥ 500
   (adjustable), volume ≥ 10,
   bid/ask spread under 15%. **Out-of-the-money** contracts must also have at least a 70%
   (adjustable) chance of the stock reaching the strike at some point before expiry. This is
   the probability of touch, using the stock's 30-day realized volatility and the time left.
   Each row shows that chance, plus the chance of finishing beyond breakeven at expiry.
2. **Score 0–100:**

   | Factor | Weight |
   |---|---|
   | delta, best near 0.55 | 15% |
   | cheap IV (vs realized volatility over a matching horizon, and vs the chain) | 15% |
   | cheap premium (vs fair value at that realized volatility) | 15% |
   | chance of profit at expiry (finishing beyond breakeven) | 15% |
   | agreement with Stocky's latest 1-day and 1-week call (BUY for calls, SELL for puts) | 15% |
   | liquidity: open interest + volume + spread | 15% |
   | low time decay (what a flat stock costs over 30 days) | 10% |

   Liquidity gets full marks once a contract is comfortably tradable (open interest 1,000+,
   volume 200+), so sheer size doesn't outrank otherwise better contracts. The Stocky factor
   is used only if Stocky analyzed the stock in the last 7 days; otherwise its weight is shared
   across the rest. Fair value uses realized volatility matched to the time to expiry: 30-day
   for near dates, blending to 1-year by a year out.
3. **Top 5 by score, at most 2 from the same expiry date, ordered most profitable first.**
   An optional "at most N days" limit excludes far-dated expiries. "Estimated return" assumes a typical
   favorable 30-day move (one standard deviation of realized volatility). The option is
   repriced with Black-Scholes at its current IV and assumed bought at the ask. It's a common
   yardstick for comparing contracts, not a prediction. The page also shows the return if the
   stock stays flat for 30 days (time decay), the breakeven at expiry, and the cost per contract.
   Each row has its own **Expiry** column (date and days left) and **Premium** column (ask per
   share, total per contract, and time value per day).

**Outside regular hours** (before 9:30 or after 16:00 New York, or weekends), option quotes
are frozen at the close, while the stock keeps trading after hours. So the scan uses the
official regular-session close (`/v1/open-close`) as the stock price for every calculation.
The after-hours / pre-market price is shown separately.

Click a row for its score breakdown and greeks. **Compare expiry dates** lists the best call
and put on every expiry date with each factor's score, so you can see why some dates were
picked and others weren't.

**Live:** quotes, greeks, IV, open interest and volume come from the Massive Options Advanced
real-time feed. While results are on screen, the scan reruns every `OPTIONS_REFRESH_SECONDS`
(default 60; 0 turns it off) and the tables update in place. An open row stays open if that
contract is still in the top 5. Refreshing pauses when you switch menus or hide the tab.
**Refresh now** rescans immediately.

### Profit horizon

- **Next 30 days (typical move):** the default. "Est. return" assumes a 1-standard-deviation
  favorable move over 30 days.
- **Next 5 sessions (Stocky's 1-day target):** for when the move is expected soon, so time to
  expiry matters less. It uses Stocky's latest 1-day Target 1: above the price when the
  1-day call is BUY (calls), below it when SELL (puts). For each contract it computes:
  - the chance of reaching the target within about 5 sessions (probability of touch, recent
    volatility);
  - the return if it does (repriced at the target);
  - the return if the stock stays flat.

  The **expected return** (chance × target return + (1 − chance) × flat return) ranks the
  picks. A "short-term payoff" factor gets 20%, time decay drops to 5%, and IV, premium and
  chance of profit fall to 10% each. Only contracts with a matching Stocky target qualify. If
  Stocky's daily call doesn't point that side's way, or there's no recent analysis, that side
  shows **no picks**, with the reason (for example "Stocky's latest 1-day call is SELL, see the
  puts"). There's no fallback to the 30-day method, because that would recommend long-dated
  options for a short-term trade.

  Choosing this horizon sets **Strikes → At / out of the money** and **Expiring more than →
  21 days**. Both stay editable, and switching back restores Balanced and 60 days. Strikes
  beyond Stocky's target are excluded: such a call or put would still be out of the money even
  if Stocky is exactly right.

### Self-check

**Run self-check** (next to Refresh now) runs a fresh scan, then verifies it (`lib/selfcheck.mjs`):

- **Live data:** each pick is re-fetched on its own from Massive (contract, bid/ask, delta, IV,
  open interest, volume).
- **Filters:** each filter is re-tested.
- **Maths:** spread, cost, breakeven, fair value, premium vs fair, both probabilities, both
  returns and the weighted score are recomputed with separately written formulas.
- **Selection:** most profitable first, at most 2 per expiry, no better-scoring contract skipped.
- **Coverage:** the full chain is counted again across all pages, with no expiries inside the
  minimum.
- **Inputs:** realized volatility is recomputed from fresh daily prices.

The page shows pass / warning / fail, and **Copy report** gives a plain-text report with no keys.

## History & accuracy

The **History & accuracy** tab grades every saved call (`data/predictions.jsonl`, one row per
timeframe per run) against the Massive bars that came after it (`lib/history.mjs`):

- **Won:** Target 1 reached before Stop loss 1, or Target 2 if it then got there before the stop.
- **Stopped:** Stop loss 1 came first. A bar that touched both counts as stopped.
- **Expired:** neither was reached within 30 bars; the result is taken at that bar's close.
- **Open:** still running.

On top of that it reports how often price moved the predicted direction after the 10-bar
forecast, whether the next bar stayed within the forecast high/low, the forecast path's
average miss versus actual closes, and the average result per closed call (percent from
entry, before costs). Everything is broken down by timeframe, by symbol, and by whether
the accuracy checks passed at the time. The page warns while fewer than 20 calls are decided,
because rates from a handful of calls aren't meaningful.

Click any call to see its chart: the bars Stocky had seen (dimmed), the bars that followed,
the entry, TP/SL levels, Stocky's forecast at the time, and where the call was decided, plus
Stocky's reasoning and any check warnings from that moment.

## Accuracy checks and track record

A forecast can't be guaranteed, so every level is checked and every call is tracked:

- **Checks**, per timeframe, against Massive's real data: Stocky's price matches the latest
  close; for BUY, `SL2 < SL1 < price < T1 < T2` (mirrored for SELL); forecast high ≥ price ≥
  forecast low; levels within a sensible number of ATRs for the timeframe; the stop isn't
  inside normal noise. Failures appear as a ⚠ list instead of looking trustworthy.
- **Track record:** each call is saved to `data/predictions.jsonl`, which stays on your PC and
  isn't in git. Later runs on the same symbol score earlier calls against the candles that
  came after: Target 1, Target 2 or stop hit first (a bar that hits both counts as stopped
  out), and whether the next bar stayed under the forecast high.

## Using it from the web

Before Stockypower is reachable from the internet, set a password in `.env`:

```
APP_PASSWORD=choose-a-long-password
```

The browser then asks for a login. The user is `stocky` (change it with `APP_USER`).
Without a password, anyone who finds the address could run Stocky on your Anthropic account.

## If Stocky's levels don't come through

The app looks for Stocky's results in this order: the `stockypower.json` file in the session
outputs (it waits up to ~15 s for the file to appear), then a `<<<STOCKYPOWER_JSON … STOCKYPOWER_JSON>>>`
block or a JSON code block in Stocky's reply, then the `VERDICT_JSON` line. Timeframe and field
names are matched loosely (`15min`, `hourly`, `daily`, `tp1`, `sl1`, nested `levels`, and so on),
and small JSON mistakes such as `NaN` or trailing commas are repaired.

If nothing usable is found after the first answer, the app asks Stocky once, in the same
session, to resend the results both ways. If it still fails, the page shows why, and the raw
reply and file are saved to `data/last-run-<SYMBOL>.json`.


- **Tool approvals.** If Stocky's tool permissions pause a call for approval, the page shows
  **Allow / Deny** buttons. If nobody answers within 5 minutes, or the tab is closed, the call
  is denied.
- **Verdict format.** Stocky is asked to end its answer with a `VERDICT_JSON:` line. If that
  line is missing, Stockypower falls back to the last BUY/SELL/HOLD word in Stocky's text.
  You can read Stocky's full analysis in each result card.
- **Sessions.** Each symbol creates one session, titled `Stockypower: <SYMBOL>`. You can
  inspect it in the Console under Managed Agents → Sessions.
- **Secrets.** Never commit `.env`. The repo's `.gitignore` already excludes it.

Signals are Stocky's indicator readings, not financial advice.
