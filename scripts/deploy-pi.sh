#!/usr/bin/env bash
set -euo pipefail

device="${1:-dan@pi-touchscreen.local}"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
remote_source="${TOUCHSCREEN_REMOTE_SOURCE:-/home/dan/touchscreen-launcher-src}"

case "$device" in
  *[!A-Za-z0-9._@-]*)
    echo "Unsafe SSH target: $device" >&2
    exit 2
    ;;
esac

ssh "$device" "mkdir -p '$remote_source'"
rsync -az --delete \
  --exclude .git \
  --exclude node_modules \
  --exclude .next \
  --exclude dist \
  --exclude .wrangler \
  "$repo_root/" "$device:$remote_source/"
ssh "$device" "cd '$remote_source' && ./deploy/pi/install.sh"
