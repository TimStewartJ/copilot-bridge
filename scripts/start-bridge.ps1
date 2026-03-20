# Start Copilot Bridge as a hidden background process
$nodePath = "node"
$workDir = "copilot-bridge"

# Load .env file into current process environment (inherited by child)
$envFile = Join-Path $workDir ".env"
if (Test-Path $envFile) {
  Get-Content $envFile | ForEach-Object {
    if ($_ -match '^\s*([^#][^=]+)=(.*)$') {
      $env = $Matches[1].Trim()
      $val = $Matches[2].Trim()
      Set-Item -Path "Env:$env" -Value $val
    }
  }
}

Start-Process -FilePath $nodePath `
  -ArgumentList "node_modules\tsx\dist\cli.mjs","src\launcher.ts" `
  -WorkingDirectory $workDir `
  -WindowStyle Hidden `
  -RedirectStandardOutput "$workDir\data\bridge.log" `
  -RedirectStandardError "$workDir\data\bridge-error.log"
