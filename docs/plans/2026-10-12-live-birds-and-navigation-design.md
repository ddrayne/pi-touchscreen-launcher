# Live birds and clear navigation — design

Date: 2026-10-12

## Problem

- The touched screens switch pages with two unlabelled 8px dots and a swipe.
  It is easy to land on the household page by accident and hard to get back:
  swipes are claimed by Chromium as browser gestures and cancelled.
- After dark the idle frame replaces the live roll call with BirdFrame's
  painting of the day, so the live birds disappear all evening.
- The Voice page shows only the latest bird; the lower 60% of the screen is
  empty. At night its masthead is dark green on the night sky and nearly
  invisible.

## 1. Navigation

- Replace the dots with a two-tab bar fixed at the bottom of the touched
  screens: **Voice** and **Household**, each half about 64px tall and at least
  200px wide, current tab filled forest green. Same frosted pill, larger and
  labelled. Both pages get bottom padding so the bar never covers content.
- Swipe stays and becomes reliable: `touch-action: pan-y` on the launcher so
  horizontal swipes reach the app, and `pointercancel` clears the swipe state.
- Returning to the idle frame also resets to **Voice**, so the next tap always
  lands on the first page.
- The masthead on both pages uses the frame's night type colour
  (`--frame-type-rgb`) so it reads at night; the tab bar follows it.
- Drop the "Swipe right for voice" hint.

## 2. Idle frame at night

- The roll call renders around the clock. Quiet hours fall back to the existing
  "Quiet now · earlier today" rows.
- The painting of the day becomes a plate of about 300×400px with a thin cream
  border and the caption "Painting of the day". It sits on the right third of
  the "Coming up" band, with the agenda on the left two thirds. It shows only
  at night (`darkness > 0.85`) and only when BirdFrame painted something today.
  Otherwise the agenda keeps the full width.
- Tapping the plate opens the journal and stops the event from also waking the
  frame to home.
- Remove the full-size `frame-rest` figure, its narration and `data-rest`
  styling.
- The plate rule lives in a pure helper in `lib/frame/`, with tests.

## 3. Today's birds on the Voice page

- The hero BirdFrame card keeps its job (latest bird, Hear it, Open journal)
  and gains that bird's portrait.
- Below the cards, a "Today in the garden" grid: four columns and up to three
  rows (twelve tiles), newest first. Each tile shows the portrait (or initial),
  name, last-heard time, tier and call dots. Earlier birds fade with the roll
  call's recency rule. With more than twelve species, a closing line reads
  "+N more today · Open journal →".
- Tapping a tile plays that bird's recording, with a gold playing ring and a
  Stop state; tapping again stops it. Only one clip plays at a time across the
  hero card, the grid and the idle board. Playback mutes the wake word as now.
- Live: a new call moves its tile to the front with a short gold bloom.
- Portrait loading and clip playback move out of `Frame.tsx` into a shared
  `useBirdVoices` hook in `lib/frame/`. The cast ordering for the grid is a
  pure function with tests.
- Unreachable BirdFrame: keep the last known birds under "Unreachable · last
  heard HH:MM". No data at all: "Listening…".

## Testing

- Unit tests (`tests/frame-*.test.mjs`) for the plate rule and the grid
  ordering, fade and overflow count.
- `npm run appliance:build`, deploy to the Pi, and check by screenshot by day
  and at night (`?at=` clock override) for the tab bar, night masthead, grid
  and plate.
