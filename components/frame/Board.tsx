/**
 * The board: the garden's roll call, the weather ahead, and what is coming
 * up at home, over the sky. BirdFrame first; the household around it.
 */

import { memo, type CSSProperties } from "react";
import type { AgendaItem } from "../../lib/frame/agenda.ts";
import type { Portrait } from "../../lib/frame/portraits.ts";
import type { Bloom, RollRow } from "../../lib/frame/scene.ts";
import {
  conditionWord,
  forecastDayLabel,
  weatherGlyph,
  type ForecastDay,
  type HubWeather,
  type WeatherGlyphId,
} from "../../lib/frame/weather.ts";

function clockOf(at: number): string {
  return new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false }).format(
    new Date(at),
  );
}

const CLOUD = "M 11 30 a 7 7 0 0 1 2 -13.7 a 9 9 0 0 1 17.4 -2 a 7 7 0 0 1 7.6 7.2 a 6 6 0 0 1 -1 8.5 Z";

/** Weather marks drawn with one stroke weight, so they sit with the type. */
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

type WeatherStripProps = {
  now: number;
  weather: HubWeather | null;
  forecast: ForecastDay[];
  night: boolean;
};

export const WeatherStrip = memo(function WeatherStrip({ now, weather, forecast, night }: WeatherStripProps) {
  if (!weather && !forecast.length) return null;
  const temperature = typeof weather?.temperature === "number" ? Math.round(weather.temperature) : null;
  const unit = (weather as { unit?: string } | null)?.unit || "°C";
  const wind =
    typeof weather?.windSpeed === "number"
      ? `wind ${Math.round(weather.windSpeed)} ${weather.windSpeedUnit || "km/h"}`
      : "";
  const days = forecast.slice(0, 5);
  return (
    <section className="frame-weather" aria-label="Weather">
      <div className="frame-weather__now">
        <WeatherGlyph id={weatherGlyph(weather?.condition, night)} size={56} />
        <div>
          <strong>{temperature !== null ? `${temperature}${unit.replace("C", "")}` : "–"}</strong>
          <span>
            {conditionWord(weather?.condition)}
            {wind ? ` · ${wind}` : ""}
          </span>
        </div>
      </div>
      {days.length ? (
        <ol className="frame-weather__days">
          {days.map((day) => (
            <li key={day.date}>
              <span className="frame-weather__day">{forecastDayLabel(day.date, now)}</span>
              <WeatherGlyph id={weatherGlyph(day.condition)} size={40} />
              <span className="frame-weather__range">
                {day.high !== null ? Math.round(day.high) : "–"}°
                <i>{day.low !== null ? ` ${Math.round(day.low)}°` : ""}</i>
              </span>
              {typeof day.precipitation === "number" && day.precipitation >= 30 ? (
                <small>{Math.round(day.precipitation)}% rain</small>
              ) : (
                <small>&nbsp;</small>
              )}
            </li>
          ))}
        </ol>
      ) : null}
    </section>
  );
});

type RollCallProps = {
  rows: RollRow[];
  bloom: Bloom | null;
  leaving: boolean;
  portraits: Map<string, Portrait | null>;
  playing: string | null;
  songLevel: number;
  daylight: string;
  moreCount: number;
  onTap: (commonName: string, clipUrl: string | null) => void;
};

function callsWord(count: number): string {
  const words = ["", "one call", "two calls", "three calls", "four calls", "five calls", "six calls"];
  return words[count] ?? `${count} calls`;
}

export const RollCall = memo(function RollCall({
  rows,
  bloom,
  leaving,
  portraits,
  playing,
  songLevel,
  daylight,
  moreCount,
  onTap,
}: RollCallProps) {
  if (!rows.length) return null;
  const earlier = rows[0].earlier;
  return (
    <section className="frame-roll" aria-label={earlier ? "Earlier today" : "The last hour"}>
      {earlier ? <p className="frame-roll__kicker">Quiet now · earlier today</p> : null}
      <ol>
        {rows.map((row) => {
          const { species } = row;
          const isHero = row.rank === 0;
          const blooming = isHero && bloom !== null && bloom.commonName === species.commonName && !leaving;
          const portrait = portraits.get(species.scientificName) ?? null;
          const kicker = blooming
            ? bloom.kind === "new-to-garden"
              ? "New to this garden"
              : bloom.kind === "first-voice"
                ? `First voice${daylight ? ` · ${daylight}` : ""}`
                : ""
            : "";
          return (
            <li
              key={species.commonName}
              className="frame-roll__row"
              data-rank={Math.min(row.rank, 6)}
              data-hero={isHero}
              data-bloom={blooming}
              data-tier={species.tier}
              data-playing={playing === species.commonName}
              style={{ "--recency": String(row.recency), "--song-level": String(songLevel) } as CSSProperties}
              onPointerUp={(event) => {
                event.stopPropagation();
                onTap(species.commonName, blooming ? bloom.clipUrl : null);
              }}
            >
              <div className="frame-roll__text">
                {kicker ? <p className="frame-roll__kicker frame-roll__kicker--gold">{kicker}</p> : null}
                <h2 className="frame-roll__name">{species.commonName}</h2>
                <p className="frame-roll__meta">
                  {species.lastHeard ? clockOf(species.lastHeard) : ""}
                  {species.tier ? ` · ${species.tier}` : ""}
                  {blooming && bloom.confidence ? ` · ${Math.round(bloom.confidence * 100)}%` : ""}
                  <span className="frame-roll__calls" aria-label={callsWord(species.count)}>
                    {"●".repeat(Math.min(species.count, 12))}
                    {species.count > 12 ? ` +${species.count - 12}` : ""}
                  </span>
                  <em>{callsWord(species.count)}</em>
                  {isHero ? <em className="frame-roll__hint"> · touch to hear</em> : null}
                </p>
              </div>
              <div className="frame-roll__portrait" data-empty={!portrait}>
                {portrait ? (
                  <div className="frame-roll__photo" style={{ backgroundImage: `url("${portrait.image}")` }} />
                ) : (
                  <span>{species.commonName.slice(0, 1)}</span>
                )}
                <span className="frame-roll__ribbon" />
                <span className="frame-roll__ribbon frame-roll__ribbon--late" />
              </div>
            </li>
          );
        })}
      </ol>
      {moreCount > 0 ? <p className="frame-roll__more">and {moreCount} more this hour</p> : null}
    </section>
  );
});

type AgendaProps = {
  items: AgendaItem[];
  shoppingCount: number;
};

export const Agenda = memo(function Agenda({ items, shoppingCount }: AgendaProps) {
  if (!items.length && !shoppingCount) return null;
  return (
    <section className="frame-agenda" aria-label="Coming up">
      <p className="frame-agenda__kicker">Coming up</p>
      <ul>
        {items.map((item) => (
          <li key={`${item.at}-${item.summary}`} data-kind={item.kind}>
            <span className="frame-agenda__when">{item.when}</span>
            <strong>{item.summary}</strong>
          </li>
        ))}
        {shoppingCount > 0 ? (
          <li data-kind="list">
            <span className="frame-agenda__when">House list</span>
            <strong>
              {shoppingCount} {shoppingCount === 1 ? "item" : "items"} to pick up
            </strong>
          </li>
        ) : null}
      </ul>
    </section>
  );
});
