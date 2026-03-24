#!/usr/bin/env bash
# Stop Copilot Bridge — kills all related processes (Linux equivalent of stop-bridge.ps1)
set -euo pipefail

# Match the same patterns as the PowerShell version
PATTERN='copilot-bridge/(src|node_modules)|launcher\.ts|devtunnel.*copilot-bridge'

if pids=$(pgrep -f "$PATTERN" 2>/dev/null); then
  echo "$pids" | while read -r pid; do
    echo "Stopping PID $pid"
    kill -9 "$pid" 2>/dev/null || true
  done
else
  echo "No bridge processes found"
fi

echo "Bridge stopped"
