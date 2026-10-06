/**
 * The sky: a continuous palette keyed to the sun, the sun on its real arc,
 * the moon with its true lit limb, a star field that is the same every
 * night, clouds that drift with the wind, rain as ink hatching, and fog.
 */

import { memo, useMemo, type CSSProperties } from "react";
import type { WeatherMood } from "../../lib/frame/weather.ts";
import {
  projectToSky,
  starField,
  type MoonIllumination,
  type SkyPalette,
  type SkyPosition,
} from "../../lib/frame/solar.ts";
const FRAME_WIDTH = 1200;
const FRAME_HEIGHT = 1920;

export const SKY_HORIZON = 0.6;

type SkyProps = {
  palette: SkyPalette;
  sun: SkyPosition;
  moon: SkyPosition;
  illumination: MoonIllumination;
  mood: WeatherMood;
  facing: number;
};

const STARS = starField(120, 11);

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

export const Sky = memo(function Sky({ palette, sun, moon, illumination, mood, facing }: SkyProps) {
  const sunSpot = projectToSky(sun, { facing, horizon: SKY_HORIZON });
  const moonSpot = projectToSky(moon, { facing, horizon: SKY_HORIZON });
  const sunLow = 1 - Math.min(1, Math.max(0, sun.elevation / 25));
  const sunSize = 72 + sunLow * 44;
  const cover = 1 - mood.cloud * 0.72 - mood.fog * 0.8;
  const moonPath = useMemo(() => moonLitPath(32, 32, 28, illumination.phase), [illumination.phase]);
  const cloudCount = Math.min(CLOUDS.length, Math.ceil(mood.cloud * CLOUDS.length + 0.001));
  const cloudStyle = {
    "--frame-wind": String(mood.wind),
    "--frame-wind-direction": String(mood.windDirection),
  } as CSSProperties;

  return (
    <>
      <div className="frame-sky" />
      <svg
        className="frame-stars"
        viewBox={`0 0 ${FRAME_WIDTH} ${FRAME_HEIGHT}`}
        preserveAspectRatio="xMidYMax slice"
        style={{ opacity: palette.stars * (1 - mood.cloud * 0.85) }}
        aria-hidden="true"
      >
        {STARS.map((star, index) => (
          <circle
            key={index}
            className={index % 3 === 0 ? "frame-star frame-star--twinkle" : "frame-star"}
            cx={star.x * FRAME_WIDTH}
            cy={star.y * FRAME_HEIGHT}
            r={star.size}
            style={index % 3 === 0 ? ({ "--delay": `${-star.twinkle * 9}s` } as CSSProperties) : undefined}
          />
        ))}
      </svg>
      {sunSpot.visible ? (
        <div
          className="frame-sun"
          style={{
            left: sunSpot.x * FRAME_WIDTH,
            top: sunSpot.y * FRAME_HEIGHT,
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
            left: moonSpot.x * FRAME_WIDTH,
            top: moonSpot.y * FRAME_HEIGHT,
            opacity: (0.28 + palette.darkness * 0.72) * Math.max(0.1, cover),
          }}
          aria-hidden="true"
        >
          <circle className="frame-moon__shadow" cx="32" cy="32" r="28" />
          <path className="frame-moon__lit" d={moonPath} />
        </svg>
      ) : null}
      <div className="frame-clouds" style={cloudStyle}>
        {CLOUDS.slice(0, cloudCount).map((cloud, index) => (
          <div
            key={index}
            className="frame-cloud"
            style={{
              top: cloud.top,
              width: cloud.width,
              height: cloud.height,
              opacity: 0.45 + mood.cloud * 0.5,
              "--cloud-factor": String(cloud.factor),
              "--cloud-delay": String(cloud.delay),
            } as CSSProperties}
          />
        ))}
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
