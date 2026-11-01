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

## Setup

You need Node 20 or newer.

```bash
cd stockypower
npm install
cp .env.example .env
```

Edit `.env` on your machine and fill in:

| Variable | What it is |
|---|---|
| `ANTHROPIC_API_KEY` | API key from the Claude Console workspace where Stocky lives |
| `MASSIVE_API_KEY` | Your Massive stocks developer subscription key |
| `STOCKY_AGENT_ID` / `STOCKY_ENVIRONMENT_ID` | Already filled in with Stocky's IDs |

Then connect Stocky to Massive. This is a one-time step:

```bash
npm run connect-massive
```

That script:

1. Stores your Massive key in an Anthropic **vault** as the `MASSIVE_API_KEY` environment-variable
   credential. Stocky's sandbox only ever sees a placeholder. Anthropic substitutes the real key
   into request headers on the way out, and only for `api.massive.com` and `api.polygon.io`.
2. If Stocky's environment uses `limited` networking, adds those two hosts to its `allowed_hosts`.
3. Writes `STOCKY_VAULT_ID` to `.env` so every session attaches the vault.

You can run it again safely, for example after you rotate the Massive key.

## Run

```bash
npm start
```

Open http://localhost:8790. Enter a symbol, for example `AAPL`, `NVDA` or `BRK.B`.

## How Stocky gets Massive data

Stocky gets the data two ways, so it still has data if one fails:

- **Live.** With the vault attached, the prompt tells Stocky to call Massive with
  `Authorization: Bearer $MASSIVE_API_KEY`. The key has to go in that header: a key in the
  URL (`?apiKey=`) is not substituted.
- **Snapshot.** If `MASSIVE_API_KEY` is set, Stockypower also downloads about 2 years of
  adjusted daily bars (`STOCKY_HISTORY_YEARS`) and mounts them in the session at
  `/workspace/data/<SYMBOL>_daily.csv`.

The startup log shows which of the two are active.

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
