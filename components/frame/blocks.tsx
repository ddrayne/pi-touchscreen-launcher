/**
 * The poster's blocks. Bird blocks are a photograph, its own tint and the
 * name; house blocks sit on a shade of the paper. Each is a plain button
 * placed by `gridArea`, memoised so a tick only re-renders what changed.
 */

import { memo, useState, type CSSProperties, type ReactNode } from "react";
import type { AgendaItem } from "../../lib/frame/agenda.ts";
import type { Portrait } from "../../lib/frame/portraits.ts";
import type { BirdBlock as BirdBlockModel, MoreBlock as MoreBlockModel, PosterArea } from "../../lib/frame/poster.ts";
import { tierWeight } from "../../lib/frame/palette.ts";
import { tierWord } from "../../lib/frame/scene.ts";
import type { Rgb } from "../../lib/frame/solar.ts";
import { tapProps } from "./tap.ts";
import {
  conditionWord,
  forecastDayLabel,
  weatherGlyph,
  type ForecastDay,
  type HubWeather,
  type WeatherGlyphId,
} from "../../lib/frame/weather.ts";

const CLOCK = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false });
const DATE = new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long" });

export function clockOf(at: number): string {
  return CLOCK.format(new Date(at));
}

export function dateOf(at: number): string {
  return DATE.format(new Date(at));
}

/** CSS grid placement for a field area, offset by the house rows above the birds. */
export function gridAreaOf(area: PosterArea, rowOffset = 0): string {
  return `${area.row + 1 + rowOffset} / ${area.col + 1} / span ${area.rows} / span ${area.cols}`;
}

export type SizeTier = "tiny" | "small" | "medium" | "large" | "hero";

export function sizeTierOf(area: PosterArea): SizeTier {
  const cells = area.cols * area.rows;
  if (cells <= 1) return "tiny";
  if (cells <= 3) return "small";
  if (cells <= 6) return "medium";
  if (cells <= 9) return "large";
  return "hero";
}

function callsWord(count: number): string {
  const words = ["", "one call", "two calls", "three calls", "four calls", "five calls", "six calls"];
  return words[count] ?? `${count} calls`;
}

/* Weather marks drawn with one stroke weight, so they sit with the type. */

const CLOUD = "M 11 30 a 7 7 0 0 1 2 -13.7 a 9 9 0 0 1 17.4 -2 a 7 7 0 0 1 7.6 7.2 a 6 6 0 0 1 -1 8.5 Z";

export const WeatherGlyph = memo(function WeatherGlyph({ id, size = 44 }: { id: WeatherGlyphId; size?: number }) {
  return (
    <svg className="frame-glyph" viewBox="0 0 48 48" width={size} height={size} aria-hidden="true">
      {id === "sun" || id === "partly" ? (
        <g transform={id === "partly" ? "translate(-6 -6) scale(0.8)" : undefined}>
          <circle cx="24" cy="24" r="8" />
          {Array.from({ length: 8 }, (_, index) => {
            const angle = (index / 8) * Math.PI * 2;
            return (
              <line
                key={index}
                x1={24 + Math.cos(angle) * 12}
                y1={24 + Math.sin(angle) * 12}
                x2={24 + Math.cos(angle) * 16}
                y2={24 + Math.sin(angle) * 16}
              />
            );
          })}
        </g>
      ) : null}
      {id === "partly" || id === "cloud" || id === "rain" || id === "pour" || id === "snow" || id === "storm" ? (
        <path d={CLOUD} transform={id === "partly" ? "translate(4 6)" : "translate(2 2)"} />
      ) : null}
      {id === "rain" || id === "pour" ? (
        <g transform="translate(2 2)">
          {(id === "pour" ? [12, 18, 24, 30, 36] : [15, 24, 33]).map((x) => (
            <line key={x} x1={x} y1={34} x2={x - 3} y2={42} />
          ))}
        </g>
      ) : null}
      {id === "snow" ? (
        <g transform="translate(2 2)">
          {[15, 24, 33].map((x) => (
            <circle key={x} cx={x} cy={38} r={1.6} className="frame-glyph__dot" />
          ))}
        </g>
      ) : null}
      {id === "storm" ? <polygon points="26,30 19,41 25,41 22,48 31,36 25,36 28,30" className="frame-glyph__fill" /> : null}
      {id === "fog" ? (
        <g>
          <line x1="10" y1="18" x2="38" y2="18" />
          <line x1="8" y1="26" x2="40" y2="26" />
          <line x1="12" y1="34" x2="36" y2="34" />
        </g>
      ) : null}
      {id === "wind" ? (
        <g>
          <path d="M 8 20 H 30 a 4 4 0 1 0 -4 -4" fill="none" />
          <path d="M 8 28 H 36 a 4 4 0 1 1 -4 4" fill="none" />
        </g>
      ) : null}
      {id === "night" ? <path d="M 30 10 a 14 14 0 1 0 8 25 a 11 11 0 0 1 -8 -25 Z" className="frame-glyph__fill" /> : null}
      {id === "unknown" ? <circle cx="24" cy="24" r="10" /> : null}
    </svg>
  );
});

/* Bird ------------------------------------------------------------------ */

export type BirdBlockProps = {
  block: BirdBlockModel;
  portrait: Portrait | null;
  /** The block's background once cooled toward the paper. */
  tint: Rgb;
  type: Rgb;
  saturation: number;
  /** 0 by day, up to 0.4 at night. */
  dim: number;
  rowOffset: number;
  playing: boolean;
  /** Increments when a call for this species lands, to replay the ring. */
  arrival: number;
  born: boolean;
  onTap: (commonName: string) => void;
};

export const BirdBlock = memo(function BirdBlock({
  block,
  portrait,
  tint,
  type,
  saturation,
  dim,
  rowOffset,
  playing,
  arrival,
  born,
  onTap,
}: BirdBlockProps) {
  const { species, area } = block;
  // The arrival flash and ring leave the tree once the ring has played, so a
  // block that rang is as still as one that never did.
  const [rang, setRang] = useState(0);
  const tier = sizeTierOf(area);
  const wide = area.cols >= area.rows;
  const style = {
    gridArea: gridAreaOf(area, rowOffset),
    "--pb-tint-rgb": tint.join(" "),
    "--pb-type-rgb": type.join(" "),
    "--pb-weight": String(tierWeight(species.tier)),
    "--pb-style": species.tier === "tentative" ? "italic" : "normal",
    "--sat": saturation.toFixed(3),
    "--ink": block.ink.toFixed(3),
    "--dim": dim.toFixed(3),
    "--fx": portrait?.focal ? portrait.focal.x.toFixed(3) : "0.5",
    "--fy": portrait?.focal ? portrait.focal.y.toFixed(3) : "0.5",
  } as CSSProperties;
  const meta = [
    species.lastHeard ? clockOf(species.lastHeard) : "",
    species.tier ? tierWord(species.tier) : "",
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <button
      type="button"
      className="pb pb--bird"
      data-key={block.key}
      data-tier={tier}
      data-wide={wide}
      data-hero={block.hero}
      data-new={block.newToGarden}
      data-playing={playing}
      data-born={born}
      style={style}
      aria-label={`${species.commonName}, ${callsWord(species.count)}${playing ? "; playing, touch to stop" : "; touch to hear"}`}
      aria-pressed={playing}
      {...tapProps(() => onTap(species.commonName))}
    >
      {portrait ? (
        <span className="pb__photo" style={{ backgroundImage: `url("${portrait.image}")` }} aria-hidden="true" />
      ) : null}
      {portrait ? <span className="pb__shade" aria-hidden="true" /> : null}
      <span className="pb__text">
        {block.newToGarden && tier !== "tiny" ? <span className="pb__kicker">New to this garden</span> : null}
        <span className="pb__name">{species.commonName}</span>
        {tier !== "tiny" ? (
          <span className="pb__meta">
            {meta}
            <span className="pb__dots" aria-hidden="true">
              {"●".repeat(Math.min(species.count, 14))}
              {species.count > 14 ? ` +${species.count - 14}` : ""}
            </span>
          </span>
        ) : null}
      </span>
      {arrival > 0 && rang !== arrival ? (
        <>
          <span className="pb__flash" key={`flash-${arrival}`} aria-hidden="true" />
          <span className="pb__ring" key={`ring-${arrival}`} aria-hidden="true" onAnimationEnd={() => setRang(arrival)} />
        </>
      ) : null}
    </button>
  );
});

/* And N more ------------------------------------------------------------- */

export const MoreBlock = memo(function MoreBlock({
  block,
  rowOffset,
  onTap,
}: {
  block: MoreBlockModel;
  rowOffset: number;
  onTap: () => void;
}) {
  return (
    <button
      type="button"
      className="pb pb--house pb--more"
      data-key="more"
      style={{ gridArea: gridAreaOf(block.area, rowOffset) }}
      aria-label={`And ${block.names.length} more: ${block.names.join(", ")}. Open the journal`}
      {...tapProps(onTap)}
    >
      <span className="pb__text">
        <span className="pb__name">+{block.names.length}</span>
        <span className="pb__meta">more</span>
      </span>
    </button>
  );
});

export const GroundBlock = memo(function GroundBlock({ area, rowOffset }: { area: PosterArea; rowOffset: number }) {
  return <span className="pb pb--ground pb--still" style={{ gridArea: gridAreaOf(area, rowOffset) }} aria-hidden="true" />;
});

/* House ------------------------------------------------------------------- */

type HouseProps = { gridArea: string; onTap?: () => void };

/** A house block is a button when it opens something and a still div when it does not. */
function House({ className, gridArea, onTap, label, children }: HouseProps & { className: string; label?: string; children: ReactNode }) {
  if (!onTap) {
    return (
      <div className={`pb pb--house ${className} pb--still`} style={{ gridArea }} aria-label={label}>
        {children}
      </div>
    );
  }
  return (
    <button type="button" className={`pb pb--house ${className}`} style={{ gridArea }} aria-label={label} {...tapProps(onTap)}>
      {children}
    </button>
  );
}

export const ClockBlock = memo(function ClockBlock({ now, gridArea, onTap }: HouseProps & { now: number }) {
  return (
    <House className="pb--clock" gridArea={gridArea} onTap={onTap}>
      <time className="pb__time" dateTime={new Date(now).toISOString()}>
        {clockOf(now)}
      </time>
      <span className="pb__date">{dateOf(now)}</span>
    </House>
  );
});

export const WeatherBlock = memo(function WeatherBlock({
  weather,
  night,
  gridArea,
  onTap,
}: HouseProps & { weather: HubWeather | null; night: boolean }) {
  const temperature = typeof weather?.temperature === "number" ? Math.round(weather.temperature) : null;
  const wind =
    typeof weather?.windSpeed === "number"
      ? `wind ${Math.round(weather.windSpeed)} ${weather.windSpeedUnit || "km/h"}`
      : "";
  return (
    <House className="pb--weather" gridArea={gridArea} onTap={onTap}>
      <span className="pb__label">Outside</span>
      <span className="pb__temp">
        {temperature !== null ? temperature : "–"}
        <sup>°</sup>
      </span>
      <span className="pb__condition">
        <span>
          {conditionWord(weather?.condition)}
          {wind ? ` · ${wind}` : ""}
        </span>
        <WeatherGlyph id={weatherGlyph(weather?.condition, night)} size={40} />
      </span>
    </House>
  );
});

export const StatusBlock = memo(function StatusBlock({
  place,
  daylight,
  count,
  countLabel,
  gridArea,
}: {
  place: string;
  daylight: string;
  count: number | null;
  countLabel: string;
  gridArea: string;
}) {
  return (
    <div className="pb pb--house pb--status pb--still" style={{ gridArea }}>
      <p className="pb__label">The {place} window</p>
      {daylight ? <p className="pb__daylight">{daylight}</p> : null}
      <p className="pb__count">
        {count === null ? "–" : count}
        <small>{countLabel}</small>
      </p>
    </div>
  );
});

export const AgendaBlock = memo(function AgendaBlock({ items, gridArea, onTap }: HouseProps & { items: AgendaItem[]; onTap: () => void }) {
  const shown = items.slice(0, 2);
  return (
    <button type="button" className="pb pb--house pb--agenda" style={{ gridArea }} {...tapProps(onTap)}>
      <span className="pb__label">Coming up</span>
      {shown.length ? (
        shown.map((item) => (
          <span className="pb__item" key={`${item.at}-${item.summary}`} data-kind={item.kind}>
            <span className="pb__when">{item.when}</span>
            <span className="pb__summary">{item.summary}</span>
          </span>
        ))
      ) : (
        <span className="pb__empty">Nothing in the diary</span>
      )}
    </button>
  );
});

export const ListBlock = memo(function ListBlock({ count, gridArea, onTap }: HouseProps & { count: number; onTap: () => void }) {
  return (
    <button type="button" className="pb pb--house pb--list" style={{ gridArea }} {...tapProps(onTap)}>
      <span className="pb__label">House list</span>
      <span className="pb__count">
        {count > 0 ? (
          <>
            <strong>{count}</strong>
            {count === 1 ? "thing to pick up" : "things to pick up"}
          </>
        ) : (
          "Nothing to buy"
        )}
      </span>
    </button>
  );
});

export const ForecastBlock = memo(function ForecastBlock({
  now,
  forecast,
  gridArea,
  onTap,
}: HouseProps & { now: number; forecast: ForecastDay[] }) {
  const days = forecast.slice(0, 5);
  return (
    <House className="pb--forecast" gridArea={gridArea} onTap={onTap} label="Five-day forecast">
      {days.length ? (
        days.map((day) => (
          <span className="pb__day" key={day.date}>
            <WeatherGlyph id={weatherGlyph(day.condition)} size={44} />
            <span className="pb__dayname">{forecastDayLabel(day.date, now)}</span>
            <span className="pb__range">
              {day.high !== null ? Math.round(day.high) : "–"}°<i>{day.low !== null ? `${Math.round(day.low)}°` : ""}</i>
              {typeof day.precipitation === "number" && day.precipitation >= 30 ? (
                <span className="pb__rain">{Math.round(day.precipitation)}%</span>
              ) : null}
            </span>
          </span>
        ))
      ) : (
        <span className="pb__empty">Forecast on its way</span>
      )}
    </House>
  );
});
