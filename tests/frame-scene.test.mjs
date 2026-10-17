import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { agendaFor } from "../lib/frame/agenda.ts";
import {
  applyDetection,
  bloomIsLeaving,
  castFor,
  inkFor,
  nextBloom,
  parseBirdframeTime,
  parseSnapshot,
  quietFor,
  rollCall,
} from "../lib/frame/scene.ts";
import { conditionWord, forecastDayLabel, parseForecast, weatherGlyph, weatherMood } from "../lib/frame/weather.ts";

async function fixture(name) {
  return JSON.parse(await readFile(new URL(`../fixtures/${name}`, import.meta.url), "utf8"));
}

const RECEIVED = new Date(2026, 9, 6, 7, 42, 10).getTime();

test("BirdFrame times are read on the local clock and roll back across midnight", () => {
  const received = new Date(2026, 9, 6, 0, 5, 0).getTime();
  const lateYesterday = parseBirdframeTime("23:58:00", received);
  assert.equal(new Date(lateYesterday).getDate(), 5);
  const minutes = parseBirdframeTime("18:55", new Date(2026, 9, 12, 21, 43).getTime());
  assert.equal(new Date(minutes).getHours(), 18, "the day list gives HH:MM without seconds");
  assert.equal(new Date(minutes).getMinutes(), 55);
  const full = parseBirdframeTime("2026-10-06T07:41:52", received);
  assert.equal(new Date(full).getHours(), 7);
  assert.equal(parseBirdframeTime("", received), received);
});

test("a snapshot carries the feed, the roster and when each species was last heard", async () => {
  const snapshot = parseSnapshot(await fixture("now-morning.json"), RECEIVED, await fixture("today-morning.json"));
  assert.equal(snapshot.feed.length, 13);
  assert.equal(snapshot.feed[0].commonName, "Eurasian Blackbird");
  assert.equal(snapshot.latest?.clipUrl, "/api/clip/2026-10-06/Eurasian%20Blackbird");
  assert.equal(snapshot.species.length, 9);
  const blackbird = snapshot.species.find((entry) => entry.commonName === "Eurasian Blackbird");
  assert.equal(new Date(blackbird.lastHeard).getMinutes(), 41);
  assert.equal(new Date(blackbird.firstHeard).getMinutes(), 45);
  assert.equal(snapshot.today.length, 9);
  assert.equal(snapshot.today[0].commonName, "Eurasian Blackbird");
  assert.equal(snapshot.windowMinutes, 60);
  assert.equal(snapshot.activity.length, 24);
});

test("ink is recency", () => {
  const now = RECEIVED;
  assert.ok(inkFor(now, now, 60) > 0.99);
  assert.ok(inkFor(now - 30 * 60_000, now, 60) > 0.3 && inkFor(now - 30 * 60_000, now, 60) < 0.6);
  assert.equal(inkFor(now - 61 * 60_000, now, 60), 0);
});

test("the newest call blooms once, repeats stay calm, first-ever visitors are gold", async () => {
  const snapshot = parseSnapshot(await fixture("now-morning.json"), RECEIVED);
  const first = nextBloom(snapshot, { now: RECEIVED });
  assert.equal(first.commonName, "Eurasian Blackbird");
  assert.equal(first.kind, "arrival");
  assert.equal(first.detectionId, 48213);
  const again = nextBloom(snapshot, { now: RECEIVED + 5_000 });
  assert.deepEqual(again, first, "the same call is the same bloom");
  assert.equal(bloomIsLeaving(again, RECEIVED + 5_000), false);
  const leaving = nextBloom(snapshot, { now: RECEIVED + 20_400 });
  assert.equal(bloomIsLeaving(leaving, RECEIVED + 20_400), true);
  const expired = nextBloom(snapshot, { now: RECEIVED + 40_000 });
  assert.equal(expired, null);

  const repeat = applyDetection(snapshot, {
    id: 48214,
    commonName: "Eurasian Blackbird",
    scientificName: "Turdus merula",
    confidence: 0.9,
    at: RECEIVED + 30_000,
    seenAt: RECEIVED + 30_000,
  });
  const calm = nextBloom(repeat, { now: RECEIVED + 30_000 });
  assert.equal(calm.detectionId, 48214);
  assert.equal(calm.at, first.at, "a repeat within two minutes keeps the first bloom");
  assert.ok(calm.until <= RECEIVED + 36_000, "a repeat only extends the bloom a little");

  const visitor = applyDetection(
    { ...snapshot, newToday: ["Redwing"] },
    { id: 48220, commonName: "Redwing", scientificName: "Turdus iliacus", confidence: 0.8, at: RECEIVED + 60_000, seenAt: RECEIVED + 60_000 },
  );
  const gold = nextBloom(visitor, { now: RECEIVED + 60_000 });
  assert.equal(gold.kind, "new-to-garden");
  assert.ok(gold.until - (RECEIVED + 60_000) >= 60_000);
  assert.equal(visitor.species[0].commonName, "Redwing");
  assert.equal(visitor.today[0].commonName, "Redwing");
});

test("a stale call never blooms on reconnect", async () => {
  const snapshot = parseSnapshot(await fixture("now-morning.json"), RECEIVED + 10 * 60_000);
  assert.equal(nextBloom(snapshot, { now: RECEIVED + 10 * 60_000 }), null);
});

test("quiet and cast come from the snapshot", async () => {
  const snapshot = parseSnapshot(await fixture("now-morning.json"), RECEIVED, await fixture("today-morning.json"));
  assert.equal(quietFor(snapshot, RECEIVED + 60_000), 78_000);
  assert.equal(quietFor(null, RECEIVED), null);
  const cast = castFor(snapshot);
  assert.equal(cast.length, 9);
  assert.equal(cast[0].commonName, "Eurasian Blackbird");
});

test("the cast takes in the latest call when today's list has not caught up", async () => {
  const snapshot = parseSnapshot(await fixture("now-morning.json"), RECEIVED, await fixture("today-morning.json"));
  const owl = { ...snapshot.latest, id: snapshot.latest.id + 1, commonName: "Tawny Owl", scientificName: "Strix aluco", at: RECEIVED + 60_000 };
  const cast = castFor({ ...snapshot, latest: owl });
  assert.equal(cast.length, 10);
  assert.equal(cast[0].commonName, "Tawny Owl");
  assert.equal(cast[0].lastHeard, RECEIVED + 60_000);
});

test("a latest call without a tier joins the cast as tentative", async () => {
  const snapshot = parseSnapshot(await fixture("now-morning.json"), RECEIVED, await fixture("today-morning.json"));
  const { tier: _dropped, ...untiered } = { ...snapshot.latest, id: snapshot.latest.id + 1, commonName: "Tawny Owl" };
  const cast = castFor({ ...snapshot, latest: untiered });
  assert.equal(cast[0].commonName, "Tawny Owl");
  assert.equal(cast[0].tier, "tentative");
});

test("weather becomes a mood and absence is a still sky", () => {
  assert.equal(weatherMood(null).rain, 0);
  const rain = weatherMood({ condition: "pouring", temperature: 7, windSpeed: 36, windSpeedUnit: "km/h", windBearing: 270 }, 180);
  assert.equal(rain.rain, 1);
  assert.ok(rain.cloud > 0.9);
  assert.ok(Math.abs(rain.wind - 10 / 15) < 1e-9);
  assert.equal(rain.windDirection, -1, "a westerly blows right to left when you look south");
  const frost = weatherMood({ condition: "sunny", temperature: -2, cloudCoverage: 12 });
  assert.equal(frost.frost, true);
  assert.ok(Math.abs(frost.cloud - 0.12) < 1e-9);
});

test("the roll call lists the hour newest first and falls back to today", async () => {
  const snapshot = parseSnapshot(await fixture("now-morning.json"), RECEIVED, await fixture("today-morning.json"));
  const rows = rollCall(snapshot, RECEIVED);
  assert.equal(rows.length, 7);
  assert.equal(rows[0].species.commonName, "Eurasian Blackbird");
  assert.equal(rows[1].species.commonName, "European Robin");
  assert.ok(rows[0].recency > rows[6].recency);
  assert.ok(rows.every((row) => !row.earlier));
  const later = rollCall(snapshot, RECEIVED + 2 * 60 * 60_000);
  assert.ok(later.length > 0, "a silent hour shows today's cast");
  assert.ok(later.every((row) => row.earlier));
  const thin = rollCall({ ...snapshot, species: snapshot.species.slice(0, 1) }, RECEIVED);
  assert.equal(thin[0].earlier, false, "the hour's bird leads");
  assert.ok(thin.length > 1 && thin.slice(1).every((row) => row.earlier), "a thin hour is topped up from today");
  assert.equal(new Set(thin.map((row) => row.species.commonName)).size, thin.length, "no bird twice");
  assert.deepEqual(rollCall(null, RECEIVED), []);
});

test("the agenda labels days, keeps bins, and drops what has passed", () => {
  const now = new Date(2026, 9, 6, 9, 10).getTime();
  const items = agendaFor(
    [
      { calendar: "c", summary: "Bins out", start: "2026-10-07", end: "2026-10-08", allDay: true },
      { calendar: "c", summary: "Piano lesson", start: "2026-10-07T16:30:00", end: "2026-10-07T17:00:00", allDay: false },
      { calendar: "c", summary: "Yesterday's thing", start: "2026-10-05T10:00:00", end: "2026-10-05T11:00:00", allDay: false },
      { calendar: "c", summary: "Dentist", start: "2026-10-09T09:30:00", end: "2026-10-09T10:00:00", allDay: false },
      { calendar: "c", summary: "Garden waste collection", start: "2026-10-20", end: "2026-10-21", allDay: true },
      { calendar: "c", summary: "Breakfast club", start: "2026-10-06T08:00:00", end: "2026-10-06T09:30:00", allDay: false },
    ],
    now,
  );
  assert.deepEqual(
    items.map((item) => [item.summary, item.when, item.kind]),
    [
      ["Breakfast club", "Today 08:00", "event"],
      ["Bins out", "Tomorrow", "bins"],
      ["Piano lesson", "Tomorrow 16:30", "event"],
      ["Dentist", "Friday 09:30", "event"],
    ],
  );
  assert.equal(agendaFor([], now).length, 0);
});

test("the forecast normalises both shapes and names the days", () => {
  const now = new Date(2026, 9, 6, 9, 10).getTime();
  const days = parseForecast([
    { datetime: "2026-10-06T12:00:00+01:00", condition: "rainy", temperature: 12.4, templow: 7.1, precipitation_probability: 60 },
    { date: "2026-10-07T12:00:00", condition: "Sunny", high: 14, low: 6, precipitation: 10 },
    { nonsense: true },
  ]);
  assert.equal(days.length, 2);
  assert.equal(days[0].high, 12.4);
  assert.equal(days[0].precipitation, 60);
  assert.equal(days[1].condition, "sunny");
  assert.equal(forecastDayLabel(days[0].date, now), "Today");
  assert.equal(forecastDayLabel(days[1].date, now), "Tomorrow");
  assert.equal(forecastDayLabel("2026-10-09T12:00:00", now), "Fri");
  assert.equal(weatherGlyph("partlycloudy"), "partly");
  assert.equal(weatherGlyph("sunny", true), "night");
  assert.equal(weatherGlyph("lightning-rainy"), "storm");
  assert.equal(conditionWord("snowy-rainy"), "Sleet");
});
