/**
 * The birds. Perching birds fly in from the edge and settle on an anchor;
 * sky crossers loop across their band. Motion runs on the compositor through
 * the individual `translate` and `scale` properties, so the main thread is
 * idle between arrivals.
 */

import { memo, useEffect, useRef, useState, type CSSProperties } from "react";
import type { Body } from "../../lib/frame/scene.ts";
import { FRAME_HEIGHT, FRAME_WIDTH, GARDEN_TOP } from "../../lib/frame/garden.ts";
import { Silhouette } from "./Silhouette.tsx";

const BASE_SCALE = 1.8;
const FLIGHT_SPEED = 300; // px per second for a thrush

type InhabitantsProps = {
  bodies: Body[];
  frozen: boolean;
  onTap: (body: Body) => void;
};

function flapPeriod(body: Body): number {
  switch (body.archetype.id) {
    case "tit":
    case "warbler":
    case "skulker":
      return 0.22;
    case "finch":
    case "robin":
    case "gang":
    case "default":
      return 0.28;
    case "thrush":
    case "woodpecker":
      return 0.34;
    case "pigeon":
      return 0.42;
    case "corvid":
    case "night":
      return 0.6;
    case "gull":
      return 0.95;
    case "wader":
    case "flyover":
      return 1.3;
    default:
      return 0.5;
  }
}

function perchPosition(body: Body): { x: number; y: number } {
  if (body.anchor) return { x: body.anchor.x, y: GARDEN_TOP + body.anchor.y };
  const [low, high] = body.archetype.band;
  const t = (body.seed % 1000) / 1000;
  return { x: 600, y: FRAME_HEIGHT * (low + (high - low) * t) };
}

function bodyScale(body: Body): number {
  const anchorScale = body.anchor ? body.anchor.scale : 0.85;
  return BASE_SCALE * body.archetype.scale * anchorScale;
}

/** Keyframes for a bird that never lands: across its band and back, or round in a circle. */
function skyKeyframes(body: Body): { frames: Keyframe[]; duration: number } {
  const seed = body.seed;
  const speed = body.archetype.speed;
  const rightward = seed % 2 === 0;
  const left = -220 - (seed % 160);
  const right = FRAME_WIDTH + 220 + (seed % 160);
  const from = rightward ? left : right;
  const to = rightward ? right : left;
  const face = (dir: number) => `${dir > 0 ? 1 : -1} 1`;
  const crossing = (Math.abs(to - from) / (FLIGHT_SPEED * speed)) * 1000;

  if (body.archetype.flight === "circle") {
    const centreX = 420 + (seed % 360);
    const rx = 260 + (seed % 90);
    const ry = 70 + (seed % 40);
    const frames: Keyframe[] = [];
    const steps = 24;
    for (let index = 0; index <= steps; index += 1) {
      const angle = (index / steps) * Math.PI * 2;
      const dx = centreX + Math.cos(angle) * rx - 600;
      const dy = Math.sin(angle) * ry;
      const movingRight = -Math.sin(angle) >= 0;
      frames.push({
        translate: `${dx.toFixed(1)}px ${dy.toFixed(1)}px`,
        scale: face(movingRight ? 1 : -1),
        offset: index / steps,
        easing: "linear",
      });
    }
    return { frames, duration: (crossing * 2.4) | 0 };
  }

  if (body.archetype.flight === "scythe") {
    // Out along a wave, turn, and back along another, as swifts do.
    const frames: Keyframe[] = [];
    const waves = 3;
    const points = 10;
    const amplitude = 60 + (seed % 50);
    for (let leg = 0; leg < 2; leg += 1) {
      const dir = leg === 0 ? 1 : -1;
      for (let index = 0; index <= points; index += 1) {
        const t = index / points;
        const x = (leg === 0 ? from + (to - from) * t : to + (from - to) * t) - 600;
        const dy = Math.sin(t * Math.PI * waves + leg) * amplitude;
        frames.push({
          translate: `${x.toFixed(1)}px ${dy.toFixed(1)}px`,
          scale: face(dir * (rightward ? 1 : -1)),
          offset: (leg * (points + 1) + index) / (2 * (points + 1) - 1),
          easing: "ease-in-out",
        });
      }
    }
    return { frames, duration: crossing * 2.2 };
  }

  // A line crossing, then gone for a while, then again.
  const wobble = 24 + (seed % 30);
  const hold = 0.28;
  const frames: Keyframe[] = [
    { translate: `${from - 600}px 0px`, scale: face(to - from), offset: 0 },
    { translate: `${(from + to) / 2 - 600}px ${-wobble}px`, scale: face(to - from), offset: hold * 0.5 },
    { translate: `${to - 600}px 0px`, scale: face(to - from), offset: hold },
    { translate: `${to - 600}px 0px`, scale: face(to - from), offset: 1 },
  ];
  return { frames, duration: crossing / hold };
}

type BirdBodyProps = {
  body: Body;
  arrive: boolean;
  onTap: (body: Body) => void;
};

const BirdBody = memo(function BirdBody({ body, arrive, onTap }: BirdBodyProps) {
  const element = useRef<HTMLDivElement | null>(null);
  const [flying, setFlying] = useState(arrive || body.anchor === null);
  const { x, y } = perchPosition(body);
  const scale = bodyScale(body);
  const gliding = body.archetype.flight === "circle" || body.archetype.flight === "glide";

  useEffect(() => {
    const node = element.current;
    if (!node) return;
    if (body.anchor === null) {
      const { frames, duration } = skyKeyframes(body);
      const animation = node.animate(frames, {
        duration: Math.max(4_000, duration),
        iterations: Number.POSITIVE_INFINITY,
        delay: -((body.seed % 1000) / 1000) * duration,
      });
      return () => animation.cancel();
    }
    if (!arrive) return;
    const fromX = body.facing === 1 ? -(x + 180) : FRAME_WIDTH + 180 - x;
    const [low, high] = body.archetype.band;
    const bandY = FRAME_HEIGHT * (low + ((body.seed % 100) / 100) * (high - low));
    const fromY = Math.min(bandY, y - 120) - y;
    const distance = Math.hypot(fromX, fromY);
    const duration = Math.max(1_100, (distance / (FLIGHT_SPEED * body.archetype.speed)) * 1000);
    const animation = node.animate(
      [
        { translate: `${fromX}px ${fromY}px`, scale: `${body.facing} 1` },
        { translate: `${fromX * 0.45}px ${fromY * 0.55 - 70}px`, scale: `${body.facing} 1`, offset: 0.55 },
        { translate: "0px 0px", scale: `${body.facing} 1` },
      ],
      { duration, easing: "cubic-bezier(0.25, 0.6, 0.3, 1)", fill: "both" },
    );
    const settle = () => setFlying(false);
    animation.addEventListener("finish", settle);
    return () => {
      animation.removeEventListener("finish", settle);
      animation.cancel();
    };
    // The arrival choreography belongs to the body's first mount only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      ref={element}
      className="frame-body"
      data-archetype={body.archetype.id}
      data-idle={body.anchor ? body.archetype.idle : "sky"}
      data-flying={flying}
      style={{
        left: x - 50,
        top: y - 92,
        opacity: body.ink,
        transform: `scale(${scale})`,
        scale: `${body.facing} 1`,
        "--flap": `${flapPeriod(body)}s`,
        "--seed": String((body.seed % 1000) / 1000),
      } as CSSProperties}
      onPointerUp={(event) => {
        event.stopPropagation();
        onTap(body);
      }}
      title={body.commonName}
    >
      <Silhouette id={body.archetype.silhouette} flying={flying} gliding={flying && gliding} />
    </div>
  );
});

export const Inhabitants = memo(function Inhabitants({ bodies, frozen, onTap }: InhabitantsProps) {
  const mounted = useRef(false);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      mounted.current = true;
    }, 1_500);
    return () => window.clearTimeout(timer);
  }, []);
  return (
    <div className="frame-inhabitants" data-frozen={frozen}>
      {bodies.map((body) => (
        <BirdBody key={body.key} body={body} arrive={mounted.current} onTap={onTap} />
      ))}
    </div>
  );
});
