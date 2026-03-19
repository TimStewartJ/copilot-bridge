# Stop Copilot Bridge
$procs = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match "copilot-teams-bridge.*launcher\.ts" }
foreach ($p in $procs) {
  Write-Output "Stopping PID $($p.ProcessId)"
  Stop-Process -Id ([int]$p.ProcessId) -Force -ErrorAction SilentlyContinue
}
Write-Output "Bridge stopped"
