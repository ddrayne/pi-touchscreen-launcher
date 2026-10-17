# Poster Frame Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the idle frame's roll call with a poster whose blocks, sizes and colours are generated from what BirdFrame heard, then carry the same block language onto the Voice and Household pages.

**Architecture:** A pure layout module (`lib/frame/poster.ts`) turns a `FrameSnapshot` into a list of grid blocks; a pure palette module (`lib/frame/palette.ts`) turns the solar state and a block's age into colours. The bridge computes a tint and a focal point per cached portrait once, with Pillow. `components/frame/Poster.tsx` renders the blocks on a CSS grid and animates placement changes with FLIP transforms. Nothing renders continuously when nothing happens.

**Tech Stack:** React 19, Vite appliance build, CSS grid and custom properties, `node --test` for TypeScript modules, Python 3 + Pillow in the bridge, Playwright screenshots through `scripts/mock-bridge.mjs`.

Design: `docs/plans/2026-10-17-poster-frame-design.md`. Read it first.

Conventions:
- Tests import `.ts` directly: `node --test tests/frame-*.test.mjs` (Node 22 strips types). Run `npm run test:frame`.
- Bridge tests: `npm run test:bridge`.
- Pure modules never touch the DOM. Every rule in them has a test.
- Commit after each task with a one-line message in the repo's style (a sentence, no prefix), ending with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Performance first: no `setInterval` faster than once a second, no continuous canvas, transitions on `transform`/`opacity`/CSS variables only.

---

### Task 1: The pure poster field (`lib/frame/poster.ts`) and palette (`lib/frame/palette.ts`)

**Files:**
- Create: `lib/frame/poster.ts`
- Create: `lib/frame/palette.ts`
- Create: `tests/frame-poster.test.mjs`
- Create: `tests/frame-palette.test.mjs`
- Create: `scripts/poster-ascii.mjs` (prints the field for a fixture, for eyeballing)
- Read first: `lib/frame/scene.ts` (`FrameSnapshot`, `FrameSpecies`, `inkFor`, `castFor`, `hashString`, `parseSnapshot`), `lib/frame/solar.ts` (`SkyPalette`, `Rgb`, `mixRgb`, `smoothstep`), `components/frame/Frame.tsx:56-67` (the paper/ink constants to move), `tests/frame-scene.test.mjs` (fixture loading style).

**The field.** The bird area is 6 columns × 6 rows (36 cells), 0-based `col`/`row`. The component adds the house rows itself.

```ts
export const FIELD_COLS = 6;
export const FIELD_ROWS = 6;
export const MIN_HOUR_SPECIES = 4;   // fewer than this → draw from today
export const HERO_MIN_CELLS = 9;     // the latest bird is at least 3 × 3
export const MAX_SIDE = 4;
/** Areas a block may have; each maps to the rectangles below. */
export const SHAPE_AREAS = [1, 2, 3, 4, 6, 8, 9, 12, 16] as const;

export type PosterArea = { col: number; row: number; cols: number; rows: number };
export type BirdBlock = {
  kind: "bird";
  key: string;              // common name
  species: FrameSpecies;
  area: PosterArea;
  /** Milliseconds since last heard. */
  age: number;
  /** 1 at the last call, falling with age; drives cooling. */
  ink: number;
  hero: boolean;
  newToGarden: boolean;
};
export type MoreBlock = { kind: "more"; key: "more"; names: string[]; area: PosterArea };
export type GroundBlock = { kind: "ground"; key: string; area: PosterArea };
export type PosterBlock = BirdBlock | MoreBlock | GroundBlock;
export type PosterField = { window: "hour" | "today"; blocks: PosterBlock[] };

export function composeField(snapshot: FrameSnapshot | null, now: number, previous: PosterField | null): PosterField;
export function describeField(field: PosterField): string; // ASCII, one char per cell, for tests and the script
```

Rules, in order:

1. **Window.** Candidates are `snapshot.species` with `lastHeard` defined and `inkFor(lastHeard, now, windowMinutes) > 0`. If fewer than `MIN_HOUR_SPECIES`, use `castFor(snapshot)` instead (`window: "today"`), with ink computed over the day: `age / (now − startOfDay)`, floored at 0.2. Null snapshot → `{ window: "hour", blocks: [] }`.
2. **Hero.** The species of `snapshot.feed[0] ?? snapshot.latest` when it is among the candidates; otherwise the most recently heard candidate.
3. **Weight.** `(1 + log2(count)) * (0.35 + 0.65 * ink)`.
4. **Cells.** `cells = round(36 * weight / Σweight)`, at least 1, hero at least `HERO_MIN_CELLS`, at most 16. Snap each down to the nearest `SHAPE_AREAS` entry. While the sum exceeds 36, step the largest non-hero block down one shape; if every non-hero block is already 1, move the lowest-weight species into the `more` list (which takes one cell when non-empty). While the sum is under 36, step the heaviest block that can grow (≤ 16, hero first) up one shape; stop when nothing can grow. Any cells still free become `ground` blocks after packing.
5. **Shapes.** 1→1×1; 2→2×1 or 1×2; 3→3×1 or 1×3; 4→2×2; 6→3×2 or 2×3; 8→4×2 or 2×4; 9→3×3; 12→4×3 or 3×4; 16→4×4. The wide orientation is tried first, except when `hashString(name) % 2 === 1`, which tries tall first.
6. **Placement.** Order: hero, then species present in `previous` in their previous order, then new species by weight descending, then `more`. Each block is placed at its previous origin if its rectangle fits there, else at the first free origin scanning rows from the previous origin's row then wrapping, else from the top-left. A new hero with no previous goes top-left when `hashString(name) % 2 === 0`, else top-right. If a rectangle fits nowhere, try the other orientation, then step the shape down until it fits; if even 1×1 fails, the species goes to `more`.
7. **Ground.** Every free cell left becomes a 1×1 `ground` block, merged greedily into wider rectangles along a row. The `more` block, when present, takes the first free cell instead of a ground block.
8. **Determinism.** No `Math.random`, no `Date.now`. Two calls with equal input give deep-equal output.

**Palette.**

```ts
export type GroundPalette = { paper: Rgb; paperDeep: Rgb; type: Rgb; gold: Rgb; /** 0 by day, up to 0.4 at night: how much photos dim. */ dim: number };
export function groundPalette(sky: SkyPalette, rising: boolean): GroundPalette;
/** How a block cools with age: saturation 1 → 0.15 and tintMix 0 → 0.85 by `coolMs` (default 40 min), eased. */
export function cooling(ageMs: number, coolMs?: number): { saturation: number; tintMix: number };
/** The block's background: its own tint pulled toward the paper by tintMix; null tint → paperDeep. */
export function blockTint(tint: Rgb | null, ground: GroundPalette, tintMix: number): Rgb;
/** Type weight by tier: confirmed 700, probable 500, tentative 300. */
export function tierWeight(tier: Tier | undefined): number;
/** Readable type over a tint: cream over dark, ink over light (relative luminance < 0.45 → cream). */
export function typeOver(tint: Rgb): Rgb;
```

Move `PAPER_DAY`, `PAPER_NIGHT`, `TYPE_DAY`, `TYPE_NIGHT`, `GOLD` from `Frame.tsx` into `palette.ts` and export them; `Frame.tsx` imports them (keep `typeInkFor` behaviour identical). Dusk and dawn: when `sky.darkness` is between 0.2 and 0.8 mix 12% of the sky's `glow` into `paper`.

**Steps**

1. Write `tests/frame-poster.test.mjs` first, loading `fixtures/now-morning.json` + `fixtures/today-morning.json` (quiet morning) and, once Task 3 lands, `fixtures/now-loud.json` + `fixtures/today-loud.json`. Until then build a synthetic loud snapshot in the test (14 species in the hour with counts 41, 12, 10, 8, 2, 2, 2, 1 × 7; 51 today). Tests:
   - every cell is covered by exactly one block (sum of areas is 36, no overlaps, all within 0..5);
   - no block side exceeds `MAX_SIDE`; the hero has at least 9 cells;
   - quiet fixture → `window === "today"`; loud → `"hour"`;
   - deterministic: `composeField(s, now, null)` twice → `deepEqual`;
   - stability: a second call with `previous` and a new detection for an existing species whose shape doesn't change (use `applyDetection`) leaves every bird block's `area` deep-equal; when the hero grows a shape, its origin is unchanged and at least 70% of the other surviving species keep their origin;
   - a new species (not in `previous`) appears as a block without any previously placed block changing size;
   - ground blocks on the loud fixture number at most 6;
   - `describeField` renders 6 lines of 6 characters.
2. Run `node --test tests/frame-poster.test.mjs`, see it fail on the missing module.
3. Implement `poster.ts` to the rules above. Keep helpers small and named: `candidatesFor`, `weightOf`, `allocateCells`, `shapesFor`, `place`, `fillGround`.
4. Run the tests until green. Then `tests/frame-palette.test.mjs`: cooling at 0 ms is `{1, 0}`, at 40 min `{0.15, 0.85}`, monotonic; `blockTint(null)` is `paperDeep`; `typeOver` picks cream over `[20,20,20]` and ink over `[240,235,220]`; `groundPalette` at darkness 0 is `PAPER_DAY`, at 1 is `PAPER_NIGHT`; `tierWeight` values.
5. `scripts/poster-ascii.mjs <now.json> <today.json> [ISO now]` prints `describeField` plus a legend (letter → species, cells). Run it on both fixtures and paste the output into the commit message body.
6. `npm run lint` and `npm run test:frame` green. Commit: "Compose the poster field from the birds, pure and tested".

---

### Task 2: Tint and focal point from the bridge

**Files:**
- Create: `bridge/portrait_features.py` (pure; also a CLI to backfill a directory)
- Create: `bridge/test_portrait_features.py`
- Modify: `bridge/launcher_bridge.py` (`PortraitCache._fetch`, `PortraitCache.lookup`, `serve_portrait`)
- Modify: `lib/frame/portraits.ts` (`Portrait` type and parser)
- Read first: `bridge/launcher_bridge.py:590-720` and `:1059-1094`, `bridge/test_launcher_watchdog.py` for test style, `lib/frame/portraits.ts`.

**`portrait_features.py`**

```python
def portrait_features(image: bytes) -> dict[str, Any] | None:
    """{"tint": [r, g, b], "focal": {"x": 0..1, "y": 0..1}} or None when Pillow is missing or the image is unreadable."""
```

- Import Pillow inside a `try`; return `None` on `ImportError`.
- Tint: convert to RGB, `thumbnail((96, 96))`, `quantize(colors=6, method=Image.Quantize.MEDIANCUT)`, take the palette entries with their pixel counts, and choose the one maximising `count * (0.35 + saturation)` where saturation is HSV S in 0..1. This keeps a blackbird near-black and a robin rust rather than the grey background.
- Focal: on a 64×64 RGB thumbnail, split into an 8×8 grid of mean colours; weight each cell by the squared distance from the image's overall mean colour; focal = weighted centroid of cell centres, as fractions 0..1, rounded to 3 dp. Uniform image → `{0.5, 0.5}`.
- CLI: `python3 bridge/portrait_features.py <dir>` reads every `*.json` meta with a `file` next to it, computes features when `tint` is absent, rewrites the meta. Prints one line per file. (Used locally on `outputs/mock/portraits`.)

**Tests** (`bridge/test_portrait_features.py`, synthetic images built with Pillow in the test; skip the module if Pillow is missing):
- A grey image with a red square in the bottom-right quadrant → tint is red-dominant (`r > 150`, `g < 90`, `b < 90`) and focal `x > 0.6`, `y > 0.6`.
- A uniform image → focal `(0.5, 0.5)`.
- Garbage bytes → `None`.

**Bridge wiring**
- `_fetch`: after writing the image, `features = portrait_features(image)`; if not `None`, merge into `meta` before writing.
- `lookup`: when the cached meta has a file but no `tint`, compute from the file once (under `self.lock`), rewrite the meta, return it. Never block on failure: no features is fine.
- `serve_portrait`: add `"tint": meta.get("tint")` and `"focal": meta.get("focal")` to the JSON.

**Client**
- `Portrait` gains `tint: [number, number, number] | null` and `focal: { x: number; y: number } | null`; parse defensively (three finite numbers; two finite numbers in 0..1), else `null`.

**Steps**: tests first (`python3 -m unittest bridge.test_portrait_features`), implement, `npm run test:bridge`, then the client change with a case added to `tests/frame-scene.test.mjs`? No: `portraits.ts` has no parser test today; add `tests/frame-portraits.test.mjs` that exports and tests a pure `parsePortrait(raw)` function you factor out of the fetch. Run the backfill CLI on `outputs/mock/portraits` (not committed; `outputs/` is ignored). Commit: "Give every portrait a tint and a focal point".

---

### Task 3: A loud fixture, mock scenes and the screenshot list

**Files:**
- Create: `fixtures/now-loud.json`, `fixtures/today-loud.json`
- Modify: `scripts/mock-bridge.mjs` (scene table, fixture choice, portrait route)
- Modify: `scripts/screenshot-frame.mjs` (scene list)
- Read first: `fixtures/now-morning.json`, `fixtures/today-morning.json` (exact shape and field names), `scripts/mock-bridge.mjs` (`retimedNow`, `SCENES`, the portrait route at ~312), `scripts/screenshot-frame.mjs`.

**Fixtures.** Model the loud afternoon from the owner's screenshot (17 Oct 2026, 15:48): 14 species in the hour and 51 today. In the hour, newest first: Eurasian Blackbird 2 (15:47, confirmed), European Robin 41 (15:44, confirmed), Dunnock 8 (15:44, confirmed), Common Kingfisher 1 (15:44, tentative), Eurasian Wren 12 (15:40, confirmed), Eurasian Linnet 2 (15:38), Ring-necked Pheasant 2 (15:37, probable), Common Greenshank 1 (15:36, tentative), Eurasian Coot 1 (15:34, probable), Common Buzzard 1 (15:32, probable), Common Raven 1 (15:32, tentative), Redwing 10 (15:30, confirmed), Eurasian Magpie 3 (15:21), Goldcrest 4 (15:05). Use correct scientific names (they must match files in a Wikimedia portrait cache: e.g. `Erithacus rubecula`, `Prunella modularis`, `Alcedo atthis`, `Troglodytes troglodytes`, `Linaria cannabina`, `Phasianus colchicus`, `Tringa nebularia`, `Fulica atra`, `Buteo buteo`, `Corvus corax`, `Turdus iliacus`, `Pica pica`, `Regulus regulus`, `Turdus merula`). The `feed` holds the last 40 calls with realistic spacing (robin calls every minute or two). `today_species_count` 51 and `today.species` lists 51 British species with plausible counts; `new_today` empty. Keep every field the morning fixtures have, including `activity` (24 buckets, busy in the last hour).

**Mock scenes.** Scenes gain an optional `fixture: "loud"`; `retimedNow` and the today route pick `now-loud`/`today-loud` for it. Add `loud: { fixture: "loud", latestAgoMs: 60_000, weather: "sunny", arrivals: [["European Robin", "Erithacus rubecula", 0.9], ["Eurasian Wren", "Troglodytes troglodytes", 0.88], ["Goldfinch", "Carduelis carduelis", 0.8]], intervalMs: 8_000 }`. Everything else unchanged.

**Mock portraits.** The portrait route should behave like the bridge: with `MOCK_PORTRAITS_DIR`, look for `<safe>.json` where `safe` replaces runs of characters outside `[A-Za-z0-9._-]` with `_` (the bridge's `safe_name`), and when it exists return its `title`, `artist`, `license`, `source`, `tint`, `focal` and serve the `file` it names (respecting `contentType`). Fall back to the current `${scientificName}.jpg` lookup, then the SVG placeholder.

**Screenshots.** Replace the scene list with: `loud-afternoon` (loud, 2026-10-17T15:48:00, wait 12 s), `loud-dusk` (loud, 2026-10-17T18:20:00), `morning` (quiet, as now), `night` (night, as now), `new-to-garden`, `unreachable`, `winter-noon`, `home-loud` (loud, `&mode=home`), `night-home`. Keep the file names `outputs/frame-<name>.png`.

**Steps**: write the fixtures, `node -e` a JSON parse check, run `MOCK_SCENE=loud node scripts/mock-bridge.mjs` and curl `/api/birdframe` and a portrait JSON to confirm shape, run `npm run lint`. Commit: "Add a loud afternoon to the mock bridge and real portraits to the screenshots".

---

### Task 4: `Poster.tsx` and the idle frame (design-heavy; the main session does this)

**Files:**
- Create: `components/frame/Poster.tsx`, `components/frame/blocks.tsx` (BirdBlock, MoreBlock, GroundBlock, ClockBlock, WeatherBlock, ForecastBlock, AgendaBlock, ListBlock, StatusBlock), `components/frame/poster.css`
- Modify: `components/frame/Frame.tsx` (replace RollCall/Agenda/WeatherStrip/Gallery/plate with `<Poster>`), `components/frame/frame.css` (remove roll/gallery/plate/agenda/weather rules)
- Delete: `components/frame/Board.tsx` (keep `WeatherGlyph` by moving it to `blocks.tsx`), `components/frame/Gallery.tsx`, `lib/frame/birds.ts#showPaintingPlate` and its test

Grid: `grid-template-columns: repeat(6, 1fr); grid-template-rows: repeat(10, 1fr); gap: var(--poster-gap, 16px); padding: 48px`. House rows fixed as in the design; bird blocks at `grid-area: (row+3) / (col+1) / span rows / span cols`.

Block CSS variables per bird block: `--tint`, `--type`, `--sat` (filter: saturate), `--dim`, `--ink`. Cooling is a 60 s `transition` on `filter` and `background-color`. Arrival: `data-arrived` set for 1.2 s → ring `::after` scale/opacity keyframe, once. FLIP: a `useLayoutEffect` that records each block's `getBoundingClientRect` by key before commit, then plays a `transform` from old to new over 900 ms with `cubic-bezier(.2,.7,.2,1)`; only for blocks whose area changed. Breathing: `--poster-gap` from the activity buckets (12 px busy → 20 px quiet) with a 20 s transition; the grain layer's animation duration from the same tempo.

Photo crop: `background-image` + `background-position: calc(var(--fx) * 100%) calc(var(--fy) * 100%)` from `focal`, `background-size: cover`.

Touch: bird → `hear`; clock/weather/forecast → `onOpenHousehold()`; agenda/list → `onOpenHousehold("agenda" | "shopping")`; `more` → `onOpenJournal`. Margins and gutters wake Voice as now. Frame props gain `onOpenHousehold`.

Honesty line sits in the status block: window label + voices line.

Steps: build, run `npm run frame:shots loud-afternoon night morning`, iterate on type sizes and crops against the design, commit "Hang the poster on the idle frame".

---

### Task 5: Voice and Household pages on the grid (main session)

Voice page: a `poster` grid again with a 6 × 3 voice block (orb and prompt), the day's birds as `BirdBlock`s sized from `composeField` over today's cast (reuse with `window` forced to today by passing a snapshot whose hour is empty, or add `composeTodayField`), then shopping (3 × 2) and Look (3 × 1). Household page: agenda 4 × 3, rooms 2 × 3, shopping 3 × 2, painting of the day 3 × 2 (night only, else garden-right-now BirdBlock). Remove `TodayBirds.tsx`, the bird-card and household-panel CSS. Tab bar unchanged. Commit "Carry the poster onto the touched pages".

---

### Task 6: Screenshots and review (main session)

`npm run appliance:build && npm run frame:shots`; look at every PNG at 1200 × 1920 and against the design; fix; `npm test` green. Commit.

---

### Task 7: Deploy and measure (main session)

`ssh-add --apple-load-keychain; ./scripts/deploy-pi.sh`. After five minutes idle: `top -b -n 2 -d 3 | grep chromium` on the Pi; compare with 0.3% per process measured on 17 Oct before this work. Check `journalctl --user-unit touchscreen-bridge.service` for Pillow errors. Photograph-level check via `scripts/capture-pi-launcher.mjs`.
