$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')
$secret = Read-Host 'DeepSeek API key (hidden)' -AsSecureString
$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secret)
try {
  $env:DEEPSEEK_API_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
  node --env-file=.env scripts/run-011-deepseek.mjs
  $result = $LASTEXITCODE
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
  Remove-Item Env:DEEPSEEK_API_KEY -ErrorAction SilentlyContinue
  $secret.Dispose()
}
exit $result
