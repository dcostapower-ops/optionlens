param(
  [Parameter(Mandatory=$false)]
  [string]$RepoPath = "C:\Users\Franklin\Apps\StockVizor\github_optionlens",
  [Parameter(Mandatory=$false)]
  [string]$ProjectRef = "hkamukkkkpqhdpcradau"
)

$ErrorActionPreference = "Stop"
Set-Location $RepoPath

$functions = @(
  "ai-summary",
  "backtest-rsi-batch",
  "backtest-rsi-bear-cross",
  "backtest-rsi-cycles",
  "compute-52w-highs",
  "compute-liquidity-history",
  "compute-run-stats",
  "detect-smart-rsi-daily",
  "etf-shares-pull",
  "generate-research-images",
  "generate-research-macro",
  "generate-research-stocks",
  "iv-batch",
  "leonardo-proxy",
  "movers-fan-out",
  "news-fan-out",
  "quote-fan-out",
  "rotation-refresh",
  "sync-tickers",
  "ta-batch",
  "universe-fan-out",
  "watchlist-classify"
)

Write-Host "Deploying StockVizor Supabase functions (excluding vizardis-*)"
Write-Host "Project: $ProjectRef"

foreach ($fn in $functions) {
  Write-Host "Deploying function: $fn"
  & supabase functions deploy $fn --project-ref $ProjectRef
  if ($LASTEXITCODE -ne 0) {
    throw "Supabase deploy failed for function: $fn"
  }
}

Write-Host "Supabase StockVizor function deploy complete"