#!/usr/bin/env bash
# Start Copilot Bridge as background processes (Linux equivalent of start-bridge.ps1)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DATA_DIR="$WORK_DIR/data"

# Find Node.js
if [[ -n "${BRIDGE_NODE_PATH:-}" ]]; then
  NODE_PATH="$BRIDGE_NODE_PATH"
elif command -v node &>/dev/null; then
  NODE_PATH="$(command -v node)"
else
  echo "Node.js not found in PATH. Install Node 22+ or set BRIDGE_NODE_PATH." >&2
  exit 1
fi

# Stop any existing bridge processes first
"$SCRIPT_DIR/stop-bridge.sh" 2>/dev/null || true
sleep 3

# Load .env file into environment
ENV_FILE="$WORK_DIR/.env"
if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source <(grep -v '^\s*#' "$ENV_FILE" | grep -v '^\s*$')
  set +a
fi

# Ensure data directory exists
mkdir -p "$DATA_DIR"

# Start server (background)
nohup "$NODE_PATH" "$WORK_DIR/node_modules/tsx/dist/cli.mjs" "$WORK_DIR/src/server/index.ts" \
  > "$DATA_DIR/bridge.log" 2> "$DATA_DIR/bridge-error.log" &
echo "Server started (PID $!)"

# Start devtunnel (background)
if command -v devtunnel &>/dev/null; then
  nohup devtunnel host copilot-bridge > "$DATA_DIR/devtunnel.log" 2>&1 &
  echo "Dev tunnel started (PID $!)"
else
  echo "devtunnel not found — skipping tunnel setup"
fi

echo "Bridge started. Logs in $DATA_DIR/"
