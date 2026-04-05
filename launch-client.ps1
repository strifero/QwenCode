[CmdletBinding()]
param(
  [string]$BaseUrl = "http://127.0.0.1:8000",
  [string]$ApiKey = "dummy",
  [string]$Model = "",
  [string]$ClientCommand = "claude",
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$ClientArgs
)

$env:ANTHROPIC_BASE_URL = $BaseUrl
$env:ANTHROPIC_API_KEY = $ApiKey
$compatHeaderName = 'CLAUDE_CODE_' + 'ATTRIBUTION_HEADER'
Set-Item -Path ("Env:{0}" -f $compatHeaderName) -Value "0"

$argsToRun = @()
if ($Model) {
  $argsToRun += "--model"
  $argsToRun += $Model
}
if ($ClientArgs) {
  $argsToRun += $ClientArgs
}

Write-Host "Launching Claude Code against $($env:ANTHROPIC_BASE_URL)"
Write-Host "Claude Code compatibility header applied"
& $ClientCommand @argsToRun
