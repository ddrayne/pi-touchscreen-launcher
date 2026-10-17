/**
 * The poster's colours: paper and type from the time of day, and how a bird
 * block cools as its last call ages. Pure functions of the sky palette and
 * the clock, shared by the frame, home and the poster blocks.
 */

import type { Tier } from "./scene.ts";
import { mixRgb, smoothstep, type Rgb, type SkyPalette } from "./solar.ts";

export const PAPER_DAY: Rgb = [242, 239, 229];
export const PAPER_NIGHT: Rgb = [26, 30, 50];
export const TYPE_DAY: Rgb = [22, 42, 36];
export const TYPE_NIGHT: Rgb = [236, 228, 206];
export const GOLD: Rgb = [201, 133, 54];

/** A block unheard for this long has cooled fully. */
export const COOL_MS = 40 * 60_000;
const COOLED_SATURATION = 0.15;
const COOLED_TINT_MIX = 0.85;

const BLACK: Rgb = [0, 0, 0];
const WHITE: Rgb = [255, 255, 255];
// The paper blushes with the sky at twilight: rose at dawn, amber at dusk.
const DAWN_BLUSH: Rgb = [222, 160, 172];
const DUSK_BLUSH: Rgb = [236, 164, 96];

/**
 * Type follows the paper, not the sun: dark ink while the washed sky is
 * light, cream once dusk has taken it. Home uses it too, over the same sky.
 */
export function typeInkFor(darkness: number): Rgb {
  return mixRgb(TYPE_DAY, TYPE_NIGHT, smoothstep(0.18, 0.3, darkness));
}

export type GroundPalette = {
  paper: Rgb;
  paperDeep: Rgb;
  type: Rgb;
  gold: Rgb;
  /** 0 by day, up to 0.4 at night: how much photos dim. */
  dim: number;
};

/** How far into the dusk-and-dawn band the sky is: 1 at its middle, 0 at its edges. */
function twilightOf(darkness: number): number {
  if (darkness <= 0.2 || darkness >= 0.8) return 0;
  return 1 - Math.abs(darkness - 0.5) / 0.3;
}

export function groundPalette(sky: SkyPalette, rising: boolean): GroundPalette {
  const { darkness } = sky;
  let paper = mixRgb(PAPER_DAY, PAPER_NIGHT, darkness);
  const twilight = twilightOf(darkness);
  if (twilight > 0) {
    const blush = mixRgb(sky.glow, rising ? DAWN_BLUSH : DUSK_BLUSH, 0.25);
    paper = mixRgb(paper, blush, 0.12 * twilight);
  }
  // A deeper shade of the paper: darker by day, lighter once the type has turned cream.
  const paperDeep = mixRgb(
    mixRgb(paper, BLACK, 0.06),
    mixRgb(paper, WHITE, 0.06),
    smoothstep(0.18, 0.3, darkness),
  );
  return {
    paper,
    paperDeep,
    type: typeInkFor(darkness),
    gold: GOLD,
    dim: 0.4 * smoothstep(0.6, 1, darkness),
  };
}

/** How a block cools with age: saturation 1 → 0.15 and tintMix 0 → 0.85 by `coolMs`, eased. */
export function cooling(ageMs: number, coolMs = COOL_MS): { saturation: number; tintMix: number } {
  const t = smoothstep(0, 1, Math.max(0, ageMs) / coolMs);
  return {
    saturation: 1 - (1 - COOLED_SATURATION) * t,
    tintMix: COOLED_TINT_MIX * t,
  };
}

/** The block's background: its own tint pulled toward the paper by tintMix; null tint → paperDeep. */
export function blockTint(tint: Rgb | null, ground: GroundPalette, tintMix: number): Rgb {
  if (!tint) return ground.paperDeep;
  return mixRgb(tint, ground.paper, tintMix);
}

/** Type weight by tier: confirmed 700, probable 500, tentative 300. */
export function tierWeight(tier: Tier | undefined): number {
  if (tier === "confirmed") return 700;
  if (tier === "tentative") return 300;
  return 500;
}

function linearChannel(value: number): number {
  const c = value / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance, 0 black .. 1 white. */
export function luminanceOf([r, g, b]: Rgb): number {
  return 0.2126 * linearChannel(r) + 0.7152 * linearChannel(g) + 0.0722 * linearChannel(b);
}

/** Readable type over a tint: cream over dark, ink over light. */
export function typeOver(tint: Rgb): Rgb {
  return luminanceOf(tint) < 0.45 ? TYPE_NIGHT : TYPE_DAY;
}
