param(
  [Parameter(Mandatory=$false)]
  [string]$RepoPath = "C:\Users\Franklin\Apps\StockVizor\github_optionlens",
  [Parameter(Mandatory=$false)]
  [string]$SupabaseProjectRef = "hkamukkkkpqhdpcradau",
  [Parameter(Mandatory=$false)]
  [string]$LocalBaseUrl = "http://127.0.0.1:8788",
  [Parameter(Mandatory=$false)]
  [string]$ProdBaseUrl = "https://stockvizor.com",
  [switch]$Push
)

$ErrorActionPreference = "Stop"
Set-Location $RepoPath

Write-Host "Step 1/6: Local smoke test"
& .\scripts\smoke-test.ps1 -BaseUrl $LocalBaseUrl
if ($LASTEXITCODE -ne 0) { throw "Local smoke test failed" }

Write-Host "Step 2/6: Deploy StockVizor Supabase functions"
& .\scripts\deploy-supabase-stockvizor.ps1 -RepoPath $RepoPath -ProjectRef $SupabaseProjectRef
if ($LASTEXITCODE -ne 0) { throw "Supabase function deploy failed" }

Write-Host "Step 3/6: Deploy to Cloudflare"
& npx wrangler@latest deploy
if ($LASTEXITCODE -ne 0) { throw "Deploy failed" }

Write-Host "Step 4/6: Production smoke test"
& .\scripts\smoke-test.ps1 -BaseUrl $ProdBaseUrl
if ($LASTEXITCODE -ne 0) { throw "Production smoke test failed" }

Write-Host "Step 5/6: Git status"
& git status --short

if ($Push) {
  Write-Host "Step 6/6: Commit and push"
  & git add -A
  & git commit -m "Release: tested local + production smoke pass"
  & git push origin main
} else {
  Write-Host "Step 6/6: Push skipped (use -Push to auto-push after verification)"
}

Write-Host "Release gate complete"
