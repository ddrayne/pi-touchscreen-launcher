/**
 * Weather as a decision rather than a number: the broker supplies Open-Meteo's
 * hourly forecast, and this turns it into "Rain from 2pm" plus a strip of bars.
 */

export type HourForecast = {
  time: string;
  temperature: number | null;
  precipitationProbability: number | null;
  precipitation: number | null;
  weatherCode: number | null;
};

export type WeatherSnapshot = {
  now: { temperature: number | null; weatherCode: number | null; isDay: boolean } | null;
  today: {
    high: number | null;
    low: number | null;
    sunrise: string | null;
    sunset: string | null;
  } | null;
  hours: HourForecast[];
  updatedAt?: string;
  stale?: boolean;
};

export type RainSummary = {
  kind: "now" | "later" | "showers" | "dry" | "unknown";
  text: string;
};

/** "2026-10-06T14:00" → "2pm"; midday and midnight are spelled out. */
export function hourLabel(time: string): string {
  const match = time.match(/T(\d{2}):(\d{2})/) ?? time.match(/^(\d{2}):(\d{2})/);
  if (!match) return time;
  const hour = Number(match[1]);
  if (hour === 0) return "midnight";
  if (hour === 12) return "midday";
  return hour < 12 ? `${hour}am` : `${hour - 12}pm`;
}

/** "2026-10-06T18:41" → "18:41" */
export function clockTime(time: string | null | undefined): string | null {
  const match = time?.match(/T(\d{2}:\d{2})/);
  return match ? match[1] : null;
}

/**
 * Drops forecast hours that are already over. Open-Meteo reports local wall
 * time without an offset, and the screen runs in the same house, so the hours
 * are read as local time.
 */
export function upcomingHours(hours: HourForecast[], now: Date): HourForecast[] {
  return hours.filter((hour) => {
    const match = hour.time.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
    if (!match) return true;
    const [, year, month, day, hourOfDay, minute] = match.map(Number);
    const start = new Date(year, month - 1, day, hourOfDay, minute);
    return start.getTime() + 60 * 60_000 > now.getTime();
  });
}

/** How far ahead the screen looks: from breakfast it reaches the evening. */
export const FORECAST_HOURS = 16;
const RAIN_THRESHOLD = 50;
const SHOWER_THRESHOLD = 25;

export function rainSummary(hours: HourForecast[]): RainSummary {
  const ahead = hours.slice(0, FORECAST_HOURS);
  if (!ahead.length) return { kind: "unknown", text: "" };
  const wet = ahead.map((hour) => (hour.precipitationProbability ?? 0) >= RAIN_THRESHOLD);
  const start = wet.indexOf(true);
  if (start === 0) {
    const end = wet.indexOf(false);
    return end === -1
      ? { kind: "now", text: "Rain all day" }
      : { kind: "now", text: `Rain until ${hourLabel(ahead[end].time)}` };
  }
  if (start > 0) {
    return { kind: "later", text: `Rain from ${hourLabel(ahead[start].time)}` };
  }
  const highest = Math.max(...ahead.map((hour) => hour.precipitationProbability ?? 0));
  return highest >= SHOWER_THRESHOLD
    ? { kind: "showers", text: "A shower is possible" }
    : { kind: "dry", text: "Dry" };
}

/** WMO weather interpretation codes, as Open-Meteo reports them. */
export function describeWeather(code: number | null | undefined): string {
  if (code === null || code === undefined) return "";
  if (code === 0) return "Clear";
  if (code <= 2) return "Bright spells";
  if (code === 3) return "Cloudy";
  if (code === 45 || code === 48) return "Fog";
  if (code >= 51 && code <= 57) return "Drizzle";
  if (code >= 61 && code <= 67) return "Rain";
  if (code >= 71 && code <= 77) return "Snow";
  if (code >= 80 && code <= 82) return "Showers";
  if (code === 85 || code === 86) return "Snow showers";
  if (code >= 95) return "Thunder";
  return "";
}

export function formatTemperature(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? `${Math.round(value)}°` : "–";
}
