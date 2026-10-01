#!/usr/bin/env bash
# One-time Pi setup that needs root. Run it on the Pi as the kiosk user; it
# asks for sudo itself. Deploys (deploy/pi/install.sh) never need root.
#
# - the packages Linux Voice Assistant builds and plays audio with
# - write access to the panel backlight for the video group, so the bridge can
#   turn the screen off while the kitchen is empty
set -euo pipefail

if [[ $EUID -eq 0 ]]; then
  echo "Run this as the kiosk user, not root; it uses sudo where it must." >&2
  exit 2
fi

sudo apt-get update
sudo apt-get install -y --no-install-recommends \
  alsa-utils \
  avahi-utils \
  build-essential \
  ca-certificates \
  curl \
  git \
  iproute2 \
  libasound2-plugins \
  libmpv-dev \
  pipewire-alsa \
  pipewire-bin \
  pipewire-pulse \
  procps \
  pulseaudio-utils \
  python3-dev \
  python3-venv

sudo tee /etc/udev/rules.d/90-kitchen-screen-backlight.rules >/dev/null <<'RULES'
# Kitchen screen: the video group may switch the panel backlight on and off.
SUBSYSTEM=="backlight", ACTION=="add", RUN+="/bin/sh -c 'chgrp video /sys%p/brightness /sys%p/bl_power; chmod g+w /sys%p/brightness /sys%p/bl_power'"
RULES
sudo udevadm control --reload
sudo udevadm trigger --subsystem-match=backlight --action=add

if ! id -nG | grep -qw video; then
  sudo usermod -aG video "$USER"
  echo "Added $USER to the video group; log out and back in (or reboot) for it to apply."
fi

echo "Pi setup done. Deploy with scripts/deploy-pi.sh from the Mac."
