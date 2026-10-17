import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { parseSnapshot } from "../lib/frame/scene.ts";

async function fixture(name) {
  return JSON.parse(await readFile(new URL(`../fixtures/${name}`, import.meta.url), "utf8"));
}

const MORNING_FIELDS = {
  now: ["now", "cursor", "window_minutes", "latest", "feed", "window_species", "activity", "today_species_count", "new_today"],
  today: ["date", "species"],
};

test("the loud afternoon fixture carries a busy hour and a long day", async () => {
  const now = await fixture("now-loud.json");
  const today = await fixture("today-loud.json");
  const received = new Date(2026, 9, 17, 15, 48, 10).getTime();
  const snapshot = parseSnapshot(now, received, today);

  assert.equal(snapshot.species.length, 14, "fourteen species in the hour");
  const robin = snapshot.species.find((species) => species.commonName === "European Robin");
  assert.equal(robin?.count, 41, "the robin has been at it");
  assert.equal(robin?.scientificName, "Erithacus rubecula");
  assert.equal(snapshot.today.length, 51, "fifty-one species today");
  assert.equal(snapshot.todaySpeciesCount, 51);
  assert.equal(snapshot.feed.length, 40, "the feed keeps the last forty calls");
  assert.equal(snapshot.newToday.length, 0);
  assert.equal(snapshot.activity.length, 24);
  assert.equal(snapshot.latest?.commonName, "Eurasian Blackbird");
  assert.equal(snapshot.latest?.clipUrl, "/api/clip/2026-10-17/Eurasian%20Blackbird");

  for (const species of snapshot.species) {
    assert.ok(species.lastHeard, `${species.commonName} knows when it was last heard`);
  }
  const feedIds = snapshot.feed.map((entry) => entry.id);
  assert.deepEqual(feedIds, [...feedIds].sort((left, right) => right - left), "ids descend with the clock");
  assert.equal(feedIds[0], 61240);
});

test("the loud fixtures keep every field the morning fixtures have", async () => {
  const [morningNow, loudNow, morningToday, loudToday] = await Promise.all(
    ["now-morning.json", "now-loud.json", "today-morning.json", "today-loud.json"].map(fixture),
  );
  for (const field of MORNING_FIELDS.now) assert.ok(field in loudNow, `now-loud has ${field}`);
  for (const field of MORNING_FIELDS.today) assert.ok(field in loudToday, `today-loud has ${field}`);
  for (const field of Object.keys(morningNow.latest)) assert.ok(field in loudNow.latest, `latest has ${field}`);
  for (const field of Object.keys(morningNow.feed[0])) {
    for (const entry of loudNow.feed) assert.ok(field in entry, `feed entry ${entry.id} has ${field}`);
  }
  for (const field of Object.keys(morningNow.window_species[0])) {
    for (const entry of loudNow.window_species) assert.ok(field in entry, `${entry.common_name} has ${field}`);
  }
  for (const field of Object.keys(morningToday.species[0])) {
    for (const entry of loudToday.species) assert.ok(field in entry, `${entry.common_name} has ${field}`);
  }
  const binomials = new Set(loudToday.species.map((entry) => entry.scientific_name));
  assert.equal(binomials.size, 51, "no species is listed twice");
  for (const name of binomials) assert.match(name, /^[A-Z][a-z]+ [a-z]+$/, `${name} is a binomial`);
});
