/**
 * The poster field: the birds of the hour laid out as blocks on a 6 × 6 grid,
 * each block sized by how often and how recently its species has called. A
 * pure function of the snapshot, the clock and the previous field, so the
 * same garden gives the same poster and a block only moves when it must.
 *
 * The component adds the house rows around this field; nothing here touches
 * the DOM.
 */

import { castFor, hashString, inkFor, type FrameSnapshot, type FrameSpecies } from "./scene.ts";

export const FIELD_COLS = 6;
export const FIELD_ROWS = 6;
export const MIN_HOUR_SPECIES = 4; // fewer than this → draw from today
export const HERO_MIN_CELLS = 9; // the latest bird is at least 3 × 3
export const MAX_SIDE = 4;
/** Areas a block may have; each maps to the rectangles below. */
export const SHAPE_AREAS = [1, 2, 3, 4, 6, 8, 9, 12, 16] as const;

const FIELD_CELLS = FIELD_COLS * FIELD_ROWS;
const MAX_CELLS = 16;
/** Ink for a species drawn from earlier today never drops below this. */
const TODAY_MIN_INK = 0.2;

/** The wide rectangle for each area; tall is its transpose. */
const WIDE_SHAPE: Record<number, [number, number]> = {
  1: [1, 1],
  2: [2, 1],
  3: [3, 1],
  4: [2, 2],
  6: [3, 2],
  8: [4, 2],
  9: [3, 3],
  12: [4, 3],
  16: [4, 4],
};

export type PosterArea = { col: number; row: number; cols: number; rows: number };
export type BirdBlock = {
  kind: "bird";
  key: string; // common name
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

type Voice = { species: FrameSpecies; age: number; ink: number; newToGarden: boolean };
type Candidate = Voice & { weight: number; hero: boolean };
type Sized = Candidate & { cells: number };
type Shape = { cols: number; rows: number };

/** What the previous field tells the next one about a block. */
type History = {
  areas: Map<string, PosterArea>;
  order: Map<string, number>;
};

function nameOf(block: { species: FrameSpecies }): string {
  return block.species.commonName;
}

function startOfDay(at: number): number {
  const day = new Date(at);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
}

/** Rule 1: the hour's species, or the whole day's cast when the hour is thin. */
function candidatesFor(
  snapshot: FrameSnapshot,
  now: number,
  window: PosterField["window"] | undefined,
): { window: PosterField["window"]; voices: Voice[] } {
  const newToGarden = (species: FrameSpecies) => snapshot.newToday.includes(species.commonName);
  const hour = snapshot.species.flatMap((species) => {
    if (species.lastHeard === undefined) return [];
    const ink = inkFor(species.lastHeard, now, snapshot.windowMinutes);
    if (ink <= 0) return [];
    return [{ species, age: Math.max(0, now - species.lastHeard), ink, newToGarden: newToGarden(species) }];
  });
  if (window !== "today" && hour.length >= MIN_HOUR_SPECIES) return { window: "hour", voices: hour };
  const dayMs = Math.max(1, now - startOfDay(now));
  const today = castFor(snapshot).map((species) => {
    const age = species.lastHeard === undefined ? dayMs : Math.max(0, now - species.lastHeard);
    const ink = species.lastHeard === undefined ? TODAY_MIN_INK : Math.max(TODAY_MIN_INK, 1 - age / dayMs);
    return { species, age, ink, newToGarden: newToGarden(species) };
  });
  return { window: "today", voices: today };
}

/** Rule 2: the latest call's species when it is on the poster, else the most recent voice. */
function heroName(snapshot: FrameSnapshot, voices: Voice[]): string | null {
  const newest = snapshot.feed[0] ?? snapshot.latest;
  if (newest && voices.some(({ species }) => species.commonName === newest.commonName)) {
    return newest.commonName;
  }
  let hero: FrameSpecies | null = null;
  for (const { species } of voices) {
    if (!hero || (species.lastHeard ?? -Infinity) > (hero.lastHeard ?? -Infinity)) hero = species;
  }
  return hero?.commonName ?? null;
}

/** Rule 3: calls count logarithmically; recency scales the lot. */
function weightOf(count: number, ink: number): number {
  return (1 + Math.log2(Math.max(1, count))) * (0.35 + 0.65 * ink);
}

function snapDown(cells: number): number {
  let snapped: number = SHAPE_AREAS[0];
  for (const area of SHAPE_AREAS) if (area <= cells) snapped = area;
  return snapped;
}

function shapeIndex(cells: number): number {
  return SHAPE_AREAS.indexOf(snapDown(cells) as (typeof SHAPE_AREAS)[number]);
}

function stepDown(cells: number): number {
  return SHAPE_AREAS[Math.max(0, shapeIndex(cells) - 1)];
}

/** Heaviest first; the hero ahead of everyone. */
function byRank(left: Candidate, right: Candidate): number {
  if (left.hero !== right.hero) return left.hero ? -1 : 1;
  return right.weight - left.weight;
}

type Allocation = { sized: Sized[]; more: string[] };
type GrowsInPlace = (block: Sized, cells: number) => boolean;

function cellsUsed({ sized, more }: Allocation): number {
  return sized.reduce((sum, block) => sum + block.cells, 0) + (more.length ? 1 : 0);
}

/** While the field overflows, the largest non-hero block gives way; the lightest among equals. */
function squeeze(allocation: Allocation): Allocation {
  let { sized } = allocation;
  const more = [...allocation.more];
  while (cellsUsed({ sized, more }) > FIELD_CELLS) {
    const shrinkable = sized.filter((block) => !block.hero && block.cells > 1);
    if (shrinkable.length) {
      const target = shrinkable.reduce((best, block) =>
        block.cells > best.cells || (block.cells === best.cells && block.weight < best.weight) ? block : best,
      );
      target.cells = stepDown(target.cells);
      continue;
    }
    const others = sized.filter((block) => !block.hero);
    if (!others.length) break;
    const lightest = others.reduce((best, block) => (block.weight < best.weight ? block : best));
    sized = sized.filter((block) => block !== lightest);
    more.push(nameOf(lightest));
  }
  return { sized, more };
}

/** The next larger area a block can take within `free` cells where it stands, if any. */
function growthFor(block: Sized, free: number, growsInPlace: GrowsInPlace): number | null {
  for (const area of SHAPE_AREAS) {
    if (area <= block.cells) continue;
    if (area - block.cells > free) break;
    if (growsInPlace(block, area)) return area;
  }
  return null;
}

/** While cells are spare, the heaviest block that can grow where it stands takes them, hero first. */
function grow(allocation: Allocation, growsInPlace: GrowsInPlace): Allocation {
  const ranked = [...allocation.sized].sort(byRank);
  for (;;) {
    const free = FIELD_CELLS - cellsUsed(allocation);
    if (free <= 0) break;
    let grown = false;
    for (const block of ranked) {
      const cells = growthFor(block, free, growsInPlace);
      if (cells === null) continue;
      block.cells = cells;
      grown = true;
      break;
    }
    if (!grown) break;
  }
  return allocation;
}

/** Rule 4 verbatim: shares of the 36 cells, snapped to the shapes, squeezed or grown to fit. */
function freshAllocation(candidates: Candidate[], moreSeed: string[]): Allocation {
  const total = candidates.reduce((sum, candidate) => sum + candidate.weight, 0);
  const sized = candidates.map((candidate) => {
    let cells = Math.max(1, Math.round((FIELD_CELLS * candidate.weight) / total));
    if (candidate.hero) cells = Math.max(HERO_MIN_CELLS, cells);
    return { ...candidate, cells: snapDown(Math.min(MAX_CELLS, cells)) };
  });
  return grow(squeeze({ sized, more: [...moreSeed] }), () => true);
}

/**
 * The cells each species gets. The fresh allocation is the target; a species
 * already on the poster keeps its size while the target is within one shape
 * of it, so rounding and slow cooling never jiggle a block. The field is then
 * squeezed back to size, and spare cells go to blocks that can grow into them
 * where they stand.
 */
function allocateCells(
  candidates: Candidate[],
  previousCells: Map<string, number>,
  growsInPlace: GrowsInPlace,
  /** Names already bound for the more block, so a cell is kept for it. */
  moreSeed: string[] = [],
): Allocation {
  const fresh = freshAllocation(candidates, moreSeed);
  const sized = fresh.sized.map((block) => {
    const kept = previousCells.get(nameOf(block));
    if (kept === undefined || Math.abs(shapeIndex(kept) - shapeIndex(block.cells)) > 1) return block;
    return { ...block, cells: block.hero ? Math.max(HERO_MIN_CELLS, kept) : kept };
  });
  return grow(squeeze({ sized, more: fresh.more }), growsInPlace);
}

/** Rule 5: both orientations of an area, the preferred one first. */
function orientationsOf(area: number, tallFirst: boolean): Shape[] {
  const [cols, rows] = WIDE_SHAPE[area];
  if (cols === rows) return [{ cols, rows }];
  const wide = { cols, rows };
  const tall = { cols: rows, rows: cols };
  return tallFirst ? [tall, wide] : [wide, tall];
}

/** The shapes a block may take, its own area first, then every smaller one. */
function shapesFor(cells: number, tallFirst: boolean): Shape[][] {
  return [...SHAPE_AREAS]
    .reverse()
    .filter((area) => area <= cells)
    .map((area) => orientationsOf(area, tallFirst));
}

function tallFirstFor(name: string, previous: PosterArea | undefined): boolean {
  if (previous && previous.cols !== previous.rows) return previous.rows > previous.cols;
  return hashString(name) % 2 === 1;
}

class Grid {
  private readonly taken = new Uint8Array(FIELD_CELLS);

  free(col: number, row: number): boolean {
    return !this.taken[row * FIELD_COLS + col];
  }

  fits(area: PosterArea): boolean {
    if (area.col < 0 || area.row < 0) return false;
    if (area.col + area.cols > FIELD_COLS || area.row + area.rows > FIELD_ROWS) return false;
    for (let y = area.row; y < area.row + area.rows; y += 1) {
      for (let x = area.col; x < area.col + area.cols; x += 1) if (!this.free(x, y)) return false;
    }
    return true;
  }

  take(area: PosterArea): void {
    for (let y = area.row; y < area.row + area.rows; y += 1) {
      for (let x = area.col; x < area.col + area.cols; x += 1) this.taken[y * FIELD_COLS + x] = 1;
    }
  }

  /** The first origin where the shape fits, scanning rows from `startRow` and wrapping. */
  scan(shape: Shape, startRow: number): PosterArea | null {
    for (let step = 0; step < FIELD_ROWS; step += 1) {
      const row = (startRow + step) % FIELD_ROWS;
      for (let col = 0; col + shape.cols <= FIELD_COLS; col += 1) {
        const area = { col, row, ...shape };
        if (this.fits(area)) return area;
      }
    }
    return null;
  }
}

/** The previous origin, pulled inside the field when the new shape would overhang. */
function anchored(previous: PosterArea, shape: Shape): PosterArea {
  return {
    col: Math.min(previous.col, FIELD_COLS - shape.cols),
    row: Math.min(previous.row, FIELD_ROWS - shape.rows),
    ...shape,
  };
}

function within(outer: PosterArea, inner: PosterArea): boolean {
  return (
    inner.col >= outer.col &&
    inner.row >= outer.row &&
    inner.col + inner.cols <= outer.col + outer.cols &&
    inner.row + inner.rows <= outer.row + outer.rows
  );
}

/** A new hero with no history takes a top corner, chosen by its name. */
function heroCorner(name: string, shape: Shape): PosterArea {
  return { col: hashString(name) % 2 === 0 ? 0 : FIELD_COLS - shape.cols, row: 0, ...shape };
}

/**
 * Whether a block could take `cells` where it stands without covering another
 * surviving block's previous footprint: free cells, departed species and its
 * own old cells are fair game. Blocks with no history are placed into free
 * space anyway, so they always may.
 */
function inPlaceGrowth(voices: Voice[], history: History): (block: Sized, cells: number) => boolean {
  const occupied = new Grid();
  for (const voice of voices) {
    const previous = history.areas.get(nameOf(voice));
    if (previous) occupied.take(previous);
  }
  return (block, cells) => {
    const previous = history.areas.get(nameOf(block));
    if (!previous) return true;
    return orientationsOf(cells, tallFirstFor(nameOf(block), previous)).some((shape) => {
      const area = anchored(previous, shape);
      for (let y = area.row; y < area.row + area.rows; y += 1) {
        for (let x = area.col; x < area.col + area.cols; x += 1) {
          const own = x >= previous.col && x < previous.col + previous.cols && y >= previous.row && y < previous.row + previous.rows;
          if (!own && !occupied.free(x, y)) return false;
        }
      }
      return true;
    });
  };
}

/** The largest shape of at most `cells` that fits inside the old footprint, origin kept. */
function shrunkInto(previous: PosterArea, cells: number, tallFirst: boolean): PosterArea | null {
  for (const shapes of shapesFor(cells, tallFirst)) {
    for (const shape of shapes) {
      const area = { col: previous.col, row: previous.row, ...shape };
      if (within(previous, area)) return area;
    }
  }
  return null;
}

/**
 * Where a block goes when it cannot simply stay: at its anchor in either
 * orientation, else the first free origin scanning from its previous row,
 * stepping the shape down until something fits.
 */
function findRoom(grid: Grid, block: Sized, previous: PosterArea | undefined): PosterArea | null {
  const name = nameOf(block);
  for (const shapes of shapesFor(block.cells, tallFirstFor(name, previous))) {
    for (const shape of shapes) {
      const first = previous ? anchored(previous, shape) : block.hero ? heroCorner(name, shape) : null;
      if (first && grid.fits(first)) return first;
    }
    for (const shape of shapes) {
      const found = grid.scan(shape, previous?.row ?? 0);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Rule 6: hero, then the survivors in their previous order, then newcomers by
 * weight. First every block that can keep its origin is pinned there: a
 * grown block spreads from its anchor and may shove a neighbour, a shrunk one
 * shrinks into its own footprint. Only then does anything else look for room.
 */
function place(
  sized: Sized[],
  history: History,
): { placed: Map<string, PosterArea>; order: Sized[]; overflow: string[] } {
  const order = [...sized].sort((left, right) => {
    if (left.hero !== right.hero) return left.hero ? -1 : 1;
    const leftIndex = history.order.get(nameOf(left));
    const rightIndex = history.order.get(nameOf(right));
    if (leftIndex !== undefined && rightIndex !== undefined) return leftIndex - rightIndex;
    if (leftIndex !== undefined || rightIndex !== undefined) return leftIndex !== undefined ? -1 : 1;
    return right.weight - left.weight;
  });
  const grid = new Grid();
  const placed = new Map<string, PosterArea>();
  const overflow: string[] = [];
  const pin = (name: string, area: PosterArea) => {
    grid.take(area);
    placed.set(name, area);
  };

  for (const block of order) {
    const name = nameOf(block);
    const previous = history.areas.get(name);
    if (!previous) continue;
    const tallFirst = tallFirstFor(name, previous);
    if (block.cells > previous.cols * previous.rows) {
      const area = orientationsOf(block.cells, tallFirst)
        .map((shape) => anchored(previous, shape))
        .find((candidate) => grid.fits(candidate));
      if (area) pin(name, area);
      continue;
    }
    const area = shrunkInto(previous, block.cells, tallFirst);
    if (area && grid.fits(area)) pin(name, area);
  }

  for (const block of order) {
    const name = nameOf(block);
    if (placed.has(name)) continue;
    const area = findRoom(grid, block, history.areas.get(name));
    if (area) pin(name, area);
    else overflow.push(name);
  }
  return { placed, order, overflow };
}

/** Rule 7: free cells become ground, merged along each row up to the side limit. */
function fillGround(grid: Grid): GroundBlock[] {
  const ground: GroundBlock[] = [];
  for (let row = 0; row < FIELD_ROWS; row += 1) {
    let col = 0;
    while (col < FIELD_COLS) {
      if (!grid.free(col, row)) {
        col += 1;
        continue;
      }
      let cols = 0;
      while (col + cols < FIELD_COLS && cols < MAX_SIDE && grid.free(col + cols, row)) cols += 1;
      const area = { col, row, cols, rows: 1 };
      grid.take(area);
      ground.push({ kind: "ground", key: `ground-${col}-${row}`, area });
      col += cols;
    }
  }
  return ground;
}

function historyOf(previous: PosterField | null): History {
  const history: History = { areas: new Map(), order: new Map() };
  for (const block of previous?.blocks ?? []) {
    if (block.kind === "ground") continue;
    history.areas.set(block.key, block.area);
    history.order.set(block.key, history.order.size);
  }
  return history;
}

export type ComposeOptions = {
  /** "today" draws from the whole day's cast regardless of the hour; the home pages want this. */
  window?: PosterField["window"];
  /**
   * At most this many bird blocks; the rest go to the more block. A long
   * day's cast then comes as a few blocks big enough for photographs rather
   * than a sea of swatches. Blocks already on the field are kept in
   * preference, so the boundary does not flicker.
   */
  maxBirds?: number;
};

const KEEP_BONUS = 1.15;

function capCandidates(candidates: Candidate[], maxBirds: number | undefined, history: History): { kept: Candidate[]; dropped: string[] } {
  if (!maxBirds || candidates.length <= maxBirds) return { kept: candidates, dropped: [] };
  const rank = (candidate: Candidate) =>
    (candidate.hero ? Number.MAX_SAFE_INTEGER : 0) + candidate.weight * (history.areas.has(nameOf(candidate)) ? KEEP_BONUS : 1);
  const ranked = [...candidates].sort((left, right) => rank(right) - rank(left) || left.age - right.age);
  const keep = new Set(ranked.slice(0, maxBirds).map(nameOf));
  return {
    kept: candidates.filter((candidate) => keep.has(nameOf(candidate))),
    dropped: ranked.slice(maxBirds).map(nameOf),
  };
}

export function composeField(
  snapshot: FrameSnapshot | null,
  now: number,
  previous: PosterField | null,
  options: ComposeOptions = {},
): PosterField {
  if (!snapshot) return { window: options.window ?? "hour", blocks: [] };
  const { window, voices } = candidatesFor(snapshot, now, options.window);
  const hero = heroName(snapshot, voices);
  const candidates: Candidate[] = voices.map((voice) => ({
    ...voice,
    weight: weightOf(voice.species.count, voice.ink),
    hero: voice.species.commonName === hero,
  }));
  const history = historyOf(previous);
  const previousCells = new Map<string, number>();
  for (const block of previous?.blocks ?? []) {
    if (block.kind === "bird") previousCells.set(block.key, block.area.cols * block.area.rows);
  }
  const { kept, dropped } = capCandidates(candidates, options.maxBirds, history);
  const { sized, more } = allocateCells(kept, previousCells, inPlaceGrowth(voices, history), dropped);
  const { placed, order, overflow } = place(sized, history);

  const grid = new Grid();
  const blocks: PosterBlock[] = [];
  for (const block of order) {
    const area = placed.get(nameOf(block));
    if (!area) continue;
    grid.take(area);
    blocks.push({
      kind: "bird",
      key: nameOf(block),
      species: block.species,
      area,
      age: block.age,
      ink: block.ink,
      hero: block.hero,
      newToGarden: block.newToGarden,
    });
  }

  const names = [...more, ...overflow];
  if (names.length) {
    const cell = { cols: 1, rows: 1 };
    const previousMore = history.areas.get("more");
    const first = previousMore ? anchored(previousMore, cell) : null;
    const area = first && grid.fits(first) ? first : grid.scan(cell, 0);
    if (area) {
      grid.take(area);
      blocks.push({ kind: "more", key: "more", names, area });
    }
  }
  blocks.push(...fillGround(grid));
  return { window, blocks };
}

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** Letter per bird block in field order; `+` is the more block, `.` is ground. */
export function blockGlyph(field: PosterField, block: PosterBlock): string {
  if (block.kind === "ground") return ".";
  if (block.kind === "more") return "+";
  const index = field.blocks.filter((entry) => entry.kind === "bird").indexOf(block);
  return LETTERS[index % LETTERS.length];
}

/** ASCII, one char per cell, for tests and the script. */
export function describeField(field: PosterField): string {
  const rows = Array.from({ length: FIELD_ROWS }, () => Array<string>(FIELD_COLS).fill("?"));
  for (const block of field.blocks) {
    const glyph = blockGlyph(field, block);
    const { col, row, cols, rows: height } = block.area;
    for (let y = row; y < row + height; y += 1) {
      for (let x = col; x < col + cols; x += 1) rows[y][x] = glyph;
    }
  }
  return rows.map((row) => row.join("")).join("\n");
}
