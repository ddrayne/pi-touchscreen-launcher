/**
 * Parametric ink silhouettes. Every bird is a union of a few shapes (body,
 * head, beak, tail, wings, legs) in a 100 x 100 box facing right, so the
 * whole aviary stays in one hand and a new archetype is a line of numbers.
 *
 * Perching birds are drawn side-on. Birds that cross the sky are drawn from
 * below, as they are seen from a garden.
 */

import type { SilhouetteId } from "../../lib/frame/archetypes.ts";

export type Pose = "perched" | "up" | "mid" | "down" | "glide";

export type Shape =
  | { kind: "ellipse"; cx: number; cy: number; rx: number; ry: number; rotate: number }
  | { kind: "circle"; cx: number; cy: number; r: number }
  | { kind: "path"; d: string }
  | { kind: "line"; x1: number; y1: number; x2: number; y2: number; width: number };

type SideParams = {
  /** Body length and depth. */
  length: number;
  depth: number;
  /** Perched posture, degrees above horizontal. */
  posture: number;
  head: number;
  beak: number;
  /** Beak depth at the base. */
  beakDepth: number;
  tail: number;
  tailWidth: number;
  /** Tail droop below the body line when perched, degrees. */
  tailDroop: number;
  fork?: number;
  wing: number;
  wingChord: number;
  legs: number;
  neck?: number;
  crest?: boolean;
  cockedTail?: boolean;
  clings?: boolean;
  roundHead?: boolean;
};

type OverheadParams = {
  length: number;
  depth: number;
  head: number;
  beak: number;
  neck: number;
  span: number;
  chord: number;
  /** Backward sweep of the wing tip as a fraction of the span. */
  sweep: number;
  /** Bulge of the trailing edge: 0 straight, 1 very rounded. */
  round: number;
  fingers?: number;
  tail: number;
  tailWidth: number;
  fork?: number;
  legsTrail?: number;
};

const SIDE: Partial<Record<SilhouetteId, SideParams>> = {
  thrush: { length: 46, depth: 24, posture: 32, head: 9.5, beak: 9, beakDepth: 3.2, tail: 22, tailWidth: 9, tailDroop: 14, wing: 40, wingChord: 16, legs: 12 },
  tit: { length: 30, depth: 20, posture: 28, head: 8.5, beak: 4, beakDepth: 2.4, tail: 15, tailWidth: 7, tailDroop: 10, wing: 28, wingChord: 13, legs: 8, roundHead: true },
  finch: { length: 34, depth: 20, posture: 30, head: 8.5, beak: 5.5, beakDepth: 3.4, tail: 17, tailWidth: 8, tailDroop: 8, fork: 4, wing: 30, wingChord: 13, legs: 9 },
  wren: { length: 26, depth: 18, posture: 24, head: 7.5, beak: 6, beakDepth: 2, tail: 12, tailWidth: 6, tailDroop: -70, wing: 22, wingChord: 11, legs: 9, cockedTail: true },
  robin: { length: 33, depth: 23, posture: 40, head: 9, beak: 5.5, beakDepth: 2.4, tail: 16, tailWidth: 7, tailDroop: 12, wing: 30, wingChord: 13, legs: 11, roundHead: true },
  sparrow: { length: 34, depth: 22, posture: 30, head: 9, beak: 5, beakDepth: 3.2, tail: 16, tailWidth: 8, tailDroop: 6, wing: 30, wingChord: 14, legs: 9 },
  passerine: { length: 36, depth: 21, posture: 30, head: 8.5, beak: 6, beakDepth: 2.6, tail: 18, tailWidth: 7, tailDroop: 10, wing: 32, wingChord: 14, legs: 10 },
  pigeon: { length: 52, depth: 28, posture: 18, head: 8, beak: 6, beakDepth: 2.6, tail: 22, tailWidth: 11, tailDroop: 4, wing: 46, wingChord: 18, legs: 8, neck: 6 },
  corvid: { length: 54, depth: 26, posture: 26, head: 10.5, beak: 13, beakDepth: 5, tail: 26, tailWidth: 10, tailDroop: 10, wing: 50, wingChord: 20, legs: 13 },
  woodpecker: { length: 40, depth: 20, posture: 72, head: 8.5, beak: 11, beakDepth: 3.2, tail: 20, tailWidth: 7, tailDroop: 0, wing: 34, wingChord: 15, legs: 6, clings: true },
  owl: { length: 42, depth: 30, posture: 80, head: 14, beak: 3, beakDepth: 2.5, tail: 9, tailWidth: 12, tailDroop: 0, wing: 40, wingChord: 22, legs: 4 },
  gull: { length: 50, depth: 24, posture: 10, head: 9, beak: 10, beakDepth: 3.4, tail: 18, tailWidth: 9, tailDroop: 2, wing: 60, wingChord: 16, legs: 10, neck: 4 },
};

const OVERHEAD: Partial<Record<SilhouetteId, OverheadParams>> = {
  gull: { length: 34, depth: 10, head: 5.5, beak: 7, neck: 4, span: 46, chord: 11, sweep: 0.42, round: 0.25, tail: 12, tailWidth: 10 },
  aerial: { length: 22, depth: 7, head: 4, beak: 2, neck: 1, span: 44, chord: 8, sweep: 0.78, round: 0.1, tail: 11, tailWidth: 8, fork: 6 },
  raptor: { length: 34, depth: 12, head: 5.5, beak: 4, neck: 2, span: 44, chord: 19, sweep: 0.14, round: 0.7, fingers: 5, tail: 16, tailWidth: 20 },
  heron: { length: 40, depth: 14, head: 6, beak: 14, neck: 2, span: 46, chord: 20, sweep: 0.12, round: 0.9, tail: 8, tailWidth: 12, legsTrail: 24 },
  duck: { length: 34, depth: 11, head: 5, beak: 7, neck: 14, span: 42, chord: 10, sweep: 0.3, round: 0.2, tail: 8, tailWidth: 8 },
  corvid: { length: 34, depth: 11, head: 6, beak: 8, neck: 3, span: 44, chord: 16, sweep: 0.2, round: 0.55, fingers: 4, tail: 16, tailWidth: 14 },
  pigeon: { length: 32, depth: 12, head: 5, beak: 4, neck: 4, span: 42, chord: 14, sweep: 0.36, round: 0.35, tail: 14, tailWidth: 14 },
};

const OVERHEAD_IDS: SilhouetteId[] = ["gull", "aerial", "raptor", "heron", "duck"];

export function isOverhead(id: SilhouetteId): boolean {
  return OVERHEAD_IDS.includes(id);
}

const RAD = Math.PI / 180;

function pt(x: number, y: number): string {
  return `${x.toFixed(1)} ${y.toFixed(1)}`;
}

function rotate(x: number, y: number, cx: number, cy: number, degrees: number): [number, number] {
  const c = Math.cos(degrees * RAD);
  const s = Math.sin(degrees * RAD);
  const dx = x - cx;
  const dy = y - cy;
  return [cx + dx * c - dy * s, cy + dx * s + dy * c];
}

/** A leaf-shaped wing from a root along an axis, bulging on one side. */
function wingPath(
  rootX: number,
  rootY: number,
  tipX: number,
  tipY: number,
  chord: number,
  round: number,
  fingers = 0,
): string {
  const dx = tipX - rootX;
  const dy = tipY - rootY;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len;
  const ny = dx / len;
  const lead1 = [rootX + dx * 0.35 + nx * chord * 0.2, rootY + dy * 0.35 + ny * chord * 0.2];
  const lead2 = [rootX + dx * 0.8 + nx * chord * 0.1, rootY + dy * 0.8 + ny * chord * 0.1];
  const trail1 = [
    rootX + dx * 0.62 - nx * chord * (0.5 + round * 0.5),
    rootY + dy * 0.62 - ny * chord * (0.5 + round * 0.5),
  ];
  const trail2 = [rootX + dx * 0.18 - nx * chord * (0.9 + round * 0.3), rootY + dy * 0.18 - ny * chord * (0.9 + round * 0.3)];
  let d = `M ${pt(rootX, rootY)} C ${pt(lead1[0], lead1[1])} ${pt(lead2[0], lead2[1])} ${pt(tipX, tipY)}`;
  if (fingers > 0) {
    // Primary feathers splayed at the tip, as on a buzzard or a crow.
    for (let index = 1; index <= fingers; index += 1) {
      const t = index / fingers;
      const fx = tipX - dx * 0.16 * t - nx * chord * 0.55 * t;
      const fy = tipY - dy * 0.16 * t - ny * chord * 0.55 * t;
      const notchX = fx + dx * 0.06 + nx * chord * 0.12;
      const notchY = fy + dy * 0.06 + ny * chord * 0.12;
      d += ` L ${pt(notchX, notchY)} L ${pt(fx, fy)}`;
    }
  }
  d += ` C ${pt(trail1[0], trail1[1])} ${pt(trail2[0], trail2[1])} ${pt(rootX - nx * chord * 0.2, rootY - ny * chord * 0.2)} Z`;
  return d;
}

function sideView(id: SilhouetteId, pose: Pose): Shape[] {
  const p = SIDE[id] ?? SIDE.passerine!;
  const shapes: Shape[] = [];
  const flying = pose !== "perched";
  const posture = flying ? 0 : p.posture;
  const cx = flying ? 48 : 46;
  const cy = flying ? 52 : 67;
  const rx = p.length / 2;
  const ry = p.depth / 2;

  // Body.
  shapes.push({ kind: "ellipse", cx, cy, rx, ry, rotate: -posture });

  // Head on the front of the body, lifted by the posture.
  const neck = p.neck ?? 0;
  const [hx, hy] = rotate(cx + rx * 0.78 + neck + p.head * 0.35, cy - ry * 0.55, cx, cy, -posture);
  shapes.push({ kind: "circle", cx: hx, cy: hy, r: p.head });
  if (p.roundHead) shapes.push({ kind: "circle", cx: hx - p.head * 0.25, cy: hy + p.head * 0.25, r: p.head * 0.95 });
  if (p.crest) {
    shapes.push({ kind: "path", d: `M ${pt(hx - 2, hy - p.head + 1)} L ${pt(hx - 6, hy - p.head - 7)} L ${pt(hx + 4, hy - p.head + 2)} Z` });
  }
  // Neck fill for long-necked birds.
  if (neck > 0) {
    shapes.push({ kind: "path", d: `M ${pt(cx + rx * 0.4, cy - ry * 0.9)} L ${pt(hx - p.head * 0.4, hy - p.head * 0.7)} L ${pt(hx, hy + p.head * 0.7)} L ${pt(cx + rx * 0.5, cy + ry * 0.4)} Z` });
  }

  // Beak, pointing forward from the head.
  const beakAngle = flying ? 0 : -posture * 0.25;
  const [b1x, b1y] = rotate(hx + p.head * 0.72, hy - p.beakDepth, hx, hy, beakAngle);
  const [b2x, b2y] = rotate(hx + p.head + p.beak, hy + 0.3, hx, hy, beakAngle);
  const [b3x, b3y] = rotate(hx + p.head * 0.72, hy + p.beakDepth, hx, hy, beakAngle);
  shapes.push({ kind: "path", d: `M ${pt(b1x, b1y)} L ${pt(b2x, b2y)} L ${pt(b3x, b3y)} Z` });

  // Tail from the rear of the body.
  const droop = flying ? 2 : p.tailDroop;
  const tailAngle = -posture + droop;
  const [rootX, rootY] = rotate(cx - rx * 0.72, cy, cx, cy, -posture);
  const tipX = rootX - Math.cos(tailAngle * RAD) * p.tail;
  const tipY = rootY - Math.sin(tailAngle * RAD) * p.tail;
  const tnx = -Math.sin(tailAngle * RAD);
  const tny = Math.cos(tailAngle * RAD);
  const half = p.tailWidth / 2;
  if (p.fork) {
    const notchX = tipX + Math.cos(tailAngle * RAD) * p.fork;
    const notchY = tipY + Math.sin(tailAngle * RAD) * p.fork;
    shapes.push({ kind: "path", d: `M ${pt(rootX + tnx * half * 0.5, rootY + tny * half * 0.5)} L ${pt(tipX + tnx * half, tipY + tny * half)} L ${pt(notchX, notchY)} L ${pt(tipX - tnx * half, tipY - tny * half)} L ${pt(rootX - tnx * half * 0.5, rootY - tny * half * 0.5)} Z` });
  } else {
    shapes.push({ kind: "path", d: `M ${pt(rootX + tnx * half * 0.45, rootY + tny * half * 0.45)} L ${pt(tipX + tnx * half, tipY + tny * half)} L ${pt(tipX - tnx * half, tipY - tny * half)} L ${pt(rootX - tnx * half * 0.45, rootY - tny * half * 0.45)} Z` });
  }

  if (flying) {
    // Wings up, level, or down; the far wing is drawn narrower and behind.
    const lift = pose === "up" ? -1 : pose === "down" ? 1 : pose === "glide" ? -0.25 : 0.1;
    const rootWx = cx + rx * 0.1;
    const rootWy = cy - ry * 0.4;
    const tipWx = rootWx + p.wing * (pose === "mid" ? 0.55 : 0.35 + Math.abs(lift) * 0.1);
    const tipWy = rootWy + lift * p.wing * 0.95;
    shapes.push({ kind: "path", d: wingPath(rootWx, rootWy, tipWx, tipWy, p.wingChord, 0.5) });
    const farTipY = rootWy + lift * p.wing * 0.6;
    shapes.push({ kind: "path", d: wingPath(rootWx - 4, rootWy + 2, tipWx - 10, farTipY, p.wingChord * 0.7, 0.4) });
  } else {
    // A folded wing lies along the back as a slightly longer, flatter ellipse.
    shapes.push({ kind: "ellipse", cx: cx - rx * 0.1, cy: cy - ry * 0.25, rx: rx * 0.72, ry: ry * 0.42, rotate: -posture - 6 });
    // Legs down to the perch at y = 92.
    const [lx, ly] = rotate(cx + rx * 0.12, cy + ry * 0.55, cx, cy, -posture);
    const footY = p.clings ? ly + p.legs : 92;
    const lean = p.clings ? -p.legs * 0.6 : 1.5;
    shapes.push({ kind: "line", x1: lx, y1: ly, x2: lx + lean, y2: footY, width: 2.1 });
    shapes.push({ kind: "line", x1: lx + 5, y1: ly - 1, x2: lx + 5 + lean, y2: footY, width: 2.1 });
  }
  return shapes;
}

function overheadView(id: SilhouetteId, pose: Pose): Shape[] {
  const p = OVERHEAD[id] ?? OVERHEAD.gull!;
  const shapes: Shape[] = [];
  const cx = 50;
  const cy = 50;
  const rx = p.length / 2;
  const ry = p.depth / 2;
  shapes.push({ kind: "ellipse", cx, cy, rx, ry, rotate: 0 });
  // Neck and head ahead of the body.
  const hx = cx + rx * 0.85 + p.neck + p.head * 0.6;
  if (p.neck > 3) {
    shapes.push({ kind: "path", d: `M ${pt(cx + rx * 0.6, cy - ry * 0.55)} L ${pt(hx, cy - p.head * 0.55)} L ${pt(hx, cy + p.head * 0.55)} L ${pt(cx + rx * 0.6, cy + ry * 0.55)} Z` });
  }
  shapes.push({ kind: "circle", cx: hx, cy, r: p.head });
  shapes.push({ kind: "path", d: `M ${pt(hx + p.head * 0.7, cy - p.head * 0.45)} L ${pt(hx + p.head + p.beak, cy)} L ${pt(hx + p.head * 0.7, cy + p.head * 0.45)} Z` });
  // Tail fan.
  const tailRoot = cx - rx * 0.75;
  const tailTip = cx - rx - p.tail;
  const half = p.tailWidth / 2;
  if (p.fork) {
    shapes.push({ kind: "path", d: `M ${pt(tailRoot, cy - half * 0.35)} L ${pt(tailTip, cy - half)} L ${pt(tailTip + p.fork, cy)} L ${pt(tailTip, cy + half)} L ${pt(tailRoot, cy + half * 0.35)} Z` });
  } else {
    shapes.push({ kind: "path", d: `M ${pt(tailRoot, cy - half * 0.3)} L ${pt(tailTip, cy - half)} Q ${pt(tailTip - 2, cy)} ${pt(tailTip, cy + half)} L ${pt(tailRoot, cy + half * 0.3)} Z` });
  }
  // Wings: spread for a glide, foreshortened for a flap.
  const spread = pose === "glide" || pose === "mid" ? 1 : pose === "up" ? 0.62 : 0.48;
  const rootX = cx + rx * 0.15;
  const tipX = rootX - p.span * p.sweep;
  const flapShift = pose === "up" ? -p.span * 0.12 : pose === "down" ? p.span * 0.12 : 0;
  for (const side of [-1, 1] as const) {
    const tipY = cy + side * p.span * spread + (side === 1 ? flapShift : -flapShift) * 0;
    shapes.push({ kind: "path", d: wingPath(rootX, cy + side * ry * 0.7, tipX, tipY, p.chord * (0.75 + spread * 0.25), p.round, p.fingers ?? 0) });
  }
  if (p.legsTrail) {
    shapes.push({ kind: "line", x1: tailRoot + 4, y1: cy - 2, x2: tailRoot - p.legsTrail, y2: cy - 3, width: 2 });
    shapes.push({ kind: "line", x1: tailRoot + 4, y1: cy + 2, x2: tailRoot - p.legsTrail, y2: cy + 3, width: 2 });
  }
  return shapes;
}

/**
 * Shapes for a silhouette in a pose. Perching birds are side-on; sky crossers
 * are seen from below whatever the pose.
 */
export function silhouetteShapes(id: SilhouetteId, pose: Pose): Shape[] {
  if (isOverhead(id)) return overheadView(id, pose);
  if (pose === "glide" && OVERHEAD[id]) return overheadView(id, "glide");
  return sideView(id, pose);
}

export function shapesToSvg(shapes: Shape[], fill = "currentColor"): string {
  return shapes
    .map((shape) => {
      switch (shape.kind) {
        case "ellipse":
          return `<ellipse cx="${shape.cx.toFixed(1)}" cy="${shape.cy.toFixed(1)}" rx="${shape.rx.toFixed(1)}" ry="${shape.ry.toFixed(1)}" transform="rotate(${shape.rotate.toFixed(1)} ${shape.cx.toFixed(1)} ${shape.cy.toFixed(1)})" fill="${fill}"/>`;
        case "circle":
          return `<circle cx="${shape.cx.toFixed(1)}" cy="${shape.cy.toFixed(1)}" r="${shape.r.toFixed(1)}" fill="${fill}"/>`;
        case "path":
          return `<path d="${shape.d}" fill="${fill}"/>`;
        case "line":
          return `<line x1="${shape.x1.toFixed(1)}" y1="${shape.y1.toFixed(1)}" x2="${shape.x2.toFixed(1)}" y2="${shape.y2.toFixed(1)}" stroke="${fill}" stroke-width="${shape.width}" stroke-linecap="round"/>`;
        default:
          return "";
      }
    })
    .join("");
}

export const SILHOUETTE_IDS: SilhouetteId[] = [
  "thrush",
  "tit",
  "finch",
  "wren",
  "robin",
  "sparrow",
  "passerine",
  "pigeon",
  "corvid",
  "woodpecker",
  "owl",
  "gull",
  "aerial",
  "raptor",
  "heron",
  "duck",
];
