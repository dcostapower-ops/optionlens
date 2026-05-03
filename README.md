# StockVizor — `optionlens`

Stock and ETF analysis software for US retail investors. Live at [stockvizor.com](https://stockvizor.com).

This repository is the deploy source of truth. Three platforms ship from here:

- **Cloudflare Worker + static assets** — `wrangler.toml` + `src/index.js` + `public/`
- **Supabase Edge Functions** — `supabase/functions/<name>/index.ts`
- **Supabase Postgres SQL** — `sql/` (apply via Dashboard for now; see `sql/README.md`)

## Layout

```
.
├── wrangler.toml             # Cloudflare Worker config
├── src/index.js              # Cloudflare Worker (proxies /api/polygon, /api/db, URL obfuscation)
├── public/                   # Static assets served via ASSETS binding
│   ├── index.html            # marketing landing
│   ├── v.html                # /v → dashboard
│   ├── s.html                # /s → screener (formerly screener.html, ~1MB)
│   ├── m.html                # /m → admin monitor
│   ├── auth-tier.js          # auth-tier helpers
│   ├── companyinfo-builder.html
│   ├── gap-analyzer.html
│   ├── universe-manager.html
│   └── manifest.json
├── supabase/
│   ├── config.toml           # project_id linked to hkamukkkkpqhdpcradau
│   └── functions/            # Edge Functions (Deno/TS)
│       ├── ai-summary/
│       ├── movers-fan-out/
│       ├── news-fan-out/
│       ├── quote-fan-out/
│       ├── ta-batch/
│       └── watchlist-classify/
├── sql/                      # Postgres SQL (NOT supabase migrations — see sql/README.md)
└── docs/                     # release notes, tech debt, build plans
```

## Deploy

A full deploy applies changes in this order:

1. **SQL** — apply pending changes via Supabase Dashboard SQL editor (see `sql/README.md`)
2. **Edge Functions** — `supabase functions deploy <name> --project-ref hkamukkkkpqhdpcradau`
3. **Cloudflare Worker + assets** — `wrangler deploy`

A `docs/deploy_full_stack.md` runbook with exact commands and verification steps is forthcoming.

## Project context

The full project context, methodology, product roadmap, and operational guidance are maintained as a Claude Code workspace at `../stockvizorclaude/`. Read `../stockvizorclaude/CLAUDE.md` for routing.
