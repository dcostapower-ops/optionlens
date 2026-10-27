# Naked Picks — live naked call / naked put dashboard

A standalone Cloudflare Worker, deployed separately from the main StockVizor Worker. Every 5 minutes during the NYSE/NASDAQ regular session it picks the best naked calls and naked puts for a list of large-cap stocks. It pushes the results, plus live bid/ask from the Massive Options Advanced feed, to the dashboard over a WebSocket.

## Selection rules (per stock, calls and puts separately)

| Step | Rule | Implementation (`src/selector.js`) |
|---|---|---|
| 1 | Expiry ≥ 45 days from the trigger date | `dte >= MIN_DTE`, using calendar days in ET. Contracts also need bid > 0, ask ≥ bid, IV, delta and OI > 0 |
| 2a | Highest volume **and** open interest, within the chain and across chains | Liquidity = mean of four percentile ranks: volume and OI inside the contract's own expiry, and volume and OI across all eligible expiries. Keeps the top `LIQUIDITY_POOL` |
| 2b | Cheapest IV among 2a | Keeps the `IV_POOL` lowest-IV contracts |
| 2c | Best delta for that IV | Keeps the `DELTA_POOL` contracts nearest `|Δ| = DELTA_TARGET` inside `[DELTA_MIN, DELTA_MAX]`. If fewer than 3 fall inside the band, it adds the nearest ones outside it (shown as "delta outside band" in the row tooltip) |
| 2d | Most competitive premium | Ranked by annualised bid yield on strike, `bid/strike × 365/DTE`, reduced by the bid/ask spread (`× (1 − min(spread%, 50%))`) |

The dashboard shows the top `ROWS_PER_SIDE` per stock and highlights ranks 1–3. Columns: Stock Code, Expiry Date, Strike, Bid, Ask, IV, Delta.

## How it runs

- **Cron** `*/5 13-21 * * MON-FRI` (UTC) calls the `PicksHub` Durable Object. `src/market-hours.js` skips any tick outside 09:30–16:00 ET, NYSE holidays and 13:00 early closes. Extend the holiday tables each December.
- **REST**: `GET /v3/snapshot/options/{ticker}?expiration_date.gte=…` with strikes limited to ±`STRIKE_RANGE` of spot, all pages.
- **Push feed**: the hub keeps one upstream WebSocket to `wss://socket.massive.com/options` and subscribes `Q.<contract>` for every contract on the dashboard. It batches quote updates once a second to every browser connected to `/ws`. IV and delta refresh on each 5-minute run.
- After the close the hub drops the upstream socket. The last selection stays visible.

Massive normally allows one concurrent WebSocket per asset class per key. If another app already streams options on the same key, one of the two connections will be dropped.

## Deploy

```bash
cd workers/naked-picks
wrangler secret put MASSIVE_API_KEY     # Massive Options Advanced key
wrangler secret put ADMIN_TOKEN         # for manual refresh
wrangler secret put ACCESS_TOKEN        # optional: gate the dashboard feed (?token=)
wrangler deploy
```

Needs the Workers Paid plan, because a run makes more than 50 subrequests. Change the stock list and rule thresholds in `[vars]` in `wrangler.toml`.

Manual run (works outside market hours with `force=1`):

```bash
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" "https://<worker-host>/api/refresh?force=1"
```

## Local

```bash
npm test                 # selector + market-hours unit tests
printf 'MASSIVE_API_KEY=...\nADMIN_TOKEN=dev\n' > .dev.vars
wrangler dev             # http://127.0.0.1:8789
```
