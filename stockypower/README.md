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

## Notes

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
