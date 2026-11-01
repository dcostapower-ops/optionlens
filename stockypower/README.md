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

## Forecast graphs

Each result card can show two kinds of graph:

- **Forecast chart.** The app draws it from the last ~6 months of Massive prices plus the
  forecast points Stocky returns (expected price, with a low/high range), out to Stocky's horizon.
- **Stocky's own charts.** Stocky is asked to save its forecast graphs as PNG files in
  `/mnt/session/outputs/`. Stockypower downloads any images Stocky saved there and shows them
  in the card. Click one to open it full size.

If Stocky returns neither, the card says so.

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
