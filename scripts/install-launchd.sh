#!/bin/bash
# Installs the agent as a launchd service (KeepAlive + RunAtLoad).
set -euo pipefail

PLIST_SRC="$(cd "$(dirname "$0")/.." && pwd)/com.facu.wallbit-agent.plist"
PLIST_DST="$HOME/Library/LaunchAgents/com.facu.wallbit-agent.plist"

mkdir -p "$HOME/Library/LaunchAgents"
mkdir -p "$(dirname "$PLIST_SRC")/logs"
cp "$PLIST_SRC" "$PLIST_DST"

launchctl unload "$PLIST_DST" 2>/dev/null || true
launchctl load "$PLIST_DST"

echo "Loaded. Check with: launchctl list | grep wallbit"
echo "Logs: tail -f logs/agent-\$(date +%F).log"
echo ""
echo "Clamshell mode setup (run once, needs sudo):"
echo "  sudo pmset -a sleep 0 disksleep 0"
echo "  sudo pmset -a autorestart 1"
echo "  pmset -g   # verify"
