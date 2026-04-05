[CmdletBinding()]
param(
  [string]$OllamaBaseUrl = "http://127.0.0.1:11434",
  [string]$OllamaModel = "qwen2.5-coder:14b",
  [int]$MaxTools = 26,
  [string]$LogLevel = "debug",
  [int]$Port = 8000,
  [string]$BindHost = "127.0.0.1"
)

$env:OLLAMA_BASE_URL = $OllamaBaseUrl
$env:OLLAMA_MODEL = $OllamaModel
$env:SHIM_MAX_TOOLS = "$MaxTools"
$env:SHIM_LOG = $LogLevel
$env:PORT = "$Port"
$env:HOST = $BindHost

Write-Host "Starting shim -> $($env:OLLAMA_BASE_URL) ($($env:OLLAMA_MODEL)) on http://$BindHost`:$Port"
node "$PSScriptRoot\src\server.mjs"
