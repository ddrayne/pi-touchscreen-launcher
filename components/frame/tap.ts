/**
 * A tap on a block: pointer down and up within a few pixels. A swipe that
 * happens to end on a block is left to propagate, so the page can finish
 * it; a tap is kept from the page, so the frame does not also wake.
 */

import type { PointerEvent } from "react";

const SLOP_PX = 10;

let down: { id: number; x: number; y: number } | null = null;

export type TapProps = {
  onPointerDown: (event: PointerEvent) => void;
  onPointerUp: (event: PointerEvent) => void;
};

export function tapProps(action: () => void): TapProps {
  return {
    onPointerDown(event) {
      down = { id: event.pointerId, x: event.clientX, y: event.clientY };
    },
    onPointerUp(event) {
      const start = down;
      down = null;
      if (start && start.id === event.pointerId && Math.hypot(event.clientX - start.x, event.clientY - start.y) > SLOP_PX) return;
      event.stopPropagation();
      action();
    },
  };
}
