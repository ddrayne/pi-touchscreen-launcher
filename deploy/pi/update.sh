#!/usr/bin/env bash
# Install the latest prebuilt appliance for a branch straight from GitHub,
# without a Mac in the loop. The Appliance build workflow publishes one
# rolling prerelease per branch, tagged appliance-<branch>.
#
#   ./deploy/pi/update.sh                                   # main
#   ./deploy/pi/update.sh claude/vigilant-brahmagupta-wwyylv
#
# First time on a Pi, or when this script is not there yet:
#   curl -fsSL https://raw.githubusercontent.com/ddrayne/pi-touchscreen-launcher/main/deploy/pi/update.sh | bash -s -- main
#
# For a private repository export GITHUB_TOKEN (read access to the repo)
# before running; the download then goes through the API.
set -euo pipefail

branch="${1:-main}"
repo="${TOUCHSCREEN_REPO:-ddrayne/pi-touchscreen-launcher}"
source_dir="${TOUCHSCREEN_SOURCE:-$HOME/touchscreen-launcher-src}"
asset="touchscreen-launcher.tar.gz"
tag="appliance-${branch//\//-}"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

if [[ -n "${GITHUB_TOKEN:-}" ]]; then
  release="$(curl -fsSL \
    -H "Authorization: Bearer $GITHUB_TOKEN" \
    -H "Accept: application/vnd.github+json" \
    "https://api.github.com/repos/$repo/releases/tags/$tag")"
  asset_url="$(printf '%s' "$release" | python3 -c '
import json, sys
release = json.load(sys.stdin)
print(next(a["url"] for a in release["assets"] if a["name"] == sys.argv[1]))
' "$asset")"
  curl -fsSL \
    -H "Authorization: Bearer $GITHUB_TOKEN" \
    -H "Accept: application/octet-stream" \
    -o "$work/$asset" "$asset_url"
else
  curl -fsSL -o "$work/$asset" \
    "https://github.com/$repo/releases/download/$tag/$asset"
fi

mkdir -p "$work/src"
tar -xzf "$work/$asset" -C "$work/src"
test -f "$work/src/dist-appliance/index.html"
test -f "$work/src/deploy/pi/install.sh"

mkdir -p "$source_dir"
if command -v rsync >/dev/null 2>&1; then
  rsync -a --delete --exclude node_modules "$work/src/" "$source_dir/"
else
  find "$source_dir" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
  cp -a "$work/src/." "$source_dir/"
fi

cd "$source_dir"
chmod +x deploy/pi/install.sh deploy/pi/update.sh
./deploy/pi/install.sh
echo "Installed $(sed -n 2p RELEASE) at $(sed -n 1p RELEASE | cut -c1-12), built $(sed -n 3p RELEASE)"
