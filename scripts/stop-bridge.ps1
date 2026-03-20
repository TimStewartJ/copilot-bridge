# Stop Copilot Bridge - kills launcher and all server/child processes
$procs = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match "copilot-teams-bridge[\\/](src|node_modules)" }
foreach ($p in $procs) {
  Write-Output "Stopping PID $($p.ProcessId)"
  Stop-Process -Id ([int]$p.ProcessId) -Force -ErrorAction SilentlyContinue
}
if ($procs.Count -eq 0) {
  Write-Output "No bridge processes found"
} else {
  $c = $procs.Count
  Write-Output "Stopped $c processes"
}
