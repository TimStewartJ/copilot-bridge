# Start Copilot Bridge as a hidden background process
$nodePath = "node"
$workDir = "copilot-bridge"

Start-Process -FilePath $nodePath `
  -ArgumentList "node_modules\tsx\dist\cli.mjs","src\launcher.ts" `
  -WorkingDirectory $workDir `
  -WindowStyle Hidden `
  -RedirectStandardOutput "$workDir\data\bridge.log" `
  -RedirectStandardError "$workDir\data\bridge-error.log"
