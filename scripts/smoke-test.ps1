param(
  [Parameter(Mandatory=$false)]
  [string]$BaseUrl = "http://127.0.0.1:8788"
)

$ErrorActionPreference = "Stop"

function Test-Endpoint {
  param(
    [string]$Path,
    [int]$ExpectedStatus = 200,
    [switch]$ExpectJson
  )

  $url = "$BaseUrl$Path"
  try {
    $resp = Invoke-WebRequest -UseBasicParsing $url
  } catch {
    throw "FAIL $url request error: $($_.Exception.Message)"
  }

  if ($resp.StatusCode -ne $ExpectedStatus) {
    throw "FAIL $url expected $ExpectedStatus got $($resp.StatusCode)"
  }

  if ($ExpectJson) {
    try {
      $null = $resp.Content | ConvertFrom-Json
    } catch {
      throw "FAIL $url expected JSON response"
    }
  }

  Write-Host "PASS $url [$($resp.StatusCode)]"
}

Write-Host "Running smoke tests against $BaseUrl"

Test-Endpoint -Path "/"
Test-Endpoint -Path "/v"
Test-Endpoint -Path "/s"
Test-Endpoint -Path "/api/dashboard/index" -ExpectJson
Test-Endpoint -Path "/api/dashboard/ticker/AAPL" -ExpectJson
Test-Endpoint -Path "/api/db/quote_cache?select=symbol,last_price&limit=1" -ExpectJson

Write-Host "Smoke tests complete: PASS"
