# StockVizor Release Checklist

This checklist enforces: local test -> deploy -> production test -> GitHub update.

Technical ownership scope: this repo's deployment flow now handles both
Supabase (StockVizor-only functions) and Cloudflare worker deployment.

## Local requirements

- Run local Worker on port `8788` (already configured in `wrangler.toml`)
- Keep OptionStrategy on `8799` to avoid conflict

## One-command gated flow

From repository root:

```powershell
.\scripts\release-gate.ps1
```

What it does:
1. Runs local smoke tests against `http://127.0.0.1:8788`
2. Deploys StockVizor Supabase functions to project `hkamukkkkpqhdpcradau`
3. Deploys with `wrangler deploy`
4. Runs production smoke tests against `https://stockvizor.com`
5. Prints git status

## Auto-push mode

Use only when you want automatic GitHub update after tests pass:

```powershell
.\scripts\release-gate.ps1 -Push
```

## Standalone smoke checks

Local:

```powershell
.\scripts\smoke-test.ps1 -BaseUrl http://127.0.0.1:8788
```

Production:

```powershell
.\scripts\smoke-test.ps1 -BaseUrl https://stockvizor.com
```

## Standalone Supabase function deploy

```powershell
.\scripts\deploy-supabase-stockvizor.ps1
```

This deploys only StockVizor functions and intentionally excludes all `vizardis-*` functions.

## Vizardis scope

Release checks in this repository currently target StockVizor functionality. Vizardis-specific pipelines are out of scope for this checklist by request.
