/**
 * Today's birds for the home screen, and when the day's painting hangs as a
 * plate on the board. Pure, so the board and the home grid agree.
 */

import { castFor, inkFor, type FrameSnapshot, type FrameSpecies } from "./scene.ts";

export type BirdTile = {
  species: FrameSpecies;
  /** Heard within the snapshot's window. */
  recent: boolean;
  /** The roll call's fade: 1 at the last call, never below 0.3. */
  recency: number;
};

const EARLIER_RECENCY = 0.5;

/**
 * The last hour first, newest first, then the rest of today in BirdFrame's
 * order. A species appears once; the hour's entry wins.
 */
export function todayTiles(
  snapshot: FrameSnapshot | null,
  now: number,
  limit = 12,
): { tiles: BirdTile[]; more: number } {
  if (!snapshot) return { tiles: [], more: 0 };
  const recent = snapshot.species
    .filter((species) => species.lastHeard !== undefined)
    .map((species) => ({ species, ink: inkFor(species.lastHeard as number, now, snapshot.windowMinutes) }))
    .filter(({ ink }) => ink > 0)
    .sort((left, right) => (right.species.lastHeard as number) - (left.species.lastHeard as number))
    .map(({ species, ink }): BirdTile => ({ species, recent: true, recency: Math.max(0.3, ink) }));
  const seen = new Set(recent.map((tile) => tile.species.commonName));
  const earlier = castFor(snapshot)
    .filter((species) => !seen.has(species.commonName))
    .map((species): BirdTile => ({ species, recent: false, recency: EARLIER_RECENCY }));
  const all = [...recent, ...earlier];
  return { tiles: all.slice(0, limit), more: Math.max(0, all.length - limit) };
}

