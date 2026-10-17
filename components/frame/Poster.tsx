/**
 * The poster: the house in fixed blocks above and below, the birds in a
 * field between, all on one 6 x 10 grid over the sky. Placement changes
 * play one FLIP transform; nothing runs while nothing happens.
 */

import { memo, useLayoutEffect, useMemo, useRef, type CSSProperties } from "react";
import type { AgendaItem } from "../../lib/frame/agenda.ts";
import { blockTint, cooling, typeOver, type GroundPalette } from "../../lib/frame/palette.ts";
import type { Portrait } from "../../lib/frame/portraits.ts";
import type { PosterField } from "../../lib/frame/poster.ts";
import type { Rgb } from "../../lib/frame/solar.ts";
import type { ForecastDay, HubWeather } from "../../lib/frame/weather.ts";
import {
  AgendaBlock,
  BirdBlock,
  ClockBlock,
  ForecastBlock,
  GroundBlock,
  ListBlock,
  MoreBlock,
  StatusBlock,
  WeatherBlock,
} from "./blocks.tsx";
import "./poster.css";

/** The birds start under two rows of house blocks. */
export const FIELD_ROW_OFFSET = 2;
const FRAME_WIDTH = 1200;
const FLIP_MS = 900;
const FLIP_EASE = "cubic-bezier(0.2, 0.7, 0.2, 1)";

export type HouseholdPanel = "agenda" | "shopping" | undefined;

export type PosterProps = {
  /** The wall clock, once a second. */
  now: number;
  /** A minute tick: cooling and the honesty line only move this often. */
  minuteTick: number;
  field: PosterField;
  /** Keys of blocks that were not in the previous field. */
  bornKeys: ReadonlySet<string>;
  /** Species whose latest call should ring, by detection id. */
  arrivals: ReadonlyMap<string, number>;
  portraits: Map<string, Portrait | null>;
  ground: GroundPalette;
  night: boolean;
  place: string;
  daylight: string;
  reachable: boolean;
  /** Species in the window and today, for the status block. */
  hourCount: number;
  todayCount: number | null;
  quietMinutes: number | null;
  weather: HubWeather | null;
  forecast: ForecastDay[];
  agenda: AgendaItem[];
  shoppingCount: number;
  playing: string | null;
  onHear: (commonName: string) => void;
  onOpenJournal: () => void;
  onOpenHousehold: (panel?: HouseholdPanel) => void;
};

type BlockColours = { tint: Rgb; type: Rgb; saturation: number };

/**
 * Plays placement changes as transforms from the old box to the new one, so
 * a growing block shoves its neighbours rather than jumping.
 */
function useFlip(container: React.RefObject<HTMLDivElement | null>, field: PosterField): void {
  const boxes = useRef(new Map<string, DOMRect>());
  useLayoutEffect(() => {
    const root = container.current;
    if (!root) return;
    const scale = root.getBoundingClientRect().width / FRAME_WIDTH || 1;
    const next = new Map<string, DOMRect>();
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
      element.style.transition = "none";
      element.style.transformOrigin = "top left";
      element.style.transform = `translate(${dx.toFixed(1)}px, ${dy.toFixed(1)}px) scale(${sx.toFixed(4)}, ${sy.toFixed(4)})`;
      void element.offsetWidth;
      element.style.transition = `transform ${FLIP_MS}ms ${FLIP_EASE}`;
      element.style.transform = "";
      const settle = () => {
        element.style.transition = "";
        element.style.transformOrigin = "";
        element.removeEventListener("transitionend", settle);
      };
      element.addEventListener("transitionend", settle);
    }
    boxes.current = next;
  }, [container, field]);
}

export const Poster = memo(function Poster({
  now,
  minuteTick,
  field,
  bornKeys,
  arrivals,
  portraits,
  ground,
  night,
  place,
  daylight,
  reachable,
  hourCount,
  todayCount,
  quietMinutes,
  weather,
  forecast,
  agenda,
  shoppingCount,
  playing,
  onHear,
  onOpenJournal,
  onOpenHousehold,
}: PosterProps) {
  const root = useRef<HTMLDivElement | null>(null);
  useFlip(root, field);

  // Every block's colours, once a minute: its own tint pulled toward the
  // paper as it cools, and type that reads over it.
  const colours = useMemo(() => {
    const map = new Map<string, BlockColours>();
    for (const block of field.blocks) {
      if (block.kind !== "bird") continue;
      const portrait = portraits.get(block.species.scientificName) ?? null;
      const cool = cooling(block.age);
      const tint = blockTint(portrait?.tint ?? null, ground, cool.tintMix);
      map.set(block.key, { tint, type: typeOver(tint), saturation: cool.saturation });
    }
    return map;
    // minuteTick is the cadence of cooling, not a value used here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [field, portraits, ground, minuteTick]);

  const style = {
    "--frame-paper-deep-rgb": ground.paperDeep.join(" "),
  } as CSSProperties;

  const countLabel = !reachable
    ? "unreachable"
    : field.window === "today"
      ? quietMinutes !== null && quietMinutes >= 10
        ? `voices today · quiet ${quietMinutes} min`
        : "voices today"
      : "voices · last hour";
  const count = field.window === "today" ? todayCount : hourCount;

  return (
    <div className="poster" ref={root} style={style}>
      <ClockBlock now={now} gridArea="1 / 1 / span 2 / span 3" onTap={() => onOpenHousehold()} />
      <WeatherBlock weather={weather} night={night} gridArea="1 / 4 / span 2 / span 2" onTap={() => onOpenHousehold()} />
      <StatusBlock place={place} daylight={daylight} count={count} countLabel={countLabel} gridArea="1 / 6 / span 2 / span 1" />

      {field.blocks.map((block) => {
        if (block.kind === "ground") return <GroundBlock key={block.key} area={block.area} rowOffset={FIELD_ROW_OFFSET} />;
        if (block.kind === "more") return <MoreBlock key="more" block={block} rowOffset={FIELD_ROW_OFFSET} onTap={onOpenJournal} />;
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
            rowOffset={FIELD_ROW_OFFSET}
            playing={playing === block.key}
            arrival={arrivals.get(block.key) ?? 0}
            born={bornKeys.has(block.key)}
            onTap={onHear}
          />
        );
      })}

      <AgendaBlock items={agenda} gridArea="9 / 1 / span 1 / span 4" onTap={() => onOpenHousehold("agenda")} />
      <ListBlock count={shoppingCount} gridArea="9 / 5 / span 1 / span 2" onTap={() => onOpenHousehold("shopping")} />
      <ForecastBlock now={minuteTick} forecast={forecast} gridArea="10 / 1 / span 1 / span 6" onTap={() => onOpenHousehold()} />

      <div className="poster-foot">
        <span>
          {field.window === "today" ? "An impression of today" : "An impression of the last hour"} · one dot is one call
        </span>
        <button
          type="button"
          onPointerUp={(event) => {
            event.stopPropagation();
            onOpenJournal();
          }}
        >
          The journal is one tap away →
        </button>
      </div>
    </div>
  );
});
