#!/bin/zsh
set -euo pipefail

agent_plist="/Users/dan/Library/LaunchAgents/com.dan.pi-touchscreen-voice-broker.plist"
agent_plist_source="/Users/dan/pi-touchscreen-launcher/deploy/mac/com.dan.pi-touchscreen-voice-broker.plist"
agent_service="gui/501/com.dan.pi-touchscreen-voice-broker"
shopping_skill_source="/Users/dan/pi-touchscreen-launcher/openclaw/house-shopping-list/SKILL.md"
shopping_skill_dir="/Users/dan/.openclaw/skills/house-shopping-list"
home_assistant_keychain_service="pi-touchscreen-home-assistant-token"
home_assistant_keychain_account="dan"

if [[ -n "${HA_TOKEN:-}" ]]; then
  /usr/bin/security add-generic-password \
    -U \
    -a "$home_assistant_keychain_account" \
    -s "$home_assistant_keychain_service" \
    -w "$HA_TOKEN" \
    >/dev/null
fi

if ! /usr/bin/security find-generic-password \
  -a "$home_assistant_keychain_account" \
  -s "$home_assistant_keychain_service" \
  >/dev/null 2>&1; then
  echo "HA_TOKEN is not set and no Home Assistant token exists in Keychain." >&2
  exit 1
fi

install -d -m 0755 "$shopping_skill_dir"
install -m 0644 "$shopping_skill_source" "$shopping_skill_dir/SKILL.md"

launchctl bootout gui/501 "$agent_plist" >/dev/null 2>&1 || true
install -m 0644 "$agent_plist_source" "$agent_plist"
launchctl bootstrap gui/501 "$agent_plist"
launchctl kickstart -k "$agent_service"

echo "Kitchen screen broker is active."
