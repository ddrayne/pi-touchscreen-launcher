/**
 * The birds' field: every block of a PosterField rendered on the grid,
 * coloured by its portrait and cooled by its age. Shared by the idle poster
 * and the home pages, which differ only in where the field starts and how
 * slowly it cools. Placement changes play one FLIP transform.
 */

import { useLayoutEffect, useMemo, useRef, type RefObject } from "react";
import { blockTint, COOL_MS, cooling, typeOver, type GroundPalette } from "../../lib/frame/palette.ts";
import type { Portrait } from "../../lib/frame/portraits.ts";
import type { PosterField } from "../../lib/frame/poster.ts";
import type { Rgb } from "../../lib/frame/solar.ts";
import { BirdBlock, GroundBlock, MoreBlock } from "./blocks.tsx";

const FRAME_WIDTH = 1200;
const FLIP_MS = 900;
const FLIP_EASE = "cubic-bezier(0.2, 0.7, 0.2, 1)";

export type BirdFieldProps = {
  field: PosterField;
  /** A minute tick: cooling only moves this often. */
  minuteTick: number;
  /** Keys of blocks that were not in the previous field. */
  bornKeys: ReadonlySet<string>;
  /** Species whose latest call should ring, by detection id. */
  arrivals: ReadonlyMap<string, number>;
  portraits: Map<string, Portrait | null>;
  ground: GroundPalette;
  /** The grid row the field starts under. */
  rowOffset: number;
  /** How long a block takes to cool to the paper. */
  coolMs?: number;
  playing: string | null;
  onHear: (commonName: string) => void;
  onMore: () => void;
};

export type BlockColours = { tint: Rgb; type: Rgb; saturation: number };

/** A bird block's colours: its tint pulled toward the paper as it cools, and type that reads over it. */
export function colourOf(ageMs: number, portrait: Portrait | null, ground: GroundPalette, coolMs = COOL_MS): BlockColours {
  const cool = cooling(ageMs, coolMs);
  const tint = blockTint(portrait?.tint ?? null, ground, cool.tintMix);
  return { tint, type: typeOver(tint), saturation: cool.saturation };
}

/**
 * Plays placement changes as transforms from the old box to the new one, so
 * a growing block shoves its neighbours rather than jumping.
 */
export function useFlip(container: RefObject<HTMLDivElement | null>, field: PosterField): void {
  const boxes = useRef(new Map<string, DOMRect>());
  useLayoutEffect(() => {
    const root = container.current;
    if (!root) return;
    const scale = root.getBoundingClientRect().width / FRAME_WIDTH || 1;
    // Every read first, then every write, so the layout is measured once.
    const next = new Map<string, DOMRect>();
    const moves: { element: HTMLElement; dx: number; dy: number; sx: number; sy: number }[] = [];
    for (const element of root.querySelectorAll<HTMLElement>("[data-key]")) {
      const key = element.dataset.key;
      if (!key) continue;
      const box = element.getBoundingClientRect();
      next.set(key, box);
      const previous = boxes.current.get(key);
      if (!previous) continue;
      const dx = (previous.left - box.left) / scale;
      const dy = (previous.top - box.top) / scale;
      const sx = previous.width / box.width;
      const sy = previous.height / box.height;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1 && Math.abs(sx - 1) < 0.01 && Math.abs(sy - 1) < 0.01) continue;
      moves.push({ element, dx, dy, sx, sy });
    }
    boxes.current = next;
    if (!moves.length) return;
    for (const { element, dx, dy, sx, sy } of moves) {
      element.style.transition = "none";
      element.style.transformOrigin = "top left";
      element.style.willChange = "transform";
      element.style.transform = `translate(${dx.toFixed(1)}px, ${dy.toFixed(1)}px) scale(${sx.toFixed(4)}, ${sy.toFixed(4)})`;
    }
    void root.offsetWidth;
    for (const { element } of moves) {
      element.style.transition = `transform ${FLIP_MS}ms ${FLIP_EASE}`;
      element.style.transform = "";
      let settled = false;
      const settle = () => {
        if (settled) return;
        settled = true;
        window.clearTimeout(fallback);
        element.removeEventListener("transitionend", onEnd);
        element.style.transition = "";
        element.style.transformOrigin = "";
        element.style.willChange = "";
      };
      const onEnd = (event: TransitionEvent) => {
        if (event.target === element && event.propertyName === "transform") settle();
      };
      // A block hidden before its transition ends never fires transitionend.
      const fallback = window.setTimeout(settle, FLIP_MS + 100);
      element.addEventListener("transitionend", onEnd);
    }
  }, [container, field]);
}

export function BirdField({
  field,
  minuteTick,
  bornKeys,
  arrivals,
  portraits,
  ground,
  rowOffset,
  coolMs = COOL_MS,
  playing,
  onHear,
  onMore,
}: BirdFieldProps) {
  // Every block's colours, once a minute: its own tint pulled toward the
  // paper as it cools, and type that reads over it.
  const colours = useMemo(() => {
    const map = new Map<string, BlockColours>();
    for (const block of field.blocks) {
      if (block.kind !== "bird") continue;
      map.set(block.key, colourOf(block.age, portraits.get(block.species.scientificName) ?? null, ground, coolMs));
    }
    return map;
    // minuteTick is the cadence of cooling, not a value used here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [field, portraits, ground, coolMs, minuteTick]);

  return (
    <>
      {field.blocks.map((block) => {
        if (block.kind === "ground") return <GroundBlock key={block.key} area={block.area} rowOffset={rowOffset} />;
        if (block.kind === "more") return <MoreBlock key="more" block={block} rowOffset={rowOffset} onTap={onMore} />;
        const colour = colours.get(block.key);
        return (
          <BirdBlock
            key={block.key}
            block={block}
            portrait={portraits.get(block.species.scientificName) ?? null}
            tint={colour?.tint ?? ground.paperDeep}
            type={colour?.type ?? ground.type}
            saturation={colour?.saturation ?? 1}
            dim={ground.dim}
            rowOffset={rowOffset}
            playing={playing === block.key}
            arrival={arrivals.get(block.key) ?? 0}
            born={bornKeys.has(block.key)}
            onTap={onHear}
          />
        );
      })}
    </>
  );
}
