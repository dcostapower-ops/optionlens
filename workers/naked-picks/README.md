# Naked Picks — live long call / long put dashboard

A standalone Cloudflare Worker, deployed separately from the main StockVizor Worker. Every 5 minutes during the NYSE/NASDAQ regular session it picks the best single-leg calls and puts **to buy** for a list of large-cap stocks. It pushes the results, plus live bid/ask from the Massive Options Advanced feed, to the dashboard over a WebSocket. Closing trades is out of scope.

## Selection rules (per stock, calls and puts separately)

| # | Rule | Setting (`[vars]` in `wrangler.toml`) |
|---|---|---|
| 1 | Expiry window | 45–365 calendar days from the run date (`MIN_DTE`, `MAX_DTE`) |
| 2 | Delta band | Calls +0.65 to +0.75, puts −0.65 to −0.75 (`DELTA_MIN`, `DELTA_MAX`) |
| 3 | Minimum quality | Open interest ≥ 500, today's volume ≥ 50, bid/ask spread ≤ 5% of mid (`MIN_OPEN_INTEREST`, `MIN_VOLUME`, `MAX_SPREAD_PCT`). Quotes with ask below intrinsic are dropped as stale. |
| 4 | Liquidity | Mean of volume and OI percentile ranks, inside each expiry and across expiries. Keep the top 10 (`LIQUIDITY_POOL`). |
| 5 | Lowest IV | Keep the 6 cheapest IV (`IV_POOL`) |
| 6 | Best price | Rank by least time value paid per day held: `(ask − intrinsic) ÷ DTE ÷ spot`, × (1 + spread%) |
| 7 | Earnings | Flagged (E) when the next earnings date falls before expiry. The date comes from Nasdaq's public analyst endpoint (Zacks data), fetched once per trading day. `*` = estimated. `EARNINGS_OVERRIDES` can pin a date. |
| 8 | Ex-dividend | Calls only: flagged (D) when the next ex-dividend date (Massive `/v3/reference/dividends`) falls before expiry |
| 9 | Output | Up to 5 rows per stock per side, best 3 highlighted. No padding from outside the rules: a stock with fewer than 3 qualifying contracts shows "Only N qualified". |

Ranking by time value per day tends to favour longer expiries, because time value decays more slowly per day further out.

## Dashboard

Long Calls on the left, Long Puts on the right. Each side has:

- **Best 3 across all stocks**: rule 6 ranking across every stock (cost is normalised by spot, so stocks compare fairly).
- **Budget picks**, from the same finalists:
  - *Most affordable*: lowest cost per contract (ask × 100).
  - *Best value*: most stock exposure per $1 paid (`|Δ| × spot ÷ ask`).
- **By stock**: columns Stock Code, Expiry Date, Strike, Bid, Ask, IV, Delta, Time Value, Events.

A strip at the top shows each stock's price and next earnings date; clicking one filters both sides.

## How it runs

- **Cron** `*/5 13-21 * * MON-FRI` (UTC) calls the `PicksHub` Durable Object. `src/market-hours.js` skips any tick outside 09:30–16:00 ET, NYSE holidays and 13:00 early closes. Extend the holiday tables each December.
- **REST**: `GET /v3/snapshot/options/{ticker}?expiration_date.gte=…&expiration_date.lte=…` with strikes limited to ±`STRIKE_RANGE` of spot, all pages.
- **Push feed**: the hub keeps one upstream WebSocket to `wss://socket.massive.com/options` and subscribes `Q.<contract>` for every contract on the dashboard. It batches quote updates once a second to every browser connected to `/ws`. Time value follows the live ask; IV, delta and spot refresh on each 5-minute run.
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
