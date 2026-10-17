/**
 * The sky: a continuous palette keyed to the sun, the sun on its real arc,
 * the moon with its true lit limb, a star field that is the same every
 * night, clouds that drift with the wind, rain as ink hatching, and fog.
 *
 * Nothing here moves smoothly. On the Pi one smooth animation anywhere,
 * however small, has the compositor redraw the whole layered sky every
 * frame (a third of the machine); a stepped one costs only its steps. So
 * the stars twinkle in a few steps on a slow tick, the clouds and the rain
 * advance in steps, and the sun and moon jump the fraction of a pixel they
 * move in five seconds.
 */

import { memo, useMemo, type CSSProperties } from "react";
import type { WeatherMood } from "../../lib/frame/weather.ts";
import {
  projectToSky,
  starField,
  twinkleSet,
  type MoonIllumination,
  type SkyPalette,
  type SkyPosition,
} from "../../lib/frame/solar.ts";
const FRAME_WIDTH = 1200;
const FRAME_HEIGHT = 1920;

export const SKY_HORIZON = 0.6;

type SkyProps = {
  /** The five-second tick the sky is drawn on. */
  tick: number;
  palette: SkyPalette;
  sun: SkyPosition;
  moon: SkyPosition;
  illumination: MoonIllumination;
  mood: WeatherMood;
  facing: number;
};

const STARS = starField(120, 11);
/** Every third star twinkles; they live outside the SVG so each is its own small layer. */
const TWINKLES = STARS.filter((_, index) => index % 3 === 0);
/** How often the bright stars change, and how many are bright at once. */
const TWINKLE_MS = 10_000;
const TWINKLE_BRIGHT = 6;
/** A cloud moves in steps this far apart in time; the drift between is not drawn. */
const CLOUD_STEP_S = 3;
const CLOUD_DRIFT_S = 260;

/** The lit part of the moon as an SVG path, for a disc of radius r at (cx, cy). */
function moonLitPath(cx: number, cy: number, r: number, phase: number): string {
  const waxing = phase <= 0.5;
  const terminator = Math.abs(Math.cos(2 * Math.PI * phase)) * r;
  const crescent = waxing ? phase < 0.25 : phase > 0.75;
  // Northern hemisphere: a waxing moon is lit on the right.
  const litSweep = waxing ? 1 : 0;
  const terminatorSweep = crescent ? litSweep : 1 - litSweep;
  return [
    `M ${cx} ${cy - r}`,
    `A ${r} ${r} 0 0 ${litSweep} ${cx} ${cy + r}`,
    `A ${terminator.toFixed(2)} ${r} 0 0 ${terminatorSweep} ${cx} ${cy - r}`,
    "Z",
  ].join(" ");
}

const CLOUDS = [
  { top: 110, width: 620, height: 170, factor: 1.08, delay: 0.05 },
  { top: 330, width: 540, height: 150, factor: 0.86, delay: 0.42 },
  { top: 220, width: 720, height: 190, factor: 1.24, delay: 0.71 },
  { top: 520, width: 480, height: 130, factor: 0.94, delay: 0.21 },
  { top: 700, width: 640, height: 160, factor: 1.16, delay: 0.58 },
  { top: 860, width: 560, height: 140, factor: 0.8, delay: 0.88 },
  { top: 430, width: 400, height: 110, factor: 1.32, delay: 0.33 },
];

export const Sky = memo(function Sky({ tick, palette, sun, moon, illumination, mood, facing }: SkyProps) {
  const sunSpot = projectToSky(sun, { facing, horizon: SKY_HORIZON });
  const moonSpot = projectToSky(moon, { facing, horizon: SKY_HORIZON });
  const sunLow = 1 - Math.min(1, Math.max(0, sun.elevation / 25));
  const sunSize = 72 + sunLow * 44;
  const cover = 1 - mood.cloud * 0.72 - mood.fog * 0.8;
  const moonPath = useMemo(() => moonLitPath(32, 32, 28, illumination.phase), [illumination.phase]);
  const cloudCount = Math.min(CLOUDS.length, Math.ceil(mood.cloud * CLOUDS.length + 0.001));
  // An invisible star field is not painted, so Chromium cannot hand its
  // twinkle to the compositor and would run forty animations on the main
  // thread all day for nothing. Stars exist only once the sky is dark enough.
  const starOpacity = palette.stars * (1 - mood.cloud * 0.85);
  const starsVisible = starOpacity > 0.02;
  const twinkleTick = Math.floor(tick / TWINKLE_MS);
  const bright = useMemo(() => twinkleSet(twinkleTick, TWINKLES.length, TWINKLE_BRIGHT), [twinkleTick]);
  const cloudStyle = {
    "--frame-wind-direction": String(mood.windDirection),
  } as CSSProperties;
  const windRate = 0.18 + mood.wind * 1.4;

  return (
    <>
      <div className="frame-sky" />
      {starsVisible ? (
        <svg
          className="frame-stars"
          viewBox={`0 0 ${FRAME_WIDTH} ${FRAME_HEIGHT}`}
          preserveAspectRatio="xMidYMax slice"
          style={{ opacity: starOpacity }}
          aria-hidden="true"
        >
          {STARS.map((star, index) =>
            index % 3 === 0 ? null : (
              <circle
                key={index}
                className="frame-star"
                cx={star.x * FRAME_WIDTH}
                cy={star.y * FRAME_HEIGHT}
                r={star.size}
              />
            ),
          )}
        </svg>
      ) : null}
      {starsVisible ? (
        <div className="frame-twinkles" style={{ opacity: starOpacity }} aria-hidden="true">
          {TWINKLES.map((star, index) => (
            <i
              key={index}
              className="frame-twinkle"
              data-bright={bright.has(index)}
              style={{
                left: star.x * FRAME_WIDTH - star.size,
                top: star.y * FRAME_HEIGHT - star.size,
                width: star.size * 2,
                height: star.size * 2,
              }}
            />
          ))}
        </div>
      ) : null}
      {sunSpot.visible ? (
        <div
          className="frame-sun"
          style={{
            "--sky-x": `${(sunSpot.x * FRAME_WIDTH).toFixed(1)}px`,
            "--sky-y": `${(sunSpot.y * FRAME_HEIGHT).toFixed(1)}px`,
            opacity: Math.max(0.1, cover) * 0.7,
            "--sun-size": `${sunSize}px`,
            "--sun-low": String(sunLow),
          } as CSSProperties}
        />
      ) : null}
      {moonSpot.visible ? (
        <svg
          className="frame-moon"
          viewBox="0 0 64 64"
          style={{
            "--sky-x": `${(moonSpot.x * FRAME_WIDTH).toFixed(1)}px`,
            "--sky-y": `${(moonSpot.y * FRAME_HEIGHT).toFixed(1)}px`,
            opacity: (0.28 + palette.darkness * 0.72) * Math.max(0.1, cover),
          } as CSSProperties}
          aria-hidden="true"
        >
          <circle className="frame-moon__shadow" cx="32" cy="32" r="28" />
          <path className="frame-moon__lit" d={moonPath} />
        </svg>
      ) : null}
      <div className="frame-clouds" style={cloudStyle}>
        {CLOUDS.slice(0, cloudCount).map((cloud, index) => {
          const driftS = (cloud.factor * CLOUD_DRIFT_S) / windRate;
          return (
            <div
              key={index}
              className="frame-cloud"
              style={{
                top: cloud.top,
                width: cloud.width,
                height: cloud.height,
                opacity: 0.45 + mood.cloud * 0.5,
                "--cloud-drift": `${driftS.toFixed(1)}s`,
                "--cloud-steps": String(Math.max(1, Math.round(driftS / CLOUD_STEP_S))),
                "--cloud-delay": `${(-cloud.delay * driftS).toFixed(1)}s`,
              } as CSSProperties}
            />
          );
        })}
      </div>
      {mood.rain > 0 || mood.snow > 0 ? (
        <div className="frame-rain" style={{ opacity: mood.rain * 0.26 + mood.snow * 0.3 }} data-snow={mood.snow > 0}>
          <div className="frame-rain__sheet" />
        </div>
      ) : null}
      {mood.fog > 0 ? <div className="frame-fog" style={{ opacity: mood.fog * 0.55 }} /> : null}
    </>
  );
});
