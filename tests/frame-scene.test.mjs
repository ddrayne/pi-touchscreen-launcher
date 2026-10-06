import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { archetypeIdFor, bodiesFor, MAX_BODIES } from "../lib/frame/archetypes.ts";
import { ANCHORS } from "../lib/frame/garden.ts";
import {
  applyDetection,
  bloomIsLeaving,
  buildBodies,
  castFor,
  inkFor,
  nextBloom,
  parseBirdframeTime,
  parseSnapshot,
  quietFor,
} from "../lib/frame/scene.ts";
import { weatherMood } from "../lib/frame/weather.ts";

async function fixture(name) {
  return JSON.parse(await readFile(new URL(`../fixtures/${name}`, import.meta.url), "utf8"));
}

const RECEIVED = new Date(2026, 9, 6, 7, 42, 10).getTime();

test("species map to archetypes by name and family", () => {
  assert.equal(archetypeIdFor("Eurasian Blackbird"), "thrush");
  assert.equal(archetypeIdFor("European Robin"), "robin");
  assert.equal(archetypeIdFor("Eurasian Blue Tit"), "tit");
  assert.equal(archetypeIdFor("Long-tailed Tit"), "tit");
  assert.equal(archetypeIdFor("Common Wood-Pigeon"), "pigeon");
  assert.equal(archetypeIdFor("Herring Gull"), "gull");
  assert.equal(archetypeIdFor("Eurasian Magpie"), "corvid");
  assert.equal(archetypeIdFor("Common Swift"), "aerial");
  assert.equal(archetypeIdFor("Eurasian Sparrowhawk"), "raptor");
  assert.equal(archetypeIdFor("Eurasian Wren"), "skulker");
  assert.equal(archetypeIdFor("Dunnock"), "skulker");
  assert.equal(archetypeIdFor("House Sparrow"), "gang");
  assert.equal(archetypeIdFor("Common Chiffchaff"), "warbler");
  assert.equal(archetypeIdFor("European Goldfinch"), "finch");
  assert.equal(archetypeIdFor("Great Spotted Woodpecker"), "woodpecker");
  assert.equal(archetypeIdFor("Grey Heron"), "wader");
  assert.equal(archetypeIdFor("Tawny Owl"), "night");
  assert.equal(archetypeIdFor("Pied Wagtail"), "default");
  assert.equal(archetypeIdFor("Something Unheard Of"), "default");
});

test("bodies are not counts", () => {
  assert.equal(bodiesFor(0), 0);
  assert.equal(bodiesFor(1), 1);
  assert.equal(bodiesFor(2), 2);
  assert.equal(bodiesFor(3), 2);
  assert.equal(bodiesFor(40), 6);
});

test("BirdFrame times are read on the local clock and roll back across midnight", () => {
  const received = new Date(2026, 9, 6, 0, 5, 0).getTime();
  const lateYesterday = parseBirdframeTime("23:58:00", received);
  assert.equal(new Date(lateYesterday).getDate(), 5);
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

test("bodies follow the roster, take distinct perches and never exceed the cap", async () => {
  const snapshot = parseSnapshot(await fixture("now-morning.json"), RECEIVED);
  const bodies = buildBodies(snapshot, { now: RECEIVED, isNight: false });
  assert.ok(bodies.length > 9 && bodies.length <= MAX_BODIES, `${bodies.length} bodies`);
  const blackbirds = bodies.filter((body) => body.commonName === "Eurasian Blackbird");
  assert.equal(blackbirds.length, bodiesFor(5));
  const perched = bodies.filter((body) => body.anchor);
  const ids = perched.map((body) => body.anchor.id);
  assert.equal(new Set(ids).size, ids.length, "no two bodies share a perch while perches remain");
  for (const body of perched) {
    assert.ok(body.archetype.anchors.includes(body.anchor.kind), `${body.commonName} on ${body.anchor.kind}`);
  }
  const gull = bodies.find((body) => body.commonName === "Herring Gull");
  assert.ok(gull.anchor === null || ["ridge", "chimney"].includes(gull.anchor.kind));
  assert.equal(bodies[0].commonName, "Eurasian Blackbird", "the newest species comes first");
  assert.ok(bodies[0].ink > bodies[bodies.length - 1].ink);
});

test("night birds only appear after dark and a huge roster is capped", async () => {
  const raw = await fixture("now-morning.json");
  raw.window_species = [
    { common_name: "Tawny Owl", scientific_name: "Strix aluco", count: 2, tier: "confirmed" },
    ...Array.from({ length: 30 }, (_, index) => ({
      common_name: `Finch ${index}`,
      scientific_name: `Fringilla ${index}`,
      count: 64,
      tier: "confirmed",
    })),
  ];
  const snapshot = parseSnapshot(raw, RECEIVED);
  const day = buildBodies(snapshot, { now: RECEIVED, isNight: false });
  assert.ok(!day.some((body) => body.commonName === "Tawny Owl"));
  assert.equal(day.length, MAX_BODIES);
  const night = buildBodies(snapshot, { now: RECEIVED, isNight: true });
  assert.ok(night.some((body) => body.commonName === "Tawny Owl"));
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

test("every anchor kind in the garden is one an archetype can use", () => {
  const kinds = new Set(ANCHORS.map((anchor) => anchor.kind));
  assert.ok(kinds.has("hedge") && kinds.has("canopy") && kinds.has("lawn"));
});
