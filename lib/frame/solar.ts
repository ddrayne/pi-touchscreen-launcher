/**
 * Sun and moon arithmetic for the frame.
 *
 * Positions follow the standard low-precision formulae from Astronomical
 * Algorithms (Meeus) as popularised by Astronomy Answers. Accuracy is a few
 * arc-minutes, which is far finer than a painting needs. Everything is a pure
 * function of a timestamp so the scene can be scrubbed to any moment.
 */

const RAD = Math.PI / 180;
const DAY_MS = 86_400_000;
const J1970 = 2_440_588;
const J2000 = 2_451_545;
const OBLIQUITY = RAD * 23.4397;
const SUN_DISTANCE_KM = 149_598_000;

export type SkyPosition = {
  /** Degrees above the horizon; negative below it. */
  elevation: number;
  /** Compass degrees from north, clockwise, 0..360. */
  azimuth: number;
};

export type MoonIllumination = {
  /** Lit fraction of the disc, 0..1. */
  fraction: number;
  /** 0 new, 0.25 first quarter, 0.5 full, 0.75 last quarter. */
  phase: number;
  /** Position angle of the bright limb, radians. */
  angle: number;
};

export type SunTimes = {
  solarNoon: number;
  nadir: number;
  sunrise: number;
  sunset: number;
  /** Civil twilight begins, sun at -6°. */
  dawn: number;
  dusk: number;
  nauticalDawn: number;
  nauticalDusk: number;
  /** Astronomical night ends and begins, sun at -18°. NaN in a northern summer. */
  nightEnd: number;
  night: number;
};

function toDays(at: number): number {
  return at / DAY_MS - 0.5 + J1970 - J2000;
}

function fromJulian(julian: number): number {
  return (julian + 0.5 - J1970) * DAY_MS;
}

function rightAscension(l: number, b: number): number {
  return Math.atan2(
    Math.sin(l) * Math.cos(OBLIQUITY) - Math.tan(b) * Math.sin(OBLIQUITY),
    Math.cos(l),
  );
}

function declination(l: number, b: number): number {
  return Math.asin(
    Math.sin(b) * Math.cos(OBLIQUITY) + Math.cos(b) * Math.sin(OBLIQUITY) * Math.sin(l),
  );
}

function azimuthFromSouth(hourAngle: number, phi: number, dec: number): number {
  return Math.atan2(
    Math.sin(hourAngle),
    Math.cos(hourAngle) * Math.sin(phi) - Math.tan(dec) * Math.cos(phi),
  );
}

function altitude(hourAngle: number, phi: number, dec: number): number {
  return Math.asin(
    Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(hourAngle),
  );
}

function siderealTime(days: number, lw: number): number {
  return RAD * (280.16 + 360.9856235 * days) - lw;
}

function solarMeanAnomaly(days: number): number {
  return RAD * (357.5291 + 0.98560028 * days);
}

function eclipticLongitude(meanAnomaly: number): number {
  const centre =
    RAD *
    (1.9148 * Math.sin(meanAnomaly) +
      0.02 * Math.sin(2 * meanAnomaly) +
      0.0003 * Math.sin(3 * meanAnomaly));
  const perihelion = RAD * 102.9372;
  return meanAnomaly + centre + perihelion + Math.PI;
}

function sunCoords(days: number): { dec: number; ra: number } {
  const meanAnomaly = solarMeanAnomaly(days);
  const longitude = eclipticLongitude(meanAnomaly);
  return { dec: declination(longitude, 0), ra: rightAscension(longitude, 0) };
}

function moonCoords(days: number): { dec: number; ra: number; distance: number } {
  const L = RAD * (218.316 + 13.176396 * days);
  const M = RAD * (134.963 + 13.064993 * days);
  const F = RAD * (93.272 + 13.22935 * days);
  const l = L + RAD * 6.289 * Math.sin(M);
  const b = RAD * 5.128 * Math.sin(F);
  const distance = 385_001 - 20_905 * Math.cos(M);
  return { ra: rightAscension(l, b), dec: declination(l, b), distance };
}

function toCompass(azimuthFromSouthRadians: number): number {
  const degrees = azimuthFromSouthRadians / RAD + 180;
  return ((degrees % 360) + 360) % 360;
}

export function sunPosition(at: number, latitude: number, longitude: number): SkyPosition {
  const lw = RAD * -longitude;
  const phi = RAD * latitude;
  const days = toDays(at);
  const coords = sunCoords(days);
  const hourAngle = siderealTime(days, lw) - coords.ra;
  return {
    elevation: altitude(hourAngle, phi, coords.dec) / RAD,
    azimuth: toCompass(azimuthFromSouth(hourAngle, phi, coords.dec)),
  };
}

export function moonPosition(
  at: number,
  latitude: number,
  longitude: number,
): SkyPosition & { distance: number } {
  const lw = RAD * -longitude;
  const phi = RAD * latitude;
  const days = toDays(at);
  const coords = moonCoords(days);
  const hourAngle = siderealTime(days, lw) - coords.ra;
  let elevation = altitude(hourAngle, phi, coords.dec);
  // Refraction lifts the moon slightly near the horizon.
  elevation += (RAD * 0.017) / Math.tan(elevation + (RAD * 10.26) / (elevation + RAD * 5.10));
  return {
    elevation: elevation / RAD,
    azimuth: toCompass(azimuthFromSouth(hourAngle, phi, coords.dec)),
    distance: coords.distance,
  };
}

export function moonIllumination(at: number): MoonIllumination {
  const days = toDays(at);
  const sun = sunCoords(days);
  const moon = moonCoords(days);
  const phi = Math.acos(
    Math.sin(sun.dec) * Math.sin(moon.dec) +
      Math.cos(sun.dec) * Math.cos(moon.dec) * Math.cos(sun.ra - moon.ra),
  );
  const inclination = Math.atan2(
    SUN_DISTANCE_KM * Math.sin(phi),
    moon.distance - SUN_DISTANCE_KM * Math.cos(phi),
  );
  const angle = Math.atan2(
    Math.cos(sun.dec) * Math.sin(sun.ra - moon.ra),
    Math.sin(sun.dec) * Math.cos(moon.dec) -
      Math.cos(sun.dec) * Math.sin(moon.dec) * Math.cos(sun.ra - moon.ra),
  );
  return {
    fraction: (1 + Math.cos(inclination)) / 2,
    phase: 0.5 + (0.5 * inclination * (angle < 0 ? -1 : 1)) / Math.PI,
    angle,
  };
}

const J0 = 0.0009;

function julianCycle(days: number, lw: number): number {
  return Math.round(days - J0 - lw / (2 * Math.PI));
}

function approxTransit(hourAngle: number, lw: number, cycle: number): number {
  return J0 + (hourAngle + lw) / (2 * Math.PI) + cycle;
}

function solarTransitJ(ds: number, meanAnomaly: number, longitude: number): number {
  return J2000 + ds + 0.0053 * Math.sin(meanAnomaly) - 0.0069 * Math.sin(2 * longitude);
}

function hourAngleFor(h: number, phi: number, dec: number): number {
  return Math.acos(
    (Math.sin(h) - Math.sin(phi) * Math.sin(dec)) / (Math.cos(phi) * Math.cos(dec)),
  );
}

export function sunTimes(at: number, latitude: number, longitude: number): SunTimes {
  const lw = RAD * -longitude;
  const phi = RAD * latitude;
  const days = toDays(at);
  const cycle = julianCycle(days, lw);
  const ds = approxTransit(0, lw, cycle);
  const meanAnomaly = solarMeanAnomaly(ds);
  const longitudeEcliptic = eclipticLongitude(meanAnomaly);
  const dec = declination(longitudeEcliptic, 0);
  const noon = solarTransitJ(ds, meanAnomaly, longitudeEcliptic);

  const pair = (angleDegrees: number): [number, number] => {
    const w = hourAngleFor(angleDegrees * RAD, phi, dec);
    if (Number.isNaN(w)) return [Number.NaN, Number.NaN];
    const set = solarTransitJ(approxTransit(w, lw, cycle), meanAnomaly, longitudeEcliptic);
    const rise = noon - (set - noon);
    return [fromJulian(rise), fromJulian(set)];
  };

  const [sunrise, sunset] = pair(-0.833);
  const [dawn, dusk] = pair(-6);
  const [nauticalDawn, nauticalDusk] = pair(-12);
  const [nightEnd, night] = pair(-18);
  return {
    solarNoon: fromJulian(noon),
    nadir: fromJulian(noon - 0.5),
    sunrise,
    sunset,
    dawn,
    dusk,
    nauticalDawn,
    nauticalDusk,
    nightEnd,
    night,
  };
}

/** True when the sun is climbing, used to warm dawn differently from dusk. */
export function sunIsRising(at: number, latitude: number, longitude: number): boolean {
  const before = sunPosition(at - 60_000, latitude, longitude).elevation;
  const after = sunPosition(at + 60_000, latitude, longitude).elevation;
  return after > before;
}

export type Rgb = [number, number, number];

export type SkyPalette = {
  zenith: Rgb;
  mid: Rgb;
  horizon: Rgb;
  glow: Rgb;
  /** Ink colour for silhouettes and type over the sky. */
  ink: Rgb;
  /** 0 full day .. 1 deep night. */
  darkness: number;
  /** Star visibility 0..1. */
  stars: number;
};

type PaletteStop = {
  elevation: number;
  zenith: Rgb;
  mid: Rgb;
  horizon: Rgb;
  glow: Rgb;
};

// Woodblock, not weather app: indigo at night, paper and a pale print blue by day.
const PALETTE: PaletteStop[] = [
  { elevation: -24, zenith: [11, 14, 34], mid: [18, 22, 50], horizon: [32, 36, 70], glow: [44, 46, 82] },
  { elevation: -14, zenith: [14, 19, 46], mid: [26, 32, 70], horizon: [52, 54, 96], glow: [84, 70, 102] },
  { elevation: -8, zenith: [28, 36, 78], mid: [58, 68, 118], horizon: [138, 102, 112], glow: [206, 142, 112] },
  { elevation: -4, zenith: [50, 70, 118], mid: [112, 126, 166], horizon: [214, 160, 128], glow: [242, 184, 128] },
  { elevation: 0, zenith: [84, 118, 160], mid: [160, 178, 198], horizon: [238, 206, 160], glow: [250, 222, 168] },
  { elevation: 6, zenith: [108, 146, 184], mid: [186, 202, 214], horizon: [238, 226, 200], glow: [250, 238, 206] },
  { elevation: 16, zenith: [126, 164, 198], mid: [202, 214, 222], horizon: [236, 230, 214], glow: [248, 244, 228] },
  { elevation: 45, zenith: [140, 178, 208], mid: [212, 222, 228], horizon: [238, 234, 220], glow: [250, 247, 236] },
];

const DAY_INK: Rgb = [22, 42, 36];
const NIGHT_INK: Rgb = [236, 228, 206];

export function mixRgb(a: Rgb, b: Rgb, t: number): Rgb {
  const k = clamp(t, 0, 1);
  return [
    Math.round(a[0] + (b[0] - a[0]) * k),
    Math.round(a[1] + (b[1] - a[1]) * k),
    Math.round(a[2] + (b[2] - a[2]) * k),
  ];
}

export function rgbCss([r, g, b]: Rgb, alpha = 1): string {
  return alpha >= 1 ? `rgb(${r} ${g} ${b})` : `rgb(${r} ${g} ${b} / ${alpha})`;
}

export function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

export function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

export function skyPalette(elevation: number, rising = false): SkyPalette {
  const e = clamp(elevation, PALETTE[0].elevation, PALETTE[PALETTE.length - 1].elevation);
  let lower = PALETTE[0];
  let upper = PALETTE[PALETTE.length - 1];
  for (let index = 0; index < PALETTE.length - 1; index += 1) {
    if (e >= PALETTE[index].elevation && e <= PALETTE[index + 1].elevation) {
      lower = PALETTE[index];
      upper = PALETTE[index + 1];
      break;
    }
  }
  const span = upper.elevation - lower.elevation || 1;
  const t = smoothstep(0, 1, (e - lower.elevation) / span);
  let horizon = mixRgb(lower.horizon, upper.horizon, t);
  let glow = mixRgb(lower.glow, upper.glow, t);
  // Dawn leans rose and violet; dusk leans amber.
  const twilight = 1 - smoothstep(0, 6, Math.abs(elevation + 1));
  if (twilight > 0) {
    const tint: Rgb = rising ? [222, 160, 172] : [236, 164, 96];
    horizon = mixRgb(horizon, tint, twilight * 0.28);
    glow = mixRgb(glow, tint, twilight * 0.22);
  }
  const darkness = 1 - smoothstep(-16, 2, elevation);
  return {
    zenith: mixRgb(lower.zenith, upper.zenith, t),
    mid: mixRgb(lower.mid, upper.mid, t),
    horizon,
    glow,
    ink: mixRgb(DAY_INK, NIGHT_INK, smoothstep(-9, -2, -elevation)),
    darkness,
    stars: 1 - smoothstep(-15, -4, elevation),
  };
}

export type SkyProjection = {
  /** Fraction of the painting width, may fall outside 0..1. */
  x: number;
  /** Fraction of the painting height. */
  y: number;
  visible: boolean;
};

/**
 * Projects a sky position onto the painting as if looking out of a window.
 * `facing` is the compass direction the window faces; `horizon` the fraction
 * of the painting height where the skyline sits.
 */
export function projectToSky(
  position: SkyPosition,
  options: { facing?: number; horizon?: number; span?: number } = {},
): SkyProjection {
  const facing = options.facing ?? 180;
  const horizon = options.horizon ?? 0.64;
  const span = options.span ?? 180;
  let delta = position.azimuth - facing;
  while (delta > 180) delta -= 360;
  while (delta < -180) delta += 360;
  const x = 0.5 + delta / span;
  const lift = clamp(position.elevation, -12, 62) / 62;
  const y = horizon - lift * (horizon - 0.04);
  return { x, y, visible: position.elevation > -4 && x > -0.2 && x < 1.2 };
}

export function moonPhaseName(phase: number): string {
  if (phase < 0.03 || phase > 0.97) return "new moon";
  if (phase < 0.22) return "waxing crescent";
  if (phase < 0.28) return "first quarter";
  if (phase < 0.47) return "waxing gibbous";
  if (phase < 0.53) return "full moon";
  if (phase < 0.72) return "waning gibbous";
  if (phase < 0.78) return "last quarter";
  return "waning crescent";
}

/** "52 min before sunrise", "2 h after sunset", or "" by day. */
export function daylightLabel(at: number, times: SunTimes): string {
  const describe = (minutes: number, event: string): string => {
    const magnitude = Math.abs(Math.round(minutes));
    const unit =
      magnitude >= 120 ? `${Math.round(magnitude / 60)} h` : `${magnitude} min`;
    return `${unit} ${minutes < 0 ? "before" : "after"} ${event}`;
  };
  if (Number.isNaN(times.sunrise) || Number.isNaN(times.sunset)) return "";
  if (at < times.sunrise) {
    const minutes = (at - times.sunrise) / 60_000;
    return minutes > -6 * 60 ? describe(minutes, "sunrise") : "";
  }
  if (at > times.sunset) {
    const minutes = (at - times.sunset) / 60_000;
    return minutes < 6 * 60 ? describe(minutes, "sunset") : "";
  }
  return "";
}

/** A deterministic star field so the same stars appear every night. */
export type Star = { x: number; y: number; size: number; twinkle: number };

export function starField(count: number, seed = 7): Star[] {
  let state = seed >>> 0;
  const next = () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
  const stars: Star[] = [];
  for (let index = 0; index < count; index += 1) {
    const y = next();
    stars.push({
      x: next(),
      // Fewer stars near the horizon, as in the sky.
      y: y * y * 0.75,
      size: 0.6 + next() * next() * 2.2,
      twinkle: next(),
    });
  }
  return stars;
}
