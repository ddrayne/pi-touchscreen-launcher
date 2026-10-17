/**
 * The poster field: the birds of the hour laid out as blocks on a 6 × 6 grid,
 * each block sized by how often and how recently its species has called, and
 * dealt in the order they were heard, so the poster reads newest to oldest
 * like a page. A pure function of the snapshot, the clock and the previous
 * field: the same garden gives the same poster, and the field is dealt again
 * only when something was heard; between events nothing moves.
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

/** What the previous field tells the next one: each block's area, in deal order. */
type History = {
  areas: Map<string, PosterArea>;
  /** Bird keys in the order they were dealt. */
  dealt: string[];
  more: string[];
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

/** The next larger area within `free` spare cells, if any. */
function growthFor(block: Sized, free: number): number | null {
  for (const area of SHAPE_AREAS) {
    if (area <= block.cells) continue;
    if (area - block.cells > free) break;
    return area;
  }
  return null;
}

/** While cells are spare, the heaviest block takes the next size up, hero first. */
function grow(allocation: Allocation): Allocation {
  const ranked = [...allocation.sized].sort(byRank);
  for (;;) {
    const free = FIELD_CELLS - cellsUsed(allocation);
    if (free <= 0) break;
    let grown = false;
    for (const block of ranked) {
      const cells = growthFor(block, free);
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
  return grow(squeeze({ sized, more: [...moreSeed] }));
}

/**
 * The cells each species gets. The fresh allocation is the target; a species
 * already on the poster keeps its size while the target is within one shape
 * of it, so rounding and slow cooling never jiggle a block. The field is then
 * squeezed back to size, and spare cells go to the heaviest blocks.
 */
function allocateCells(
  candidates: Candidate[],
  previousCells: Map<string, number>,
  /** Names already bound for the more block, so a cell is kept for it. */
  moreSeed: string[] = [],
): Allocation {
  const fresh = freshAllocation(candidates, moreSeed);
  const sized = fresh.sized.map((block) => {
    const kept = previousCells.get(nameOf(block));
    if (kept === undefined || Math.abs(shapeIndex(kept) - shapeIndex(block.cells)) > 1) return block;
    return { ...block, cells: block.hero ? Math.max(HERO_MIN_CELLS, kept) : kept };
  });
  return grow(squeeze({ sized, more: fresh.more }));
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

/** Whether a block leans tall or wide, by its name, so it keeps its lean from deal to deal. */
function tallFirstFor(name: string): boolean {
  return hashString(name) % 2 === 1;
}

/** A cell's place in reading order: left to right, then down. */
function readingIndex(col: number, row: number): number {
  return row * FIELD_COLS + col;
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

  /** The first origin at or after `from` in reading order where the shape fits. */
  scan(shape: Shape, from = 0): PosterArea | null {
    for (let index = from; index < FIELD_CELLS; index += 1) {
      const area = { col: index % FIELD_COLS, row: Math.floor(index / FIELD_COLS), ...shape };
      if (this.fits(area)) return area;
    }
    return null;
  }
}

function inside(area: PosterArea): boolean {
  return area.col >= 0 && area.row >= 0 && area.col + area.cols <= FIELD_COLS && area.row + area.rows <= FIELD_ROWS;
}

type CellFree = (col: number, row: number) => boolean;

function contains(area: PosterArea, col: number, row: number): boolean {
  return col >= area.col && col < area.col + area.cols && row >= area.row && row < area.row + area.rows;
}

function everyCell(area: PosterArea, test: CellFree): boolean {
  for (let y = area.row; y < area.row + area.rows; y += 1) {
    for (let x = area.col; x < area.col + area.cols; x += 1) if (!test(x, y)) return false;
  }
  return true;
}

/**
 * The block spread to `cells` from its own origin, keeping every cell it had
 * and taking only free ones beyond; null when neither orientation can. The
 * origin never moves, so the reading order the deal made is kept.
 */
function spreadFrom(previous: PosterArea, cells: number, tallFirst: boolean, free: CellFree): PosterArea | null {
  for (const shape of orientationsOf(cells, tallFirst)) {
    const area = { col: previous.col, row: previous.row, ...shape };
    if (area.cols < previous.cols || area.rows < previous.rows || !inside(area)) continue;
    if (everyCell(area, (col, row) => contains(previous, col, row) || free(col, row))) return area;
  }
  return null;
}

/** Rule 6: the hero, then the rest newest first; among birds heard together, the heavier first. */
function byTime(left: Candidate, right: Candidate): number {
  if (left.hero !== right.hero) return left.hero ? -1 : 1;
  const leftHeard = left.species.lastHeard ?? -Infinity;
  const rightHeard = right.species.lastHeard ?? -Infinity;
  if (leftHeard !== rightHeard) return rightHeard - leftHeard;
  return right.weight - left.weight || nameOf(left).localeCompare(nameOf(right));
}

type Placement = { grid: Grid; placed: Map<string, PosterArea>; overflow: string[]; moreArea: PosterArea | null };

/**
 * Rule 7: the deal. Blocks go down in time order, each at the first place
 * after the last one's origin where its shape fits, stepping the shape down
 * before giving up, so reading the field left to right and down is reading
 * the hour newest to oldest, and the more block, when there is one, reads
 * last. The cursor never goes back; the gaps it leaves are absorbed by their
 * neighbours afterwards.
 */
function place(order: Sized[], withMore: boolean): Placement {
  const grid = new Grid();
  const placed = new Map<string, PosterArea>();
  const overflow: string[] = [];
  let cursor = 0;
  for (const block of order) {
    const name = nameOf(block);
    let area: PosterArea | null = null;
    for (const shapes of shapesFor(block.cells, tallFirstFor(name))) {
      for (const shape of shapes) {
        area = grid.scan(shape, cursor);
        if (area) break;
      }
      if (area) break;
    }
    if (!area) {
      overflow.push(name);
      continue;
    }
    grid.take(area);
    placed.set(name, area);
    cursor = readingIndex(area.col, area.row);
  }
  const moreArea = withMore || overflow.length ? grid.scan({ cols: 1, rows: 1 }, cursor) : null;
  if (moreArea) grid.take(moreArea);
  return { grid, placed, overflow, moreArea };
}

/** The largest block that can give way steps down a shape; the lightest among equals. */
function shrinkOne(sized: Sized[]): boolean {
  const shrinkable = sized.filter((block) => !block.hero && block.cells > 1);
  if (!shrinkable.length) return false;
  const target = shrinkable.reduce((best, block) =>
    block.cells > best.cells || (block.cells === best.cells && block.weight < best.weight) ? block : best,
  );
  target.cells = stepDown(target.cells);
  return true;
}

type Deal = { grid: Grid; placed: Map<string, PosterArea>; names: string[]; moreArea: PosterArea | null };

/**
 * The deal, made to fit: the cursor leaves gaps, so a deal that drops a bird
 * or has no cell left for the more block is tried again with the largest
 * block a shape smaller, until everyone is down or nothing can give way.
 * Then the gaps are absorbed.
 */
function deal(order: Sized[], more: string[]): Deal {
  const sized = order.map((block) => ({ ...block }));
  for (;;) {
    const { grid, placed, overflow, moreArea } = place(sized, more.length > 0);
    const names = [...more, ...overflow];
    const fits = !overflow.length && (!names.length || moreArea !== null);
    if (fits || !shrinkOne(sized)) {
      absorbGround(grid, sized, placed);
      return { grid, placed, names, moreArea };
    }
  }
}

/**
 * Rule 8: spare cells go to the heaviest block that can spread into them
 * where it stands, hero first, until none can, all within the one deal.
 */
function absorbGround(grid: Grid, order: Sized[], placed: Map<string, PosterArea>): void {
  const ranked = [...order].sort(byRank);
  const free: CellFree = (col, row) => grid.free(col, row);
  for (;;) {
    let grown = false;
    for (const block of ranked) {
      const name = nameOf(block);
      const area = placed.get(name);
      if (!area) continue;
      for (const cells of SHAPE_AREAS) {
        if (cells <= area.cols * area.rows) continue;
        const spread = spreadFrom(area, cells, tallFirstFor(name), free);
        if (!spread) continue;
        grid.take(spread);
        placed.set(name, spread);
        grown = true;
        break;
      }
      if (grown) break;
    }
    if (!grown) break;
  }
}

/** Rule 9: what is still free becomes ground, merged along each row up to the side limit. */
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
  const history: History = { areas: new Map(), dealt: [], more: [] };
  for (const block of previous?.blocks ?? []) {
    if (block.kind === "ground") continue;
    history.areas.set(block.key, block.area);
    if (block.kind === "bird") history.dealt.push(block.key);
    else history.more = block.names;
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

function sameList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

/**
 * Whether the previous deal still stands: the same birds in the same order,
 * the same names in the more block. Then nothing was heard, nothing moves
 * and nothing changes size; only the ages and the ink go on.
 */
function sameDeal(order: Sized[], more: string[], history: History): boolean {
  return sameList(order.map(nameOf), history.dealt) && sameList(more, history.more) && order.every((block) => history.areas.has(nameOf(block)));
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
  for (const [key, area] of history.areas) if (key !== "more") previousCells.set(key, area.cols * area.rows);
  const { kept, dropped } = capCandidates(candidates, options.maxBirds, history);
  const { sized, more } = allocateCells(kept, previousCells, dropped);
  const order = [...sized].sort(byTime);

  // Between events the previous field stands as it is; the field is dealt
  // afresh the moment a bird is heard, a bird leaves the window, or the
  // window itself changes.
  let placed: Map<string, PosterArea>;
  let names: string[];
  let moreArea: PosterArea | null;
  let grid: Grid;
  if (previous && window === previous.window && sameDeal(order, more, history)) {
    placed = new Map(order.map((block) => [nameOf(block), history.areas.get(nameOf(block))!]));
    names = more;
    moreArea = history.areas.get("more") ?? null;
    grid = new Grid();
    for (const area of placed.values()) grid.take(area);
    if (moreArea) grid.take(moreArea);
  } else {
    ({ grid, placed, names, moreArea } = deal(order, more));
  }

  const blocks: PosterBlock[] = [];
  for (const block of order) {
    const area = placed.get(nameOf(block));
    if (!area) continue;
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
  if (moreArea) blocks.push({ kind: "more", key: "more", names, area: moreArea });
  blocks.push(...fillGround(grid));
  return { window, blocks };
}

/**
 * How many voices the field speaks for: its bird blocks plus the names folded
 * into the more block, so a capped field still owns up to the whole hour.
 */
export function fieldVoices(field: PosterField): number {
  return field.blocks.reduce((sum, block) => {
    if (block.kind === "bird") return sum + 1;
    if (block.kind === "more") return sum + block.names.length;
    return sum;
  }, 0);
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
