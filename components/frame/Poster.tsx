/**
 * The poster: the house in fixed blocks above and below, the birds in a
 * field between, all on one 6 x 10 grid over the sky. Placement changes
 * play one FLIP transform; nothing runs while nothing happens.
 */

import { memo, useCallback, useRef } from "react";
import type { AgendaItem } from "../../lib/frame/agenda.ts";
import type { GroundPalette } from "../../lib/frame/palette.ts";
import type { Portrait } from "../../lib/frame/portraits.ts";
import { fieldVoices, type PosterField } from "../../lib/frame/poster.ts";
import type { ForecastDay, HubWeather } from "../../lib/frame/weather.ts";
import { BirdField, useFlip } from "./BirdField.tsx";
import { AgendaBlock, ClockBlock, ForecastBlock, ListBlock, StatusBlock, WeatherBlock } from "./blocks.tsx";
import { tapProps } from "./tap.ts";
import "./poster.css";

/** The birds start under two rows of house blocks. */
export const FIELD_ROW_OFFSET = 2;

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
  /** Species today by the bridge's count, for the status block when the field shows today. */
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

  // One handler per block, stable across ticks, so the memoised blocks hold.
  const openHousehold = useCallback(() => onOpenHousehold(), [onOpenHousehold]);
  const openAgenda = useCallback(() => onOpenHousehold("agenda"), [onOpenHousehold]);
  const openShopping = useCallback(() => onOpenHousehold("shopping"), [onOpenHousehold]);

  const countLabel = !reachable
    ? "unreachable"
    : field.window === "today"
      ? quietMinutes !== null && quietMinutes >= 10
        ? `voices today · quiet ${quietMinutes} min`
        : "voices today"
      : "voices · last hour";
  // The hour's count is the field's own, so the number never disagrees with the blocks.
  const count = field.window === "today" ? todayCount : fieldVoices(field);

  return (
    <div className="poster" ref={root}>
      <ClockBlock now={now} gridArea="1 / 1 / span 2 / span 3" onTap={openHousehold} />
      <WeatherBlock weather={weather} night={night} gridArea="1 / 4 / span 2 / span 2" onTap={openHousehold} />
      <StatusBlock place={place} daylight={daylight} count={count} countLabel={countLabel} gridArea="1 / 6 / span 2 / span 1" />

      <BirdField
        field={field}
        minuteTick={minuteTick}
        bornKeys={bornKeys}
        arrivals={arrivals}
        portraits={portraits}
        ground={ground}
        rowOffset={FIELD_ROW_OFFSET}
        playing={playing}
        onHear={onHear}
        onMore={onOpenJournal}
      />

      <AgendaBlock items={agenda} gridArea="9 / 1 / span 1 / span 4" onTap={openAgenda} />
      <ListBlock count={shoppingCount} gridArea="9 / 5 / span 1 / span 2" onTap={openShopping} />
      <ForecastBlock now={minuteTick} forecast={forecast} gridArea="10 / 1 / span 1 / span 6" onTap={openHousehold} />

      <div className="poster-foot">
        <span>
          {field.window === "today" ? "An impression of today" : "An impression of the last hour"} · one dot is one call
        </span>
        <button type="button" {...tapProps(onOpenJournal)}>
          The journal is one tap away →
        </button>
      </div>
    </div>
  );
});
