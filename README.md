# Kitchen Screen

The Pi touchscreen in the kitchen, rebuilt to replace the Google Nest Hub on the
counter. The test is simple: swap the Hub for this and nobody misses it.

One glance answers the kitchen's questions: the time, whether it will rain,
which timers are running, what the kitchen speaker is playing and which bird is
singing in the garden right now. "Okay Computer" sets timers, answers questions
and adds to the shopping list through Home Assistant Assist. The screen goes
dark when the kitchen is empty.

## On the screen

- **Clock, date, temperature.** The clock and countdowns use Literata, so zeros
  read as zeros from across the room.
- **Now singing.** The latest *confirmed* or *probable* bird from BirdFrame (never
  a tentative one), its photo, and **Hear it**, which plays BirdFrame's own
  recording from today. "Earlier" lists the others heard recently. A bird heard
  for the first time ever gets a badge.
- **Rain.** One sentence ("Rain from 3pm", "Rain until 9am", "Dry") over bars
  for the next 16 hours, so the words come with their evidence.
- **Timers.** Set by voice. They count down at the top; when one finishes it
  fills the screen until someone taps it or says "stop". With three running,
  the bird steps back to a single row.
- **Captions.** What was heard and what the assistant said, above the Talk
  button. Talk turns into Stop while the assistant is listening or speaking.
- **Kitchen speaker.** What `media_player.kitchen_kitchen` is playing, with play,
  pause and next.
- **Sleep.** Five minutes after the kitchen motion sensors last saw anyone (and
  nobody has touched the screen), the backlight goes off. Walking in, speaking
  to it, a running timer or a touch keeps it awake or wakes it. The first touch
  only wakes it. After 9pm it switches to a dark palette.

## Architecture

```text
 Pi (Touch Display 2, portrait)                    Mac (always on)
 ┌───────────────────────────────────────┐         ┌───────────────────────────┐
 │ Chromium kiosk                        │         │ broker :18890             │──► Home Assistant
 │   ├─ http://127.0.0.1:8765 ─► bridge ─┼────────►│   LAN allowlist; HA token │    (REST + WebSocket)
 │   │                                   │         │   from the Keychain       │──► Open-Meteo
 │   │                                   │         │ BirdFrame :8355           │
 │   └─ ws://127.0.0.1:6055              │         └───────────────────────────┘
 │        ▼                              │
 │ Linux Voice Assistant                 │◄──── ESPHome API :6053 ──── Home Assistant Assist
 │   mic, speaker, wake word, timers     │
 └───────────────────────────────────────┘
```

Each device does one job:

- **`linux-voice-assistant.service`** (Pi) runs the Open Home Foundation's
  [Linux Voice Assistant](https://github.com/OHF-Voice/linux-voice-assistant), a
  Home Assistant voice satellite. It owns the microphone and speaker, hears the
  wake word on the Pi, streams the request to Home Assistant's Assist pipeline,
  plays the reply and runs timers. Its peripheral WebSocket tells the screen what
  is happening. That socket has no authentication, so it listens on loopback only.
- **`touchscreen-bridge.service`** (Pi) serves the screen on `127.0.0.1:8765`,
  proxies the Mac broker and BirdFrame, caches bird photos from Wikipedia and
  switches the backlight. It holds no credentials.
- **`touchscreen-launcher.service`** (Pi) is the Chromium kiosk. It has no
  microphone access and no extensions.
- **`com.dan.pi-touchscreen-voice-broker`** (Mac LaunchAgent) runs
  `broker/openclaw_voice_broker.ts`, the only thing that holds the Home Assistant
  token. It answers only allowlisted addresses, and only these: weather, the
  kitchen speaker, kitchen presence, the shopping list and the household summary.
- **BirdFrame** (Mac) supplies the garden: `/api/now` and today's recordings.

The live screen uses no LLM. The assistant's answers come from whichever
conversation agent the Assist pipeline uses.

## Home Assistant setup

1. Deploy to the Pi (below). Home Assistant discovers **Kitchen screen** as an
   ESPHome device; add it under *Settings → Devices & services*. If it isn't
   discovered, add the ESPHome integration by hand with the Pi's address and port
   `6053`.
2. Pick the Assist pipeline on the device page. Turn on **Prefer handling commands
   locally** so timers, lights and the shopping list never wait for an LLM. Use
   any LLM conversation agent for everything else.
3. The wake word starts as **Okay Computer** (`WAKE_MODEL` in
   `~/.config/linux-voice-assistant/environment` on the Pi). The device page in
   Home Assistant can switch it to any bundled model, such as Okay Nabu or Hey
   Jarvis. Saying "stop" silences a ringing timer.
4. Nothing else is needed for timers ("set a pasta timer for ten minutes", "how
   long is left?", "cancel the timer") or the shopping list ("add milk to the
   shopping list"). They are Assist's built-in intents, and the list is the same
   `todo.shopping_list` the broker and the OpenClaw skill use.

## Mac broker

The broker needs Node 24 or later, which runs the TypeScript directly; it no
longer needs an OpenClaw checkout. Provide the Home Assistant token once, and
the activation script stores it in the login Keychain:

```bash
mkdir -p /Users/dan/Library/LaunchAgents /Users/dan/Library/Logs
export HA_TOKEN='<long-lived Home Assistant token>'
./deploy/mac/activate.command
node scripts/check-broker.mjs
```

Later activations read the token from Keychain. It is never written to the
repository, the plist, the browser or the Pi. `activate.command` also installs
the `house-shopping-list` OpenClaw skill.

Settings go in the LaunchAgent's `EnvironmentVariables`:

| Variable | Default |
| --- | --- |
| `HA_URL` | `http://homeassistant.local:8123` |
| `VOICE_BROKER_ALLOWED_IPS` | `127.0.0.1,::1,192.168.86.232` (the Pi) |
| `KITCHEN_MEDIA_ENTITY` | `media_player.kitchen_kitchen` |
| `KITCHEN_PRESENCE_ENTITIES` | `binary_sensor.kitchen_motion_sensor_motion,binary_sensor.kitchen_motion` |
| `KITCHEN_ILLUMINANCE_ENTITY` | `sensor.kitchen_motion_sensor_illuminance` |
| `WEATHER_LATITUDE`, `WEATHER_LONGITUDE` | Home Assistant's `zone.home` |
| `SHOPPING_LIST_ENTITY` | `todo.shopping_list` |
| `SHOPPING_NOTIFY_SERVICES` | `notify.mobile_app_dans_phone` |
| `HOUSEHOLD_WEATHER_ENTITY`, `HOUSEHOLD_CALENDAR_ENTITIES`, `HOUSEHOLD_CONTROL_ENTITIES` | the household summary's allowlists |

Kitchen media controls are limited to play/pause, next and previous. Album art is
proxied without exposing Home Assistant URLs or tokens. Presence and media
changes reach the screen over one event stream (`/home/events`) driven by Home
Assistant's WebSocket.

## The Pi

Once, on the Pi, as the kiosk user (it asks for sudo itself):

```bash
./deploy/pi/setup-pi.sh
```

This installs the packages Linux Voice Assistant builds against. It also lets
the `video` group switch the panel backlight. Without that, the screen still
goes black when the kitchen is empty, but the backlight stays on.

Then deploy from the Mac:

```bash
npm install
npm run appliance:build
./scripts/deploy-pi.sh
```

`deploy-pi.sh` copies the repository to the Pi and runs `deploy/pi/install.sh`.
The installer:

- installs a timestamped release of the screen and the bridge;
- clones Linux Voice Assistant into `~/linux-voice-assistant` at a pinned commit
  (`LVA_REF`); it only rebuilds that virtualenv when the pin moves;
- writes `~/.config/linux-voice-assistant/environment` on first install and
  leaves it alone after that;
- installs and restarts the three user services;
- retires V1's wake-word listener and Chromium extension.

To move to a newer Linux Voice Assistant, change `LVA_REF` in `install.sh`, but
first check that its peripheral events still match `lib/lva.ts`.

### Microphone and echo

Linux Voice Assistant uses the default PipeWire source. To hear the wake word
while the Pi itself is talking or ringing, add PipeWire's echo canceller, for
example in `~/.config/pipewire/pipewire.conf.d/echo-cancel.conf`:

```text
context.modules = [
  { name = libpipewire-module-echo-cancel
    args = { source.props = { node.name = aec_mic } } }
]
```

Then set `AUDIO_INPUT_DEVICE=aec_mic` in the voice environment file and restart
`linux-voice-assistant`. `MIC_AUTO_GAIN` and `MIC_NOISE_SUPPRESSION` in the same
file help with speech from across the kitchen. The echo canceller only knows
what the Pi plays: music on the kitchen speaker is room noise that the wake word
has to be heard over.

## Bridge API

The bridge binds to loopback only.

| Endpoint | Purpose |
| --- | --- |
| `GET /api/status` | Whether the broker, BirdFrame and Linux Voice Assistant are reachable |
| `GET /api/birdframe`, `/api/birdframe/today` | BirdFrame's live snapshot and today's summary |
| `GET /api/birdframe/clip/<day>/<name>` | One of BirdFrame's recordings, validated and passed through |
| `GET /api/birds/photo?name=<scientific name>` | A Wikipedia photo of the species, cached on the Pi |
| `GET /api/weather` | Current conditions and the hourly forecast |
| `GET /api/media`, `/api/media/art` | The kitchen speaker and its album art |
| `POST /api/media/control` | `play_pause`, `next` or `previous` |
| `GET /api/home/events` | Presence and media changes over SSE |
| `POST /api/display` | `{"awake": true\|false}` switches the backlight |
| `GET /api/household`, `POST /api/household/control` | Household summary and its allowlisted lights |
| `GET /api/shopping`, `/api/shopping/events`, `/api/shopping/activity` | The canonical shopping list, live |
| `POST /api/shopping/items`, `/items/batch`, `/reconcile`, `/organize`, `/share`, `/clear-completed` | Shopping changes |
| `PATCH`, `DELETE /api/shopping/items/<uid>` | Rename, complete, restore or remove an item |
| `GET`, `POST /api/shopping/household` | Arrival-reminder settings |
| `POST /api/window` | Focus the kiosk or the BirdFrame display app |

## Canonical house shopping list

Home Assistant's `todo.shopping_list` is the only list. Voice uses it through
Assist, OpenClaw through the `house-shopping-list` skill and the broker, and
the Home Assistant app directly. The broker keeps a mode-`0600` record of who
changed what in `~/.openclaw/logs/shopping-activity.jsonl`. It can send the
list to an allowlisted phone, or send an arrival reminder once a shop zone,
person and phone have been chosen.

## Operations

On the Pi:

```bash
systemctl --user status touchscreen-bridge touchscreen-launcher linux-voice-assistant
journalctl --user -u linux-voice-assistant -f
systemctl --user restart touchscreen-launcher
```

All three services restart themselves (`Restart=always`). Chromium uses a
dedicated profile with `--password-store=basic`, which avoids a keyring prompt
leaving a white kiosk after boot.

On the Mac:

```bash
launchctl print gui/501/com.dan.pi-touchscreen-voice-broker
tail -f /Users/dan/Library/Logs/pi-touchscreen-voice-broker.error.log
node scripts/check-broker.mjs
```

To screenshot what the kiosk is showing, forward Chromium's debugger and run
the capture script:

```bash
ssh -L 9223:127.0.0.1:9222 dan@pi-touchscreen.local
node scripts/capture-pi-launcher.mjs
```

## Development

```bash
npm install
npm test            # builds, then the screen, broker and bridge tests
npm run lint
npx tsc -p tsconfig.appliance.json --noEmit
npm run appliance:build
```

To try the screen on the Mac, build it and run the bridge against the real
broker and BirdFrame:

```bash
LAUNCHER_STATIC_ROOT=dist-appliance VOICE_BROKER_URL=http://127.0.0.1:18890 \
  BIRDFRAME_URL=http://127.0.0.1:8355 python3 bridge/launcher_bridge.py
```

Then open `http://127.0.0.1:8765`. Without Linux Voice Assistant running, the
Talk button shows Offline and everything else works.

## Next

- A morning card written by OpenClaw from the BirdFrame MCP: what the garden
  did overnight. The LLM writes the words; the numbers come from BirdFrame.
- Family photos from the Inky frame library while nobody is using the screen.
- House notes: the washer finishing, the doorbell, bin day.
- A "who's singing?" guessing game built from BirdFrame's own recordings.
