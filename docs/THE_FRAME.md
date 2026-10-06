# Pi Touchscreen v2 — The Frame

A proposal for what this launcher should become, written against the code as it stands
on 6 October 2026 (`1e36cfb`). It follows the conversation that produced
`docs/LIVING_FRAME.md` in `birdframe-display`, and moves the centre of that plan into
this project.

**Status:** first build shipped on this branch, 6 October 2026 · **Last updated:** 2026-10-06

### What shipped in the first build

The owner chose ink silhouettes, touch-only presence for now, keeping the wake
word, a garden line drawn from the real view, bundled fonts, and going
straight to a visible frame before tidying. The branch therefore carries:

- §2 the three states, with the painting as the resting state (`components/frame/`);
- §3.1 the continuous sky, the sun, the moon's lit limb, the seeded stars;
- §3.2 weather from the Home Assistant entity, with the broker exposing cloud,
  wind speed and bearing;
- §3.3 the garden line drawn from the owner's photographs, with seasonal canopy
  and lit tenement windows at night;
- §3.4 parametric silhouettes for sixteen kinds, bodies by `1 + log2(calls)`,
  recency as ink, arrival flights and sky loops, the sparrowhawk freeze;
- §3.5 the event stream, the bloom with Wikimedia portrait and credit, first
  voice and new-to-garden treatments;
- §3.6 hearing a bird through the speaker with the wake word muted;
- §3.7 the gallery strip, quiet mode, night rest with the day's painting and
  narration;
- §3.8 Fraunces and Newsreader, §3.9 the honesty line;
- §4 the listening pulse and the fog when BirdFrame is unreachable;
- §5.3 the backlight route (the schedule that drives it is still to come);
- §6 the voice pill and the garden context on connect;
- §7 the bridge stream, the portrait, painting and snapshot caches;
- §8 the mock bridge, the time scrub, the panel-size screenshot harness and
  tests for the pure scene logic.

Still to do from this document: the backlight schedule keyed to the sun,
presence (§5.1) and the room's own sound (§5.2), the component split and
scaffold removal (§8), and the fixes in §9 not yet taken.

---

## 0. The brief

From the owner, lightly condensed:

- Live bird detection and imagery should be much more of the focus. Some kind of living,
  animated display of the current landscape. Dream big.
- Maximal effort on beauty, and on the feeling that it is alive with birds and any other
  activity.
- The voice feature is not really used as it is. There are other voice speakers and
  agents in the house. The screen will move elsewhere in the kitchen, where voice may
  become useful later.
- The hardware: a Raspberry Pi 5 with the 10" Touch Display 2 in portrait (1200 × 1920),
  a Seeed microphone, an IMX708 camera, and a speaker that the OpenAI voice already uses.

Two corrections to the earlier plan follow from this. The display *does* have a speaker:
this launcher plays Realtime audio through it, and `scripts/check-pi-media.mjs` renders a
test tone. And the microphone and camera are on the panel, not by the window. BirdNET
still listens from the Mac at the window, so the garden being painted is that window's
garden wherever the panel hangs.

---

## 1. What the screen is today, honestly

The kiosk boots into this launcher. It is the resting state of the panel; BirdFrame's
Flutter journal is "a doorway" one tap away. So what is on the wall most of the day is
`components/Launcher.tsx`, page 0:

- A masthead that reads **Touchscreen · home / A quiet intelligence** and a clock.
- A 560 px voice orb with **What would you like to know?** under it. `.assistant` has
  `min-height: 48rem`, so the orb and its prompt own well over half of a 1920 px panel,
  for a feature that is rarely used.
- Below the fold: a dark green **Live from BirdFrame** card (one bird name, "heard 3
  minutes ago", a species count, four chips), a shopping card, and a **Look** button that
  opens the shopping camera.
- Page 1, a swipe away: weather, calendar, four light groups, shopping again, and a
  "Garden right now" panel that repeats the bird card.

Nothing on the home page moves except the orb when a conversation is live. The bird
card is text on a flat colour. It polls `/api/birdframe` every 20 seconds and uses four
fields of the payload. What BirdFrame sends and the launcher drops:

| Field in `/api/now` | What it is | What happens to it |
|---|---|---|
| `feed[40]` | the last forty calls with time, confidence, SNR | ignored |
| `activity[24]` | call buckets across the window | ignored |
| `latest.tier` | confirmed / probable / tentative | ignored: a tentative match headlines the screen as fact |
| `latest.clip_url` | the recorded clip of the bird you are looking at | ignored, on the one device in the house with a speaker |
| `new_today` | first-ever visitors to the garden | ignored: the day's biggest moment never shows |
| `latest.scientific_name` | the key for a Wikipedia portrait | ignored |
| `rms_dbfs`, `noise_floor_dbfs`, `snr_db` | how loud the garden is | ignored |

And what the BirdFrame server offers that the launcher never asks for:

| Endpoint | What it gives the frame |
|---|---|
| `GET /api/detections?after_id=N&wait=30` | a long poll: arrivals within a second, not 20 |
| `GET /api/bird/{scientific_name}` | Wikipedia summary and thumbnail |
| `GET /api/clip/{day}/{common_name}` | the actual recording, `audio/ogg` |
| `GET /api/species-extra/{scientific_name}` | a reference song from Wikimedia for species with no clip yet |
| `GET /api/day/{YYYY-MM-DD}` | today's `images` records and `clips` |
| `GET /api/image/{id}?w=1200` | today's generated painting as a sized JPEG |
| `GET /api/narration` | one written line about today's birdsong |
| `GET /api/today`, `/api/census` | the day's cast, the life list for pre-warming |

Everything the brief asks for is already being served to this Pi. The launcher is
throwing it away and showing an orb.

---

## 2. The idea: the launcher becomes the frame

`docs/LIVING_FRAME.md` in `birdframe-display` describes a full-bleed living painting of
the garden as the resting state of the panel, with the record one gesture behind it.
That idea is right. This document says: **build it here, once, and let the Flutter app
keep the Study.** Three reasons.

1. **This is already the resting state.** The kiosk boots into Chromium, the wake word
   focuses Chromium, and the bridge in `bridge/launcher_bridge.py` owns window
   switching. The Flutter app is reached by a tap. Whatever is painted here is what the
   kitchen sees.
2. **The launcher has the senses the display lacks.** The speaker, so a bird can be
   heard. The camera, so the screen can know someone is there. The microphone, so the
   room's own sound can move the picture. None of these exist in the Flutter app's
   world, and the earlier plan had to defer every one of them.
3. **A browser is the fastest place to make something beautiful.** SVG, Canvas, CSS
   animation, the Web Animations API, Web Audio, self-hosted fonts, and
   `npm run appliance:dev` with hot reload. `scripts/capture-pi-launcher.mjs` already
   screenshots the real panel over the debugger tunnel. A Flutter golden takes a
   rebuild; a web tweak takes a save.

The Flutter display keeps what it does well and what the brief does not ask to change:
the Listening Window instrument, the chapters, the Atlas, the archive. "Open journal"
stays. Over time the live page in Flutter becomes redundant and can go; nothing here
depends on that.

The archetype table, the honesty rule, and the motion rules in `LIVING_FRAME.md` §3.4,
§4 and §6 carry over to this project word for word. They are not repeated below; this
document covers what is different because the frame is a web page on a Pi with a
speaker, a camera and a microphone.

### The three states of the panel

| State | When | What is on the glass |
|---|---|---|
| **Frame** | at rest, which is almost always | the painting, full bleed, a small clock, the honesty line |
| **Home** | someone touches the glass, or walks up to it (§5) | the painting recedes and dims; clock, shopping, household, the journal link and a small voice pill rise over it; 90 s without touch and it returns to Frame |
| **Conversation** | the wake word or a tap on the pill | transcript over the dimmed painting; the birds keep moving behind the words |

The orb does not go away. It becomes a pill in Home and grows only while a conversation
is live. "What would you like to know?" goes; the frame's caption takes that line.

---

## 3. The frame, layer by layer

Back to front. Each layer is its own element on its own compositor layer, so a layer
that has not changed costs nothing, which matters on a Pi.

### 3.1 The sky, continuous

- Solar elevation and azimuth from the real date, in about sixty lines of JavaScript (or
  the `suncalc` package, 5 KB). Latitude and longitude join the environment file written
  by `deploy/pi/install.sh` as `LAUNCHER_LATITUDE`, `LAUNCHER_LONGITUDE`,
  `LAUNCHER_PLACE`, defaulting to BirdFrame's Edinburgh values.
- A continuous palette keyed to elevation from −18° to +60°, interpolated per second.
  The sun drawn on its real arc with a glow that widens near the horizon. A seeded star
  field and the moon with its true lit limb. Midsummer never reaches astronomical night
  here and the maths knows it, so the sky stays blue.
- Palette discipline: woodblock, not weather app. The existing `--paper`, `--forest`,
  `--gold` and `--ink` tokens by day; cream ink on indigo by night. A static paper-grain
  PNG multiplied over everything so no gradient reads as digital.

### 3.2 Weather, from the hub you already have

`LIVING_FRAME.md` had to ask whether Open-Meteo was an acceptable new vendor. Here it
is not a question: `broker/openclaw_voice_broker.ts` already reads `weather.home` from
Home Assistant for the household page and keeps only `condition`, `temperature` and
`humidity`. The same entity carries `cloud_coverage`, `wind_speed`, `wind_bearing` and
`precipitation` where the integration provides them. Add them to `getHouseholdHub()`
and the frame has its weather with no new account, key or credit line.

Cloud cover sets how many slow shapes drift and how dense; wind sets their drift and the
sway of grass and branch; precipitation draws fine hatching that thickens with intensity.
No weather means a clear, still sky. Never an icon.

### 3.3 The garden line

One hand-drawn SVG across the bottom third: roofline and chimney, a wire, a hedge, a
lawn, one tree. Seasonal canopy from day of year. Named perch anchors as `<g id>`
elements so the inhabitants layer can read their coordinates. It can be generic to
start; a drawing of the real view from the Mac's window is the owner's call (§11).

### 3.4 The inhabitants

The species-to-archetype table from the earlier plan, as `lib/frame/archetypes.ts`,
and silhouettes as SVG paths with two or three wing frames. Flight along SVG paths with
the Web Animations API (`offset-path`), which the compositor runs without JavaScript per
frame. Bodies per species `1 + floor(log2(calls))`, capped at 24, newest species first.
Recency is ink: full at the last call, fading across the window, then gone.

### 3.5 The moment: a call lands

- Arrivals come from a new bridge stream, `GET /api/birdframe/events` (§7), which
  turns BirdFrame's long poll into server-sent events. A bird appears within a second of
  being heard, not within twenty.
- The body flies in from its archetype's edge and settles on an allowed anchor. Its name
  sets in display serif beside it, 48 px or larger, holds eight seconds, fades. Tier
  shows as ink weight, never as a badge: confirmed is full ink, tentative is a ghost.
- **The portrait bloom.** The species' Wikimedia photograph rises as a large vignette in
  the sky for twenty seconds with one caption line and the credit, then slides down into
  the gallery strip. Portraits come from the bridge's cache (§7), which uses exactly the
  two-step Wikipedia `pageimages` + Commons `imageinfo` lookup that
  `wikimedia_bird_photo_service.dart` already does, ported to Python.
- **First voice.** The first call of the day holds a full minute with
  `FIRST VOICE · 04:12 · 52 MIN BEFORE SUNRISE`. A name in `new_today` is a first-ever
  visitor to the garden and blooms in gold with `NEW TO THIS GARDEN`.
- Repeats are calm. A second call from the same species within two minutes re-blooms
  the ribbon only.

### 3.6 Hear it

This is the one thing only the launcher can do, and it can do it today.

- Tap a bird in the painting, or the name during a bloom, and it sings: an `<audio>`
  element plays `latest.clip_url` (or the day's clip for that species from
  `/api/day/{today}.clips`), proxied through the bridge. A song ribbon blooms from the
  bird, its amplitude from a Web Audio analyser on the actual clip. For a species with
  no clip yet, `/api/species-extra` offers a reference recording, labelled as such.
- Tap only, never auto-play. A kitchen has an extractor fan and a radio. Quiet hours
  follow the backlight schedule (§5.3).
- The wake listener must not hear the bird as "Computer": `muteWake()` already exists
  for conversations; call it for the clip's duration plus a second.

### 3.7 The gallery, and the frame at rest

- A gallery strip along the foot: today's species as round portraits, newest first, each
  a tap target that plays the clip or, with a long press, opens the journal. By evening
  it is the day's cast.
- Quiet mode: ten minutes without a call and the frame cycles today's portraits over the
  live sky, twelve seconds each with a slow pan, credited. Any call interrupts it.
- Night rest: after last light, today's generated painting from
  `/api/day/{today}.images` hangs as the closing plate, with the `/api/narration` line
  as its caption and the day's tally. Stars behind it. Then the backlight dims (§5.3).
  BirdFrame paints the day once; this is the first screen in the house to hang it.

### 3.8 Type

Bundle Fraunces for display and Newsreader for text, both under the SIL Open Font
License, as self-hosted `woff2` in `public/fonts/` with `font-display: swap`. Today the
whole UI is Georgia and Inter from whatever the Pi's Debian image provides, and the
weather symbols (`ϟ`, `✣`, `☂`) depend on fallback fonts that may render as boxes. In a
web app this is a half-day change and the largest gain in beauty per byte available.

### 3.9 The honesty line

Once, in small type at the foot of the painting:
`AN IMPRESSION OF THE LAST HOUR · THE JOURNAL IS ONE TAP AWAY`. Bodies are not counts.
Every photograph is credited. The measured record is unchanged and one tap away.

---

## 4. Alive, on a Pi

The motion rules from the earlier plan apply (nothing steps, motion means something,
idle motion never visibly repeats, the frame listens visibly). What a browser on a Pi 5
adds:

- **Compositor-only motion.** Animate `transform` and `opacity` and `offset-distance`
  only. No `filter: blur`, no `backdrop-filter`, no animated `box-shadow`.
  `app/globals.css` currently has 22 blurs and large shadows, including a
  `backdrop-filter` on the page nav; the frame uses none, and Home should lose most.
- **A frame budget by state.** Sky palette ticks once a second. Clouds and grass run as
  long CSS animations with incommensurate periods (7.3 s, 11.1 s, 17.9 s). Bodies use
  Web Animations, so the main thread is idle between arrivals. `document.hidden` pauses
  everything, which matters when the Flutter journal is focused on top.
- **Measure on the panel.** The existing debugger tunnel on `9223` gives the CDP
  `Performance` domain; pair it with `vcgencmd measure_temp`. A 24-hour soak at under
  60 °C is the gate for shipping the inhabitants layer.
- **The frame listens visibly.** Every time the event stream delivers a heartbeat (at
  least every thirty seconds) a faint ring expands from the hedge. When BirdFrame is
  unreachable the ring stops and the scene fogs slightly. Today, unreachable and silent
  both read "The garden is listening"; they must look different.

---

## 5. The screen knows you are there

This is the "any other activity" the brief mentions, and it is what makes a resting
frame feel alive rather than merely animated.

### 5.1 Presence

Two ways, in order of cost:

- **A Home Assistant motion or occupancy sensor in the kitchen**, if one exists. The
  broker already has the credential and a WebSocket to Home Assistant for shopping
  events; subscribing to one more entity's state is twenty lines. A push to the bridge
  stream, and the frame steps back into Home as you walk in.
- **The camera, locally.** The bridge runs one persistent low-resolution
  `rpicam-vid --codec mjpeg --width 320 --height 180 --framerate 2` and compares luma
  between frames (Pillow is a Debian package: `python3-pil`). A change over a threshold
  for two consecutive frames is "someone is here". No frame is stored, nothing leaves
  the Pi, and the same stream replaces the current preview, which spawns a fresh
  `rpicam-still` process every two seconds while the shopping camera is open.

Either way the behaviour is the same: approach brings Home forward, absence returns the
Frame, and a long absence (an hour of no presence and no calls) lets the frame drift to
quiet mode early.

### 5.2 The room's own sound

The Seeed microphone already feeds PocketSphinx continuously. A tiny sidecar in
`bridge/wake_listener.py` (or a second `pw-record` at 8 kHz into a 200 ms RMS) gives a
room level to the bridge. The frame uses it for a slow shimmer on the grass: a busy
kitchen moves more than a still dawn. Nothing but a number leaves the process, and it is
honest about what it is: the caption calls it "the room".

### 5.3 Light

The Flutter app dims the real panel at night through `/sys/class/backlight`; the kiosk
runs Chromium at full brightness at 3 a.m. Add `POST /api/display` to the bridge that
writes `brightness` (the service user is in the `video` group; `/sys` stays writable
under `ProtectSystem=strict`), and a schedule keyed to the same solar elevation as the
sky: full by day, 40 % after civil dusk, 8 % through the night, up again before dawn
chorus so the first voice is seen. Presence overrides it for two minutes.

---

## 6. Voice, smaller and smarter

The owner does not use it, has other assistants, and might in the new spot. So: keep it,
cost it nothing on the glass, and make it know where it is.

- **A pill, not an orb.** In Home, a small listening pill with the wake-word hint. The
  orb grows only in Conversation. The transcript renders over the dimmed painting.
- **It knows the garden.** When the data channel opens, `lib/realtimeVoice.ts` sends
  one `conversation.item.create` with a `system` message summarising the current
  `/api/now`: the latest bird and its tier, the last hour's roster, first-ever visitors,
  the weather. "What was that bird?" and "what has been singing this morning?" then
  answer instantly from what the screen already knows, with no OpenClaw consult, no
  round trip to the Mac, and nothing new exposed to the browser. The same hook can
  describe what is on the glass during a bloom.
- **Wake word in the new spot.** PocketSphinx runs the decoder continuously; if the
  panel moves next to a hob and a radio, false wakes rise. The `WAKE_THRESHOLD` knob
  exists; the decision whether to keep the wake word at all is the owner's (§11).
- **Nothing more until it is used.** Timers, recipes and the like are obvious kitchen
  asks, but they are new tools in OpenClaw's session, not this launcher's, and the brief
  says voice is not the focus. Leave them until the pill gets touched.

---

## 7. The data path, instant and resilient

New bridge routes in `bridge/launcher_bridge.py`, all loopback, all read-only toward
BirdFrame:

| Route | Does |
|---|---|
| `GET /api/birdframe/events` | SSE. The bridge long-polls `/api/detections?after_id=&wait=30` upstream and pushes `detection` events, a `snapshot` of `/api/now` every 30 s, a `heartbeat`, and `presence` and `room` levels from §5 |
| `GET /api/birdframe/portrait/{scientific_name}` | the Wikipedia + Commons lookup with credit, cached as files under `~/.cache/touchscreen-launcher/portraits/`, pre-warmed from `/api/census` at boot so a cold start never shows an empty gallery |
| `GET /api/birdframe/clip?...`, `/api/birdframe/artwork/{id}` | byte proxies for the clip and the day's painting, cached |
| `POST /api/display` | backlight, §5.3 |

The bridge keeps the last `/api/now` on disk, as the shopping list already does in
`localStorage`, so a Mac or LAN outage shows the last-known garden with an honest
`LAST HEARD 14:02 · BIRDFRAME UNREACHABLE` rather than a blank. The browser computes
"minutes ago" from the detection's `at` and its own clock; today `seconds_ago` is the
server's number and freezes at whatever it was when BirdFrame last answered.

The same stream can carry `wake` events and retire the 900 ms poll of `/api/wake`
(about 4,000 requests an hour on loopback) and the `systemctl` calls that `/api/status`
spawns on every 20 s refresh.

---

## 8. Making the project easy to work on

The scene is a lot of new code. The repository should be ready for it first.

- **Strip the template.** The appliance is a Vite SPA (`appliance/`), yet the repo
  still carries the site-creator scaffold it was started from: `next.config.ts`,
  `vite.config.ts` (vinext + Cloudflare), `worker/index.ts`, `app/layout.tsx`,
  `app/page.tsx`, `app/chatgpt-auth.ts`, `db/`, `drizzle/`, `drizzle.config.ts`,
  `examples/d1/`, `build/sites-vite-plugin.ts`, `.openai/hosting.json`, and the
  `next`, `vinext`, `wrangler`, `@cloudflare/vite-plugin`, `drizzle-*`,
  `react-server-dom-webpack` dependencies. Nothing in the appliance imports any of it;
  `app/globals.css` is the only file under `app/` that is used. `npm test` currently
  runs the Cloudflare build solely so `tests/rendered-html.test.mjs` can grep the HTML.
- **Split `Launcher.tsx`.** One 2,082-line component with thirty `useState` calls and
  an 1,800-line stylesheet. Before the frame lands: `features/frame/`,
  `features/home/`, `features/shopping/`, `features/household/`, `features/camera/`,
  `features/voice/`, each with its own CSS and its own hooks, and a thin `Launcher`
  that holds the three-state machine from §2.
- **Develop the painting on a laptop.** `scripts/mock-bridge.mjs` serves recorded
  fixtures (`fixtures/now.json`, a replayable `feed.jsonl`, portraits) on `8765`, with
  `?at=2026-06-21T04:12` to scrub the sky and `?replay=dawn-chorus` to play a recorded
  morning at 20×. This is the equivalent of the display's preview harness and the only
  way to iterate on dawn without getting up at four.
- **Goldens.** A Playwright test at 1200 × 1920 against the mock bridge for `frame_day`,
  `frame_dawn_chorus`, `frame_quiet_gallery`, `frame_night_rest`, `frame_rain`,
  `home`, `conversation`. Chromium is already a project dependency through the capture
  script; beauty work becomes reviewable in a diff.
- **Real tests.** The pure parts of the scene (`archetypes.ts`, body counts, the solar
  palette, the state machine, the SSE reducer) are plain functions and deserve the kind
  of tests `tests/realtime-voice.test.mjs` already gives `voiceConversation.ts`. The two
  tests that grep source text for class names should go with the scaffold.
- **Keep the discipline.** `tsc -p tsconfig.appliance.json --noEmit`, `eslint`,
  `py_compile`, and the Playwright goldens, all in one `npm test` that needs no
  Cloudflare build.

---

## 9. Fixes found while reading

Small, independent of the plan, worth doing first:

- `fallbackBirds` shows "The garden is listening" both when BirdFrame is quiet and when
  it is unreachable; the card is disabled in the second case but reads the same.
- `timeAgo(birds.latest?.seconds_ago)` uses the server's number and freezes when
  BirdFrame stops answering; "heard just now" can be an hour old.
- `latest.tier` is ignored, so a tentative BirdNET match headlines the screen as fact.
- `new_today` is ignored, so a first-ever visitor looks like any other bird.
- `latest.clip_url` is ignored on the only screen in the house with a speaker.
- The clock ticks every 15 s, so the minute can change up to 15 s late; schedule the
  tick on the minute boundary.
- `/api/wake` is polled every 900 ms for the life of the page; `/api/status` runs two
  `systemctl` subprocesses on every 20 s refresh. Both belong on the event stream (§7).
- The shopping camera preview spawns `rpicam-still` every two seconds, about a second
  of CPU each; one persistent low-resolution `rpicam-vid` serves preview and presence.
- `weatherSymbol()` returns `ϟ` and `✣`, which depend on the Pi's fallback fonts.
- The household page's "Garden right now" panel duplicates the bird card.
- `README.md` says BirdFrame "has a persistent Home pill that posts
  `{"target":"assistant"}` to the loopback bridge". No such code exists on
  `birdframe-display`'s `main`. If it is only on the Pi, it needs committing; otherwise
  the only ways back from the journal are the wake word or a service restart.
- `broker/openclaw_voice_broker.ts` imports OpenClaw by relative path
  (`../../openclaw/src/...`), so the broker breaks if either checkout moves; worth a
  note in the README or an environment variable.
- The masthead copy, "A quiet intelligence" and "What would you like to know?", is the
  voice product's; the screen is mostly a garden.

---

## 10. Phasing

Each phase ships something felt on the wall and adds its golden.

1. **Foundations** (three or four days). Strip the scaffold, split the component, the
   mock bridge with time scrub, Playwright goldens, bundled fonts, the three-state shell
   with a plain sky as Frame and today's cards as Home. The fixes in §9.
2. **The sky and the frame** (about a week). Continuous palette, sun, moon, stars, the
   garden line, the listening pulse, weather from the hub, the backlight schedule.
   Alive before a single bird is drawn.
3. **The moment and the gallery** (about a week). The event stream, the portrait cache,
   the bloom, first voice and first-ever, the gallery strip, quiet mode, night rest with
   the day's painting and narration, and hearing the bird.
4. **Inhabitants** (two or three weeks, iterated on the panel). The archetype table,
   the five commonest first (tit, thrush, skulker, pigeon, aerial), behaviour loops,
   arrivals, fading and departures. Then the rest.
5. **Presence and breath.** The sensor or the camera, the room level, the voice that
   knows the garden.

---

## 11. Decisions that stay with the owner

1. **Where the painting lives.** Here, with the Flutter app as the journal, as this
   document recommends; or in Flutter after all, with this launcher staying a launcher.
2. **Taste.** Representational ink silhouettes, or abstract marks and ribbons only.
3. **Presence.** A Home Assistant sensor in the kitchen, the camera on the Pi, or
   touch only.
4. **The garden line.** Generic, or drawn from a photograph of the real view.
5. **Fonts.** Fraunces and Newsreader under the OFL.
6. **The wake word.** Keep "Computer" running next to the hob, or make voice
   touch-only in the new spot.
7. **The new spot.** If it has a window, a cheap camera at that window is the most
   honest live imagery possible, and a second listening post for BirdNET is not far
   behind.
