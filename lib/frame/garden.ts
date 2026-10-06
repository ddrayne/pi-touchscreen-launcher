/**
 * The garden line: where birds may settle. Coordinates are in the garden
 * drawing's own space (GARDEN_WIDTH x GARDEN_HEIGHT), which the painting
 * pins to the bottom of the frame.
 *
 * Drawn from the owner's photographs of the real view: the lawn, the clipped
 * hedge with its rounded end, the wooden fence, the rotary dryer, the bird
 * bath, two big trees, and the four-storey tenement with its ranks of chimney
 * pots beyond. The anchor table and the drawing in components/frame/Garden.tsx
 * must agree.
 */

import type { AnchorKind } from "./archetypes.ts";

export const FRAME_WIDTH = 1200;
export const FRAME_HEIGHT = 1920;
export const GARDEN_WIDTH = 1200;
export const GARDEN_HEIGHT = 900;
/** Garden y = 0 sits here in frame coordinates. */
export const GARDEN_TOP = FRAME_HEIGHT - GARDEN_HEIGHT;

export type Anchor = {
  id: string;
  x: number;
  y: number;
  kind: AnchorKind;
  /** Which way a perched bird faces by default; 1 right, -1 left. */
  facing: 1 | -1;
  /** Apparent size: the tenement is far, the lawn edge is near. */
  scale: number;
};

export const ANCHORS: Anchor[] = [
  // The tenement beyond the trees.
  { id: "chimney-west", x: 110, y: 42, kind: "chimney", facing: 1, scale: 0.55 },
  { id: "chimney-east", x: 490, y: 42, kind: "chimney", facing: -1, scale: 0.55 },
  { id: "ridge-1", x: 200, y: 110, kind: "ridge", facing: 1, scale: 0.55 },
  { id: "ridge-2", x: 400, y: 110, kind: "ridge", facing: -1, scale: 0.55 },
  { id: "ridge-3", x: 600, y: 110, kind: "ridge", facing: 1, scale: 0.55 },
  // The big tree on the right and the smaller one on the left.
  { id: "treetop", x: 1000, y: 36, kind: "treetop", facing: -1, scale: 0.85 },
  { id: "treetop-west", x: 150, y: 96, kind: "treetop", facing: 1, scale: 0.8 },
  { id: "canopy-1", x: 878, y: 150, kind: "canopy", facing: 1, scale: 0.85 },
  { id: "canopy-2", x: 1112, y: 182, kind: "canopy", facing: -1, scale: 0.85 },
  { id: "canopy-3", x: 928, y: 298, kind: "canopy", facing: 1, scale: 0.9 },
  { id: "canopy-4", x: 1092, y: 326, kind: "canopy", facing: -1, scale: 0.9 },
  { id: "canopy-5", x: 836, y: 288, kind: "canopy", facing: -1, scale: 0.9 },
  { id: "canopy-west-1", x: 90, y: 262, kind: "canopy", facing: 1, scale: 0.85 },
  { id: "canopy-west-2", x: 232, y: 250, kind: "canopy", facing: -1, scale: 0.85 },
  { id: "trunk", x: 1004, y: 520, kind: "trunk", facing: 1, scale: 1 },
  // The rotary dryer on the lawn.
  { id: "dryer-west", x: 548, y: 362, kind: "wire", facing: 1, scale: 1 },
  { id: "dryer-top", x: 600, y: 336, kind: "wire", facing: -1, scale: 1 },
  { id: "dryer-east", x: 652, y: 362, kind: "wire", facing: -1, scale: 1 },
  // The clipped hedge and the fence.
  { id: "hedge-1", x: 120, y: 522, kind: "hedge", facing: 1, scale: 1.05 },
  { id: "hedge-2", x: 330, y: 526, kind: "hedge", facing: -1, scale: 1.05 },
  { id: "hedge-3", x: 540, y: 524, kind: "hedge", facing: 1, scale: 1.05 },
  { id: "hedge-4", x: 724, y: 528, kind: "hedge", facing: -1, scale: 1.05 },
  { id: "fence-1", x: 870, y: 536, kind: "fence", facing: -1, scale: 1.05 },
  { id: "fence-2", x: 1130, y: 536, kind: "fence", facing: -1, scale: 1.05 },
  // The lawn, nearest of all; the middle is kept clear for the gallery.
  { id: "bird-bath", x: 140, y: 644, kind: "lawn", facing: 1, scale: 1.1 },
  { id: "lawn-1", x: 56, y: 712, kind: "lawn", facing: 1, scale: 1.2 },
  { id: "lawn-2", x: 1062, y: 700, kind: "lawn", facing: -1, scale: 1.2 },
  { id: "lawn-3", x: 1130, y: 752, kind: "lawn", facing: -1, scale: 1.25 },
];

export function anchorsOfKind(kinds: AnchorKind[]): Anchor[] {
  return ANCHORS.filter((anchor) => kinds.includes(anchor.kind));
}

/** Leaf density through the year for an Edinburgh deciduous canopy, 0 bare .. 1 full. */
export function leafDensity(at: number): number {
  const date = new Date(at);
  const start = new Date(date.getFullYear(), 0, 1).getTime();
  const day = Math.floor((at - start) / 86_400_000);
  if (day < 80) return 0.04;
  if (day < 135) return 0.04 + ((day - 80) / 55) * 0.96;
  if (day < 275) return 1;
  if (day < 335) return 1 - ((day - 275) / 60) * 0.94;
  return 0.06;
}
