# Pi Touchscreen Assistant

A portrait kiosk launcher for `pi-touchscreen.local`. It combines:

- a touch-first home screen with live BirdFrame data;
- OpenClaw Talk using OpenAI Realtime over WebRTC;
- the canonical Home Assistant shopping list with touch and OpenClaw access;
- a local, offline “Computer” wake-word gate;
- a native IMX708 camera preview;
- reliable two-way switching between the launcher and BirdFrame.

The installed Pi is intentionally a thin appliance. OpenClaw and provider
credentials remain on the Mac at `192.168.86.24`. The landing page receives
only a short-lived provider session for each conversation.

## Architecture

```text
Seeed microphones
  ├─ PocketSphinx on Pi ── “Computer” ───────────────┐
  └─ Chromium mic ── direct WebRTC audio ── OpenAI   │
                                                     ▼
Inline launcher ↔ Pi loopback bridge ↔ Mac voice/home broker
      │                 │                    │
      │                 │                    └─ persistent OpenClaw Gateway
      │                 └─ wlrctl + native camera       └─ agent/tools
      └─ BirdFrame live card/window
```

The runtime pieces are:

- `touchscreen-bridge.service`: serves the static launcher on
  `127.0.0.1:8765`, exposes local appliance endpoints, captures camera frames,
  and switches windows.
- `touchscreen-launcher.service`: runs Chromium as the portrait kiosk with a
  dedicated profile.
- `touchscreen-wake.service`: listens locally for “Computer” through PipeWire
  and PocketSphinx. No idle audio leaves the Pi.
- `birdframe-display.service`: runs the existing Flutter BirdFrame display.
- `com.dan.pi-touchscreen-voice-broker`: a Mac LaunchAgent that owns one
  authenticated OpenClaw Gateway connection and the Home Assistant credential.
  It exposes only session, consult, active-run control, and shopping-list
  operations to the Pi’s LAN address.
- the Chromium extension in `extension/`: retains a Home button in the full
  OpenClaw UI as a fallback; the normal voice UX no longer navigates there.

The broker is necessary for more than secret storage. OpenClaw Talk associates
agent consults, progress events, cancellation, and steering with the Gateway
connection that created the run. A one-shot HTTP or CLI call would lose that
ownership before the answer returned.

## Why this differs from `openclaw-pi-voice-node`

The reference repository is a useful proof of concept, but its single Python
loop hard-codes an ALSA card, blocks while TTS plays, has no echo cancellation
or barge-in, and offers no touchscreen or recovery UX.

This appliance keeps the useful shape—local wake detection plus a remote
assistant—but delegates the live conversation to OpenClaw’s browser Realtime
transport embedded directly in the launcher. Chromium supplies WebRTC audio
processing, echo cancellation, noise suppression, and barge-in. The landing
page renders listening/thinking/speaking state and the live transcript itself.
PipeWire device names replace fragile card indexes, and systemd owns
startup/recovery.

## Provider configuration

OpenClaw on the Mac is configured for:

```text
provider: openai
model: gpt-realtime-2.1
transport: webrtc
voice: cedar
brain: agent-consult
```

The OpenAI credential is stored in OpenClaw’s credential database on the Mac.
It is not copied into this repository, the built launcher, the extension, or
the Pi service environment.

Fish Audio remains a sensible optional TTS path for a later half-duplex mode.
The current full-duplex Talk path receives speech directly from OpenAI
Realtime, so inserting a second TTS provider would remove the clean barge-in
behavior. If Fish is evaluated, keep its expiring key in a Mac-side secret
environment only and use the documented
[`POST /v1/tts`](https://docs.fish.audio/api-reference/endpoint/openapi-v1/text-to-speech)
endpoint with `s2-pro`; never embed it in the launcher.

## Build and install

The web bundle is built on the development Mac:

```bash
npm install
npm run appliance:build
npm run lint
python3 -m py_compile bridge/launcher_bridge.py bridge/wake_listener.py
npx tsc -p tsconfig.appliance.json --noEmit
```

Install and activate the Mac broker once:

```bash
mkdir -p /Users/dan/Library/LaunchAgents /Users/dan/Library/Logs
install -m 0644 \
  deploy/mac/com.dan.pi-touchscreen-voice-broker.plist \
  /Users/dan/Library/LaunchAgents/com.dan.pi-touchscreen-voice-broker.plist
./deploy/mac/activate.command
```

The LaunchAgent reads OpenClaw’s existing local configuration and credential
store in-process. It does not duplicate the OpenAI key into this project or
write it to the Pi.

The Pi requires:

```bash
sudo apt-get install -y \
  chromium curl wlrctl pocketsphinx pocketsphinx-en-us pipewire-alsa
```

Synchronize the repository to `/home/dan/touchscreen-launcher-src`, then run on
the Pi:

```bash
cd /home/dan/touchscreen-launcher-src
./deploy/pi/install.sh
```

The installer creates an atomic timestamped launcher release, installs the
bridge and wake listener, writes a mode-`0600` non-secret environment file,
enables all three user services, and restarts the kiosk.

## Local API

The bridge binds to loopback only.

| Endpoint | Purpose |
| --- | --- |
| `GET /api/status` | OpenClaw, voice broker, BirdFrame, and wake-service health |
| `GET /api/birdframe` | Read-only proxy of BirdFrame’s live snapshot |
| `GET /api/camera.jpg` | Fresh native IMX708 JPEG frame |
| `GET /api/wake` | Pending wake sequence for launcher/extension |
| `POST /api/wake` | Trigger or acknowledge a local wake event |
| `POST /api/window` | Focus `assistant` or `birdframe` |
| `POST /api/voice/session` | Request a short-lived WebRTC session |
| `POST /api/voice/tool` | Await an OpenClaw agent consult on the broker connection |
| `POST /api/voice/control` | Status, steer, cancel, or queue active work |
| `GET /api/shopping` | Read the canonical Home Assistant shopping list |
| `POST /api/shopping/items` | Add an item, restoring a matching completed item |
| `PATCH /api/shopping/items/:uid` | Rename, complete, or restore an item |
| `DELETE /api/shopping/items/:uid` | Remove an item |
| `POST /api/shopping/clear-completed` | Remove all completed items |

## Canonical house shopping list

Home Assistant `todo.shopping_list` is the single source of truth. The Mac
broker owns `HA_URL` and `HA_TOKEN`; the browser and Pi receive only the narrow
shopping API above. OpenClaw uses the bundled `house-shopping-list` skill and
the same broker routes, so touch, voice, messaging, and the Home Assistant
dashboard never create competing lists.

Before the first Mac broker activation, provide the Home Assistant token in the
shell environment:

```bash
export HA_TOKEN='<long-lived Home Assistant token>'
./deploy/mac/activate.command
```

The activation script stores the token in the macOS login Keychain, installs
the OpenClaw skill, and restarts the allowlisted LAN broker. Subsequent
activations read the credential from Keychain. The token is never written to
the repository, LaunchAgent plist, browser, or Pi.

The native camera endpoint is deliberate. Chromium 150 on this Debian
Wayland/PipeWire image exposes the IMX708 but can leave `getUserMedia(video)`
pending indefinitely. `rpicam-still` is stable, fast, and keeps the private
preview entirely on the Pi.

## Wake-word tuning

Defaults live in `~/.config/touchscreen-launcher/environment`:

```text
WAKE_PHRASE=computer
WAKE_THRESHOLD=1e-19
WAKE_COOLDOWN_SECONDS=20
WAKE_ALSA_DEVICE=pipewire
```

The installed threshold recognizes both US and UK English reference
pronunciations while rejecting more ambient speech. Wake events are ignored
while an inline conversation is active and for four seconds after it ends, so
the assistant's own speaker does not wake it again. `-ds 2` reduces continuous
decoder CPU without losing either reference detection. Touching the orb remains
the deterministic fallback.

Voice sessions are deliberately turn-based for an unattended home screen. The
launcher accepts one utterance, locks the microphone when server VAD marks the
turn complete, plays one answer, and returns home. It also closes after 12
seconds without a turn, forcibly caps a continuous utterance at 15 seconds,
and enforces a 45-second session ceiling so background conversation cannot
keep it listening indefinitely.

If the OpenAI project does not permit a separate input-transcription model, the
launcher can still show the user turn inferred from OpenClaw consult/control
tool arguments. This keeps the on-screen conversation useful without exposing
a durable API key to the Pi.

To make the detector less sensitive, increase the numeric threshold, for
example to `1e-16`; to make it more sensitive, reduce it, for example to
`1e-20`, then restart `touchscreen-wake.service`.

## BirdFrame integration

The launcher’s live card reads BirdFrame data without taking over the window.
Touching the card focuses the existing Flutter app. BirdFrame has a persistent
Home pill that posts `{"target":"assistant"}` to the loopback bridge, so the
round trip does not depend on desktop gestures or a keyboard.

## Operations and recovery

```bash
systemctl --user status \
  touchscreen-bridge.service \
  touchscreen-launcher.service \
  touchscreen-wake.service \
  birdframe-display.service

journalctl --user -u touchscreen-wake.service -f
systemctl --user restart touchscreen-launcher.service
```

All services use `Restart=always` and are enabled under the user session.
Chromium uses a dedicated profile with `--password-store=basic`; this avoids
the desktop keyring prompt that otherwise leaves a white kiosk after boot. The
OpenClaw device pairing and Control UI session survive service restarts and
reboots in that profile.

On the Mac:

```bash
launchctl print gui/501/com.dan.pi-touchscreen-voice-broker
tail -f /Users/dan/Library/Logs/pi-touchscreen-voice-broker.log
tail -f /Users/dan/Library/Logs/pi-touchscreen-voice-broker.error.log
```

## Diagnostics

With an SSH tunnel from local port `9223` to Chromium’s loopback debugger:

```bash
node scripts/check-pi-media.mjs
node scripts/inspect-pi-talk.mjs
TOUCHSCREEN_NO_ACTION=1 node scripts/inspect-pi-talk.mjs
```

The media check stops any paid Realtime session first, returns to Home, measures
real microphone samples, decodes a native camera frame, and renders a short
low-volume speaker tone. The Talk inspector verifies the actual OpenClaw
WebRTC request and UI state.
