import assert from "node:assert/strict";
import test from "node:test";

import {
  daylightLabel,
  moonIllumination,
  projectToSky,
  skyPalette,
  starField,
  twinkleSet,
  sunPosition,
  sunTimes,
} from "../lib/frame/solar.ts";

const EDINBURGH = { lat: 55.95, lng: -3.19 };

test("the midsummer sun stands high in the south at noon over Edinburgh", () => {
  const at = Date.UTC(2026, 5, 21, 12, 0, 0);
  const sun = sunPosition(at, EDINBURGH.lat, EDINBURGH.lng);
  assert.ok(sun.elevation > 56.3 && sun.elevation < 57.7, `elevation ${sun.elevation}`);
  assert.ok(sun.azimuth > 168 && sun.azimuth < 186, `azimuth ${sun.azimuth}`);
});

test("the midwinter sun barely clears the roofs", () => {
  const at = Date.UTC(2026, 11, 21, 12, 0, 0);
  const sun = sunPosition(at, EDINBURGH.lat, EDINBURGH.lng);
  assert.ok(sun.elevation > 9.6 && sun.elevation < 11, `elevation ${sun.elevation}`);
});

test("sunrise and astronomical night follow the season", () => {
  const june = sunTimes(Date.UTC(2026, 5, 21, 12), EDINBURGH.lat, EDINBURGH.lng);
  const expectedSunrise = Date.UTC(2026, 5, 21, 3, 26);
  assert.ok(Math.abs(june.sunrise - expectedSunrise) < 12 * 60_000, new Date(june.sunrise).toISOString());
  assert.ok(Number.isNaN(june.night), "Edinburgh has no astronomical night in June");
  const december = sunTimes(Date.UTC(2026, 11, 21, 12), EDINBURGH.lat, EDINBURGH.lng);
  assert.ok(Number.isFinite(december.night));
  assert.ok(december.sunset < Date.UTC(2026, 11, 21, 16), new Date(december.sunset).toISOString());
});

test("the moon is full on 3 March 2026", () => {
  const illumination = moonIllumination(Date.UTC(2026, 2, 3, 12));
  assert.ok(illumination.fraction > 0.97, `fraction ${illumination.fraction}`);
  const newMoon = moonIllumination(Date.UTC(2026, 1, 17, 12));
  assert.ok(newMoon.fraction < 0.04, `fraction ${newMoon.fraction}`);
});

test("the palette darkens continuously and stars fade through twilight", () => {
  let previous = skyPalette(50).darkness;
  for (let elevation = 48; elevation >= -24; elevation -= 2) {
    const palette = skyPalette(elevation);
    assert.ok(palette.darkness >= previous - 1e-9, `darkness at ${elevation}`);
    previous = palette.darkness;
  }
  assert.equal(skyPalette(10).stars, 0);
  assert.equal(skyPalette(-18).stars, 1);
  assert.ok(skyPalette(-9).stars > 0.2 && skyPalette(-9).stars < 0.9);
  const day = skyPalette(30);
  const night = skyPalette(-20);
  assert.ok(day.ink[0] < 60, "day ink is dark");
  assert.ok(night.ink[0] > 200, "night ink is light");
  assert.ok(night.zenith[2] > night.zenith[0], "night sky is blue, not grey");
});

test("projection puts south in the middle and the horizon where asked", () => {
  const south = projectToSky({ azimuth: 180, elevation: 0 }, { facing: 180, horizon: 0.6 });
  assert.ok(Math.abs(south.x - 0.5) < 1e-9);
  assert.ok(Math.abs(south.y - 0.6) < 1e-9);
  const east = projectToSky({ azimuth: 90, elevation: 30 }, { facing: 180 });
  assert.ok(east.x < 0.01 && east.x > -0.01);
  assert.ok(east.y < 0.6);
  const behind = projectToSky({ azimuth: 0, elevation: 20 }, { facing: 180 });
  assert.equal(behind.visible, false);
  const below = projectToSky({ azimuth: 180, elevation: -10 }, { facing: 180 });
  assert.equal(below.visible, false);
});

test("daylight labels count toward the nearest edge of the day", () => {
  const times = sunTimes(Date.UTC(2026, 5, 21, 12), EDINBURGH.lat, EDINBURGH.lng);
  assert.equal(daylightLabel(times.sunrise - 52 * 60_000, times), "52 min before sunrise");
  assert.equal(daylightLabel(times.sunset + 3 * 60 * 60_000, times), "3 h after sunset");
  assert.equal(daylightLabel(times.solarNoon, times), "");
});

test("the star field is the same every night", () => {
  const first = starField(40, 3);
  const second = starField(40, 3);
  assert.deepEqual(first, second);
  assert.ok(first.every((star) => star.x >= 0 && star.x <= 1 && star.y >= 0 && star.y <= 0.75));
});

test("the bright stars are a few, chosen by the tick alone, and change between ticks", () => {
  const first = twinkleSet(1234, 40, 6);
  assert.equal(first.size, 6);
  for (const index of first) assert.ok(index >= 0 && index < 40);
  assert.deepEqual([...first].sort(), [...twinkleSet(1234, 40, 6)].sort());
  assert.notDeepEqual([...first].sort(), [...twinkleSet(1235, 40, 6)].sort());
  assert.equal(twinkleSet(7, 3, 6).size, 3);
  assert.equal(twinkleSet(7, 0, 6).size, 0);
});
