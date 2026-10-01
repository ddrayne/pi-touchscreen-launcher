#!/usr/bin/env bash
# Installs a release of the kitchen screen on the Pi: the web app, the loopback
# bridge, the Chromium kiosk and the Linux Voice Assistant satellite. Runs as the
# kiosk user; deploy/pi/setup-pi.sh does the one-time root setup beforehand.
set -euo pipefail

source_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
app_root="${TOUCHSCREEN_APP_ROOT:-$HOME/touchscreen-launcher}"
units="$HOME/.config/systemd/user"
release_id="$(date -u +%Y%m%dT%H%M%SZ)"
release_dir="$app_root/releases/$release_id"

lva_root="${LVA_ROOT:-$HOME/linux-voice-assistant}"
lva_repo="${LVA_REPO:-https://github.com/OHF-Voice/linux-voice-assistant.git}"
# A commit or tag. The screen's peripheral events were checked against this one.
lva_ref="${LVA_REF:-b49fd8dc6534111c12d08b18acbfd1135dc1b082}"
lva_config="$HOME/.config/linux-voice-assistant"

test -f "$source_dir/dist-appliance/index.html"
test -f "$source_dir/bridge/launcher_bridge.py"

missing=()
command -v git >/dev/null || missing+=(git)
command -v pactl >/dev/null || missing+=(pulseaudio-utils)
python3 -c 'import ctypes.util, sys; sys.exit(not ctypes.util.find_library("mpv"))' ||
  missing+=(libmpv-dev)
python3 -c 'import ensurepip, sys; sys.exit(sys.version_info < (3, 11))' ||
  missing+=(python3-venv)
if ((${#missing[@]})); then
  echo "Missing ${missing[*]}: run deploy/pi/setup-pi.sh on the Pi once first." >&2
  exit 1
fi

# The screen and its bridge.
install -d "$release_dir" "$app_root/bridge"
cp -a "$source_dir/dist-appliance/." "$release_dir/"
install -m 0755 "$source_dir/bridge/launcher_bridge.py" \
  "$app_root/bridge/launcher_bridge.py"
ln -sfn "$release_dir" "$app_root/current"

install -d "$HOME/.config/touchscreen-launcher"
printf '%s\n' \
  "LAUNCHER_STATIC_ROOT=$app_root/current" \
  "BIRDFRAME_URL=${BIRDFRAME_URL:-http://192.168.86.24:8355}" \
  "VOICE_BROKER_URL=${VOICE_BROKER_URL:-http://192.168.86.24:18890}" \
  >"$HOME/.config/touchscreen-launcher/environment"
chmod 600 "$HOME/.config/touchscreen-launcher/environment"

# The voice satellite, pinned. Its virtualenv is only rebuilt when the pin moves.
if [[ -e "$lva_root" && ! -d "$lva_root/.git" ]]; then
  echo "$lva_root exists but is not a git clone; move it aside or set LVA_ROOT." >&2
  exit 1
fi
if [[ ! -d "$lva_root/.git" ]]; then
  git clone --quiet "$lva_repo" "$lva_root"
fi
if ! git -C "$lva_root" rev-parse --verify --quiet "$lva_ref^{commit}" >/dev/null; then
  git -C "$lva_root" fetch --quiet --tags origin
fi
git -C "$lva_root" checkout --quiet --detach "$lva_ref"
lva_commit="$(git -C "$lva_root" rev-parse HEAD)"
lva_stamp="$lva_root/.venv/.kitchen-screen-commit"
if [[ "$(cat "$lva_stamp" 2>/dev/null || true)" != "$lva_commit" ]]; then
  systemctl --user stop linux-voice-assistant.service 2>/dev/null || true
  (cd "$lva_root" && python3 script/setup)
  printf '%s\n' "$lva_commit" >"$lva_stamp"
fi
chmod +x "$lva_root/docker-entrypoint.sh"

# Settings that are tuned on the Pi itself; later deploys leave the file alone.
install -d -m 0700 "$lva_config"
if [[ ! -f "$lva_config/environment" ]]; then
  cat >"$lva_config/environment" <<'SETTINGS'
# Linux Voice Assistant on the kitchen screen. Deploys keep this file; restart
# the service after editing: systemctl --user restart linux-voice-assistant
CLIENT_NAME="Kitchen screen"
WAKE_MODEL=okay_computer
# Echo-cancelled mic (see README), so the wake word works while music plays:
# AUDIO_INPUT_DEVICE=aec_mic
# Louder, cleaner speech from across the kitchen:
# MIC_AUTO_GAIN=15
# MIC_NOISE_SUPPRESSION=2
SETTINGS
fi

# V1's wake-word listener and Chromium extension are retired: Linux Voice
# Assistant owns the microphone now.
if [[ -f "$units/touchscreen-wake.service" ]]; then
  systemctl --user disable --now touchscreen-wake.service 2>/dev/null || true
  rm -f "$units/touchscreen-wake.service"
fi
rm -rf "$app_root/extension" "$app_root/bridge/wake_listener.py"

install -d "$units"
for unit in touchscreen-bridge.service touchscreen-launcher.service \
  linux-voice-assistant.service; do
  install -m 0644 "$source_dir/deploy/pi/$unit" "$units/$unit"
done

systemctl --user daemon-reload
systemctl --user enable touchscreen-bridge.service touchscreen-launcher.service \
  linux-voice-assistant.service
systemctl --user restart touchscreen-bridge.service linux-voice-assistant.service \
  touchscreen-launcher.service

echo "Installed kitchen screen release $release_id with Linux Voice Assistant ${lva_commit:0:12}"
