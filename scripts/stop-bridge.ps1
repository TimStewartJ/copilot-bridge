# Stop Copilot Bridge - kills all related processes
Get-CimInstance Win32_Process | Where-Object {
  $_.CommandLine -match "copilot-teams-bridge[\\/](src|node_modules)|launcher\.ts|devtunnel.*copilot-bridge|keep-alive\.ps1"
} | ForEach-Object {
  Write-Output "Stopping PID $($_.ProcessId)"
  Stop-Process -Id ([int]$_.ProcessId) -Force -ErrorAction SilentlyContinue
}
Write-Output "Bridge stopped"
