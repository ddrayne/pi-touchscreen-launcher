/**
 * Turns the Home Assistant weather entity the household hub already reads into
 * a mood the painting can draw. No weather means a clear, still sky.
 */

export type HubWeather = {
  condition?: string;
  temperature?: number | null;
  cloudCoverage?: number | null;
  windSpeed?: number | null;
  windSpeedUnit?: string | null;
  windBearing?: number | null;
};

export type WeatherMood = {
  /** 0 clear .. 1 overcast. */
  cloud: number;
  /** 0 still .. 1 gale, roughly metres per second over fifteen. */
  wind: number;
  /** -1 blowing right to left, +1 left to right, as seen from the window. */
  windDirection: number;
  /** 0 dry .. 1 pouring. */
  rain: number;
  snow: number;
  fog: number;
  lightning: boolean;
  frost: boolean;
  condition: string;
};

const STILL: WeatherMood = {
  cloud: 0.08,
  wind: 0.12,
  windDirection: 1,
  rain: 0,
  snow: 0,
  fog: 0,
  lightning: false,
  frost: false,
  condition: "unknown",
};

const CONDITION_CLOUD: Record<string, number> = {
  "clear-night": 0.05,
  sunny: 0.08,
  partlycloudy: 0.45,
  cloudy: 0.92,
  fog: 0.75,
  rainy: 0.95,
  pouring: 1,
  "lightning-rainy": 1,
  lightning: 0.85,
  hail: 0.95,
  snowy: 0.95,
  "snowy-rainy": 0.98,
  windy: 0.4,
  "windy-variant": 0.7,
  exceptional: 0.3,
};

function windMetresPerSecond(speed: number, unit: string | null | undefined): number {
  const normalized = (unit || "km/h").toLowerCase();
  if (normalized === "m/s") return speed;
  if (normalized === "mph") return speed * 0.44704;
  if (normalized === "kn" || normalized === "knots") return speed * 0.514444;
  if (normalized === "ft/s") return speed * 0.3048;
  return speed / 3.6;
}

export function weatherMood(
  weather: HubWeather | null | undefined,
  facing = 180,
): WeatherMood {
  if (!weather || !weather.condition) return STILL;
  const condition = weather.condition.toLowerCase();
  const cloud =
    typeof weather.cloudCoverage === "number"
      ? Math.min(1, Math.max(0, weather.cloudCoverage / 100))
      : (CONDITION_CLOUD[condition] ?? 0.3);
  let wind = condition.startsWith("windy") ? 0.7 : 0.12;
  if (typeof weather.windSpeed === "number") {
    wind = Math.min(1, Math.max(0, windMetresPerSecond(weather.windSpeed, weather.windSpeedUnit) / 15));
  }
  let windDirection = 1;
  if (typeof weather.windBearing === "number") {
    // Wind blows toward bearing + 180. Looking out of the window, anything
    // heading to the right of `facing` moves left-to-right on the painting.
    let toward = weather.windBearing + 180 - facing;
    while (toward > 180) toward -= 360;
    while (toward < -180) toward += 360;
    windDirection = toward >= 0 ? 1 : -1;
  }
  const rain =
    condition === "pouring"
      ? 1
      : condition === "lightning-rainy" || condition === "hail"
        ? 0.75
        : condition === "rainy" || condition === "snowy-rainy"
          ? 0.5
          : 0;
  const snow = condition === "snowy" ? 0.7 : condition === "snowy-rainy" ? 0.35 : 0;
  return {
    cloud,
    wind,
    windDirection,
    rain,
    snow,
    fog: condition === "fog" ? 1 : 0,
    lightning: condition.startsWith("lightning"),
    frost: typeof weather.temperature === "number" && weather.temperature <= 0,
    condition,
  };
}

export type ForecastDay = {
  /** ISO date or datetime of the day. */
  date: string;
  condition: string;
  high: number | null;
  low: number | null;
  /** Chance of precipitation, 0..100, when known. */
  precipitation: number | null;
  windSpeed: number | null;
};

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Normalises the broker's forecast (or Home Assistant's own shape) into days. */
export function parseForecast(raw: unknown): ForecastDay[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry): ForecastDay[] => {
    if (!entry || typeof entry !== "object") return [];
    const record = entry as Record<string, unknown>;
    const date = record.date ?? record.datetime;
    if (typeof date !== "string" || !date) return [];
    return [
      {
        date,
        condition: typeof record.condition === "string" ? record.condition.toLowerCase() : "unknown",
        high: numberOrNull(record.high ?? record.temperature),
        low: numberOrNull(record.low ?? record.templow),
        precipitation: numberOrNull(record.precipitation ?? record.precipitation_probability),
        windSpeed: numberOrNull(record.windSpeed ?? record.wind_speed),
      },
    ];
  });
}

export type WeatherGlyphId =
  | "sun"
  | "partly"
  | "cloud"
  | "rain"
  | "pour"
  | "snow"
  | "fog"
  | "storm"
  | "wind"
  | "night"
  | "unknown";

export function weatherGlyph(condition: string | undefined, night = false): WeatherGlyphId {
  const value = (condition || "").toLowerCase();
  if (value === "clear-night") return "night";
  if (value === "sunny") return night ? "night" : "sun";
  if (value === "partlycloudy") return "partly";
  if (value === "cloudy") return "cloud";
  if (value === "pouring") return "pour";
  if (value === "rainy" || value === "snowy-rainy" || value === "hail") return "rain";
  if (value === "snowy") return "snow";
  if (value === "fog") return "fog";
  if (value.startsWith("lightning")) return "storm";
  if (value.startsWith("windy")) return "wind";
  if (value === "exceptional") return "sun";
  return "unknown";
}

const CONDITION_WORDS: Record<string, string> = {
  "clear-night": "Clear",
  sunny: "Sunny",
  partlycloudy: "Partly cloudy",
  cloudy: "Cloudy",
  fog: "Fog",
  hail: "Hail",
  lightning: "Thunder",
  "lightning-rainy": "Thundery rain",
  pouring: "Heavy rain",
  rainy: "Rain",
  snowy: "Snow",
  "snowy-rainy": "Sleet",
  windy: "Windy",
  "windy-variant": "Windy",
  exceptional: "Unusual",
};

export function conditionWord(condition: string | undefined): string {
  if (!condition) return "";
  return CONDITION_WORDS[condition.toLowerCase()] ?? condition.replace(/-/g, " ");
}

/** "Today", "Tomorrow", then the weekday. */
export function forecastDayLabel(date: string, now: number): string {
  const day = new Date(date);
  if (Number.isNaN(day.getTime())) return "";
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const target = new Date(day);
  target.setHours(0, 0, 0, 0);
  const difference = Math.round((target.getTime() - start.getTime()) / 86_400_000);
  if (difference === 0) return "Today";
  if (difference === 1) return "Tomorrow";
  return new Intl.DateTimeFormat("en-GB", { weekday: "short" }).format(day);
}
