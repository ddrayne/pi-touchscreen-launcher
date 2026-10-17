#!/usr/bin/env bash
set -euo pipefail

source_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
app_root="${TOUCHSCREEN_APP_ROOT:-$HOME/touchscreen-launcher}"
release_id="$(date -u +%Y%m%dT%H%M%SZ)"
release_dir="$app_root/releases/$release_id"

test -f "$source_dir/dist-appliance/index.html"
test -f "$source_dir/bridge/launcher_bridge.py"
test -f "$source_dir/bridge/wake_listener.py"
test -x /usr/bin/pw-record
test -x /usr/bin/pocketsphinx_continuous
/usr/bin/arecord -L | /usr/bin/grep -q '^pipewire$'

install -d "$release_dir" "$app_root/bridge" "$app_root/extension"
install -d "$HOME/.cache/touchscreen-launcher"
cp -a "$source_dir/dist-appliance/." "$release_dir/"
cp -a "$source_dir/extension/." "$app_root/extension/"
install -m 0755 "$source_dir/bridge/launcher_bridge.py" \
  "$app_root/bridge/launcher_bridge.py"
install -m 0755 "$source_dir/bridge/wake_listener.py" \
  "$app_root/bridge/wake_listener.py"
install -m 0644 "$source_dir/bridge/launcher_watchdog.py" \
  "$app_root/bridge/launcher_watchdog.py"
install -m 0644 "$source_dir/bridge/portrait_features.py" \
  "$app_root/bridge/portrait_features.py"
ln -sfn "$release_dir" "$app_root/current"

install -d "$HOME/.config/touchscreen-launcher"
printf '%s\n' \
  "LAUNCHER_STATIC_ROOT=$app_root/current" \
  "BIRDFRAME_URL=${BIRDFRAME_URL:-http://192.168.86.24:8355}" \
  "OPENCLAW_URL=${OPENCLAW_URL:-http://192.168.86.24:18789}" \
  "VOICE_BROKER_URL=${VOICE_BROKER_URL:-http://192.168.86.24:18890}" \
  "WAKE_PHRASE=${WAKE_PHRASE:-computer}" \
  "WAKE_THRESHOLD=${WAKE_THRESHOLD:-1e-19}" \
  "WAKE_COOLDOWN_SECONDS=${WAKE_COOLDOWN_SECONDS:-20}" \
  "WAKE_ALSA_DEVICE=${WAKE_ALSA_DEVICE:-pipewire}" \
  "LAUNCHER_LATITUDE=${LAUNCHER_LATITUDE:-55.95}" \
  "LAUNCHER_LONGITUDE=${LAUNCHER_LONGITUDE:--3.19}" \
  "LAUNCHER_FACING=${LAUNCHER_FACING:-180}" \
  "LAUNCHER_PLACE=${LAUNCHER_PLACE:-Edinburgh}" \
  >"$HOME/.config/touchscreen-launcher/environment"
chmod 600 "$HOME/.config/touchscreen-launcher/environment"

install -d "$HOME/.config/systemd/user"
install -m 0644 "$source_dir/deploy/pi/touchscreen-bridge.service" \
  "$HOME/.config/systemd/user/touchscreen-bridge.service"
install -m 0644 "$source_dir/deploy/pi/touchscreen-launcher.service" \
  "$HOME/.config/systemd/user/touchscreen-launcher.service"
install -m 0644 "$source_dir/deploy/pi/touchscreen-wake.service" \
  "$HOME/.config/systemd/user/touchscreen-wake.service"

systemctl --user daemon-reload
systemctl --user enable touchscreen-bridge.service touchscreen-launcher.service \
  touchscreen-wake.service
systemctl --user restart touchscreen-bridge.service touchscreen-launcher.service \
  touchscreen-wake.service

echo "Installed touchscreen launcher release $release_id"
