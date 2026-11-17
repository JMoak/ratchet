<#
Open a hidden-input prompt and store the key in Windows Credential Manager, or launch an
allowlisted experiment with that credential in its process environment. Never prints a key.
#>
param(
  [ValidateSet("Set", "Run")][string]$Action = "Set",
  [ValidateSet("tournament", "decision-packs", "forge")][string]$Experiment = "decision-packs",
  [ValidateRange(1, 25)][int]$Budget = 5,
  [string]$Cases = ""
)
$ErrorActionPreference = "Stop"
$workspace = Split-Path -Parent $PSScriptRoot
$credentialTarget = "ratchet/OpenRouter"
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class RatchetCredential {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct Credential {
    public UInt32 Flags;
    public UInt32 Type;
    public string TargetName;
    public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public UInt32 CredentialBlobSize;
    public IntPtr CredentialBlob;
    public UInt32 Persist;
    public UInt32 AttributeCount;
    public IntPtr Attributes;
    public string TargetAlias;
    public string UserName;
  }
  [DllImport("advapi32.dll", EntryPoint="CredWriteW", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool Write(ref Credential credential, UInt32 flags);
  [DllImport("advapi32.dll", EntryPoint="CredReadW", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool Read(string target, UInt32 type, UInt32 flags, out IntPtr credential);
  [DllImport("advapi32.dll")]
  public static extern void CredFree(IntPtr buffer);
}
'@

if ($Action -eq "Set") {
  $Host.UI.RawUI.WindowTitle = "Ratchet - secure OpenRouter key entry"
  Write-Host "Paste the new OpenRouter key below, then press Enter. Input is hidden."
  Write-Host "It will be stored in Windows Credential Manager as ratchet/OpenRouter."
  Write-Host "The key will not be printed or written to the repository."
  $secret = Read-Host "OpenRouter key" -AsSecureString
  if ($secret.Length -eq 0) { throw "No key entered; nothing saved." }
  $pointer = [Runtime.InteropServices.Marshal]::SecureStringToCoTaskMemUnicode($secret)
  try {
    $credential = New-Object RatchetCredential+Credential
    $credential.Type = 1
    $credential.TargetName = $credentialTarget
    $credential.Comment = "Ratchet decision experiments"
    $credential.CredentialBlobSize = $secret.Length * 2
    $credential.CredentialBlob = $pointer
    $credential.Persist = 2
    $credential.UserName = $env:USERNAME
    if (-not [RatchetCredential]::Write([ref]$credential, 0)) {
      throw "Windows Credential Manager could not save the credential."
    }
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeCoTaskMemUnicode($pointer)
    $secret.Dispose()
  }
  $statusDir = Join-Path $workspace "experiments/out"
  [IO.Directory]::CreateDirectory($statusDir) | Out-Null
  [IO.File]::WriteAllText((Join-Path $statusDir "credential-status.json"), ('{"saved":true,"savedAt":"' + [DateTime]::UtcNow.ToString("o") + '"}'))
  Write-Host "Saved securely. You can close this window."
  Read-Host "Press Enter to close" | Out-Null
  exit 0
}

$credentialPointer = [IntPtr]::Zero
if (-not [RatchetCredential]::Read($credentialTarget, 1, 0, [ref]$credentialPointer)) {
  throw "No saved Ratchet credential. Run this script with -Action Set first."
}
try {
  $stored = [Runtime.InteropServices.Marshal]::PtrToStructure($credentialPointer, [type][RatchetCredential+Credential])
  $processKey = [Runtime.InteropServices.Marshal]::PtrToStringUni($stored.CredentialBlob, $stored.CredentialBlobSize / 2)
  $env:OPENROUTER_API_KEY = $processKey
} finally { [RatchetCredential]::CredFree($credentialPointer) }
try {
  Set-Location -LiteralPath $workspace
  $experimentArgs = @("--live", "--budget=$Budget")
  if ($Experiment -eq "forge") {
    if ($Cases) { $experimentArgs += "--cases=$Cases" } else { $experimentArgs += "--demo" }
  } elseif ($Cases) { throw "-Cases is only supported for the forge experiment." }
  & node --experimental-transform-types (Join-Path $workspace "experiments/$Experiment/main.ts") @experimentArgs
  $runExitCode = $LASTEXITCODE
} finally {
  Remove-Item Env:OPENROUTER_API_KEY -ErrorAction SilentlyContinue
  $processKey = $null
}
exit $runExitCode
