# Stop Copilot Bridge - kills all related processes
# Kill PM2 daemon if running
$nodePath = "node"
$pm2 = "copilot-bridge\node_modules\pm2\bin\pm2"
& $nodePath $pm2 kill 2>$null

# Kill server, launcher, tsx, and devtunnel processes
Get-CimInstance Win32_Process | Where-Object {
  $_.CommandLine -match "copilot-teams-bridge[\\/](src|node_modules)|launcher\.ts|devtunnel.*copilot-bridge|pm2.*(Daemon|start)|keep-alive\.ps1"
} | ForEach-Object {
  Write-Output "Stopping PID $($_.ProcessId)"
  Stop-Process -Id ([int]$_.ProcessId) -Force -ErrorAction SilentlyContinue
}
Write-Output "Bridge stopped"
