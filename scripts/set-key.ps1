<#
.SYNOPSIS
  Prompt for API keys with hidden input and write them to the repo's .env file.
  The key is never printed; only a masked form and its length are shown.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File C:\src\ratchet\scripts\set-key.ps1
  powershell -ExecutionPolicy Bypass -File C:\src\ratchet\scripts\set-key.ps1 -Name OPENROUTER_API_KEY,TYPESAFE_API_KEY
#>
param(
  [string[]]$Name = @("OPENROUTER_API_KEY"),
  [string]$EnvFile = (Join-Path (Split-Path -Parent $PSScriptRoot) ".env")
)
$ErrorActionPreference = "Stop"

function Read-Secret([string]$label) {
  $secure = Read-Host -Prompt "$label (input hidden; press Enter to skip)" -AsSecureString
  $ptr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try {
    return ([System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)).Trim()
  } finally {
    [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
  }
}

function Mask([string]$v) {
  if ($v.Length -le 10) { return ("*" * $v.Length) }
  return $v.Substring(0, 6) + ("*" * ($v.Length - 10)) + $v.Substring($v.Length - 4)
}

$lines = @()
if (Test-Path $EnvFile) { $lines = @(Get-Content -Path $EnvFile -Encoding UTF8) }

$written = @()
foreach ($n in $Name) {
  $value = Read-Secret "Paste $n"
  if ([string]::IsNullOrWhiteSpace($value)) {
    Write-Host "  skipped $n"
    continue
  }
  if ($n -eq "OPENROUTER_API_KEY" -and -not $value.StartsWith("sk-or-")) {
    Write-Host "  note: OpenRouter keys usually start with sk-or-; writing it anyway"
  }
  $pattern = "^\s*(export\s+)?" + [regex]::Escape($n) + "\s*="
  $kept = @($lines | Where-Object { $_ -notmatch $pattern })
  $lines = $kept + @("$n=$value")
  $written += $n
  Write-Host ("  {0} = {1} ({2} chars)" -f $n, (Mask $value), $value.Length)
}

if ($written.Count -eq 0) {
  Write-Host "Nothing written."
  exit 0
}

$content = ($lines -join "`n") + "`n"
$utf8NoBom = New-Object System.Text.UTF8Encoding $false
[System.IO.File]::WriteAllText($EnvFile, $content, $utf8NoBom)
Write-Host ("Wrote {0} key(s) to {1}" -f $written.Count, $EnvFile)
Write-Host "That file is gitignored. Run the script again to replace a key."
