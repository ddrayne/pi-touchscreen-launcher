#!/bin/zsh
set -euo pipefail

agent_plist="/Users/dan/Library/LaunchAgents/com.dan.pi-touchscreen-voice-broker.plist"
agent_service="gui/501/com.dan.pi-touchscreen-voice-broker"

launchctl bootout gui/501 "$agent_plist" >/dev/null 2>&1 || true
launchctl bootstrap gui/501 "$agent_plist"
launchctl kickstart -k "$agent_service"

echo "Pi touchscreen voice broker is active."
