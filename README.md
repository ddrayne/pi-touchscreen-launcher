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
| `GET /api/household` | Weather, shared calendar events, and allowlisted room controls |
| `POST /api/household/control` | Toggle one allowlisted Home Assistant light group |
| `GET /api/shopping` | Read the canonical Home Assistant shopping list |
| `GET /api/shopping/events` | Instant snapshots and source-aware activity over SSE |
| `GET /api/shopping/activity` | Recent shopping changes and their source |
| `POST /api/shopping/items` | Add an item, restoring a matching completed item |
| `POST /api/shopping/items/batch` | Add several deduplicated items |
| `PATCH /api/shopping/items/:uid` | Rename, complete, or restore an item |
| `DELETE /api/shopping/items/:uid` | Remove an item |
| `POST /api/shopping/reconcile` | Preview or commit a recipe, receipt, or photographed list |
| `POST /api/shopping/organize` | Merge duplicate products and compatible quantities |
| `POST /api/shopping/camera/analyze` | Analyse one explicitly requested Pi camera frame |
| `GET/POST /api/shopping/household` | Read or save mobile arrival-reminder settings |
| `POST /api/shopping/share` | Send the current list to an allowlisted household phone |
| `POST /api/shopping/clear-completed` | Remove all completed items |

## Canonical house shopping list

Home Assistant `todo.shopping_list` is the single source of truth. The Mac
broker owns `HA_URL` and `HA_TOKEN`; the browser and Pi receive only the narrow
shopping API above. OpenClaw uses the bundled `house-shopping-list` skill and
the same broker routes, so touch, voice, messaging, and the Home Assistant
dashboard never create competing lists.

The browser subscribes to the broker event stream, so a voice or Home
Assistant change appears immediately. During a network interruption,
touchscreen mutations stay in a bounded local outbox and replay in order after
reconnection. The broker keeps a mode-`0600`, source-aware activity log at
`~/.openclaw/logs/shopping-activity.jsonl`.

Shopping text is parsed into a display-only quantity, unit, and supermarket
section while the original Home Assistant item remains canonical. Batch and
reconciliation routes avoid duplicate products. The organizer only merges
matching products and only sums quantities whose units are compatible.

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

Home Assistant's to-do dashboard and mobile app can manage the same list. The
touchscreen can send a snapshot to the configured `mobile_app` notifier.
Arrival reminders remain disabled until a non-home shop zone, household
person, and phone are explicitly selected on screen. The broker then notifies
only when that person enters that zone and the list is non-empty.

## Camera shopping

The camera sheet keeps its continuously refreshed preview on the Pi. No image
is sent for analysis until someone taps **Add what I can see**. That single
JPEG then travels through the loopback bridge to the allowlisted Mac broker;
the browser receives neither the image payload nor the OpenAI key. The broker
sends the frame with `store: false`, validates strict structured output, and
shows confidence and evidence before any candidate can be committed.

The broker reads the OpenAI credential from `OPENAI_API_KEY` or the
mode-`0600` file `~/.openclaw/secrets/openai-api-key`. The default
cost-sensitive vision model can be changed with `OPENAI_VISION_MODEL`. Local
barcode detection is used automatically when `zbarimg` is available on the Pi.

The native camera endpoint is deliberate. Chromium 150 on this Debian
Wayland/PipeWire image exposes the IMX708 but can leave `getUserMedia(video)`
pending indefinitely. `rpicam-still` is stable, fast, and keeps the private
preview entirely on the Pi.

## Swipeable household hub

Swipe left from the voice landing page, or tap the second page dot, for a
household summary. It shows `weather.home`, upcoming events from explicitly
allowlisted shared calendars, the canonical shopping list, BirdFrame, and four
allowlisted light groups. Private calendars and arbitrary Home Assistant
services are not exposed. Override the curated defaults with
`HOUSEHOLD_WEATHER_ENTITY`, `HOUSEHOLD_CALENDAR_ENTITIES`, and
`HOUSEHOLD_CONTROL_ENTITIES` in the Mac broker environment.

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

Voice sessions keep one stateful Realtime conversation open for natural
follow-ups. The launcher locks the microphone while each answer is prepared and
played, then returns to listening for 20 seconds without requiring the wake word
again. It closes after 15 seconds when no first turn begins, forcibly caps a
continuous utterance at 15 seconds, and enforces a three-minute session ceiling
so background conversation cannot keep it listening indefinitely.

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
node scripts/check-pi-conversation.mjs
TOUCHSCREEN_NO_ACTION=1 node scripts/inspect-pi-talk.mjs
```

The media check stops any paid Realtime session first, returns to Home, measures
real microphone samples, decodes a native camera frame, and renders a short
low-volume speaker tone. The Talk inspector verifies the actual OpenClaw
WebRTC request and UI state. The conversation check runs two bounded text turns
through the live kiosk data channel and verifies transcript identity, response
playback, and the follow-up listening window before ending the session.
