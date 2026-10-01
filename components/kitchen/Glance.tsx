import type { CSSProperties } from "react";
import {
  FORECAST_HOURS,
  describeWeather,
  formatTemperature,
  hourLabel,
  rainSummary,
  type HourForecast,
  type WeatherSnapshot,
} from "../../lib/weather";

const clockFormat = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});
const dateFormat = new Intl.DateTimeFormat("en-GB", {
  weekday: "long",
  day: "numeric",
  month: "long",
});

export function Masthead({ now, weather }: { now: Date; weather: WeatherSnapshot | null }) {
  const sky = describeWeather(weather?.now?.weatherCode);
  return (
    <header className="masthead">
      <time className="masthead__clock" suppressHydrationWarning>
        {clockFormat.format(now)}
      </time>
      <div className="masthead__side">
        <span className="masthead__date" suppressHydrationWarning>
          {dateFormat.format(now)}
        </span>
        {weather?.now ? (
          <span className="masthead__weather">
            <strong>{formatTemperature(weather.now.temperature)}</strong>
            {sky ? <span>{sky}</span> : null}
          </span>
        ) : null}
      </div>
    </header>
  );
}

/** The rain decision in words, over the hourly chances that back it up. */
export function RainStrip({ hours }: { hours: HourForecast[] }) {
  const visible = hours.slice(0, FORECAST_HOURS);
  if (!visible.length) return null;
  const rain = rainSummary(visible);
  return (
    <figure className="rain" aria-label="Chance of rain over the coming hours">
      {rain.text ? (
        <figcaption className="rain__summary" data-rain={rain.kind}>
          {rain.text}
        </figcaption>
      ) : null}
      <div className="rain__bars" style={{ "--hours": visible.length } as CSSProperties}>
        {visible.map((hour) => {
          const chance = Math.round(hour.precipitationProbability ?? 0);
          return (
            <span
              key={hour.time}
              className="rain__bar"
              data-wet={chance >= 50}
              style={{ "--chance": `${Math.max(5, chance)}%` } as CSSProperties}
              title={`${hourLabel(hour.time)}: ${chance}% chance of rain`}
            />
          );
        })}
      </div>
      <div className="rain__axis" style={{ "--hours": visible.length } as CSSProperties} aria-hidden="true">
        {visible.map((hour, index) => (
          <span key={hour.time}>{index % 4 === 0 ? hourLabel(hour.time) : ""}</span>
        ))}
      </div>
    </figure>
  );
}
