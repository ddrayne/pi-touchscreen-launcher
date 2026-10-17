import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  composeField,
  describeField,
  FIELD_COLS,
  FIELD_ROWS,
  fieldVoices,
  HERO_MIN_CELLS,
  MAX_SIDE,
} from "../lib/frame/poster.ts";
import { applyDetection, inkFor, parseSnapshot } from "../lib/frame/scene.ts";

async function fixture(name) {
  return JSON.parse(await readFile(new URL(`../fixtures/${name}`, import.meta.url), "utf8"));
}

const RECEIVED = new Date(2026, 9, 6, 7, 42, 10).getTime();
/** Fifty-five minutes on from the fixture only three species are still in the hour. */
const QUIET_NOW = RECEIVED + 55 * 60_000;

async function morning() {
  return parseSnapshot(await fixture("now-morning.json"), RECEIVED, await fixture("today-morning.json"));
}

// A loud afternoon: fourteen species in the hour, the most recent a wood pigeon.
const LOUD_NOW = new Date(2026, 9, 6, 15, 0, 0).getTime();
const LOUD = [
  ["Common Wood Pigeon", "Columba palumbus", 2, 0.5, "confirmed"],
  ["Eurasian Blue Tit", "Cyanistes caeruleus", 41, 3, "confirmed"],
  ["House Sparrow", "Passer domesticus", 10, 1, "confirmed"],
  ["Great Tit", "Parus major", 12, 7, "confirmed"],
  ["Eurasian Blackbird", "Turdus merula", 8, 12, "confirmed"],
  ["European Robin", "Erithacus rubecula", 4, 18, "confirmed"],
  ["Eurasian Wren", "Troglodytes troglodytes", 3, 25, "probable"],
  ["Eurasian Magpie", "Pica pica", 2, 30, "probable"],
  ["Carrion Crow", "Corvus corone", 2, 35, "probable"],
  ["Dunnock", "Prunella modularis", 1, 20, "probable"],
  ["Common Chaffinch", "Fringilla coelebs", 1, 38, "tentative"],
  ["European Goldfinch", "Carduelis carduelis", 1, 40, "tentative"],
  ["Long-tailed Tit", "Aegithalos caudatus", 1, 42, "tentative"],
  ["Eurasian Jay", "Garrulus glandarius", 1, 44, "tentative"],
];

function stamp(at) {
  const date = new Date(at);
  const pad = (value) => String(value).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

function loudSnapshot() {
  const feed = LOUD.map(([common_name, scientific_name, , minutesAgo, tier], index) => ({
    id: 9_000 - index,
    timestamp: stamp(LOUD_NOW - minutesAgo * 60_000),
    common_name,
    scientific_name,
    confidence: 0.8,
    tier,
  }));
  const species = LOUD.map(([common_name, scientific_name, count, , tier]) => ({
    common_name,
    scientific_name,
    count,
    tier,
  }));
  const extras = Array.from({ length: 37 }, (_, index) => ({
    common_name: `Species ${index + 1}`,
    scientific_name: `Avis ${index + 1}`,
    count: 1,
    tier: "tentative",
  }));
  return parseSnapshot(
    {
      window_minutes: 60,
      latest: { ...feed[0], at: feed[0].timestamp.slice(11) },
      feed,
      window_species: species,
      today_species_count: 51,
      new_today: ["Eurasian Jay"],
    },
    LOUD_NOW,
    { species: [...species, ...extras] },
  );
}

function detectionFor(snapshot, commonName, at) {
  const species = snapshot.species.find((entry) => entry.commonName === commonName);
  return {
    id: 10_000 + Math.round(at / 1000),
    commonName,
    scientificName: species?.scientificName ?? "",
    confidence: 0.9,
    at,
    seenAt: at,
    tier: species?.tier ?? "confirmed",
  };
}

function cellsOf(area) {
  return area.cols * area.rows;
}

function birds(field) {
  return field.blocks.filter((block) => block.kind === "bird");
}

function areasByName(field) {
  return new Map(birds(field).map((block) => [block.key, block.area]));
}

function sameOrigin(a, b) {
  return a.col === b.col && a.row === b.row;
}

/** Every cell of the field is owned by exactly one block. */
function assertTiled(field) {
  const owners = new Map();
  for (const block of field.blocks) {
    const { col, row, cols, rows } = block.area;
    assert.ok(col >= 0 && row >= 0 && col + cols <= FIELD_COLS && row + rows <= FIELD_ROWS, `${block.key} is inside the field`);
    for (let x = col; x < col + cols; x += 1) {
      for (let y = row; y < row + rows; y += 1) {
        const cell = `${x},${y}`;
        assert.equal(owners.get(cell), undefined, `${cell} is owned once (${block.key} vs ${owners.get(cell)})`);
        owners.set(cell, block.key);
      }
    }
  }
  assert.equal(owners.size, FIELD_COLS * FIELD_ROWS, "every cell is covered");
}

test("every cell is covered by exactly one block, quiet or loud", async () => {
  const snapshot = await morning();
  assertTiled(composeField(snapshot, RECEIVED, null));
  assertTiled(composeField(snapshot, QUIET_NOW, null));
  assertTiled(composeField(loudSnapshot(), LOUD_NOW, null));
});

test("no side exceeds the maximum and the hero has its minimum", async () => {
  for (const field of [
    composeField(await morning(), QUIET_NOW, null),
    composeField(loudSnapshot(), LOUD_NOW, null),
  ]) {
    for (const block of field.blocks) {
      assert.ok(block.area.cols <= MAX_SIDE && block.area.rows <= MAX_SIDE, `${block.key} within ${MAX_SIDE}`);
    }
    const heroes = birds(field).filter((block) => block.hero);
    assert.equal(heroes.length, 1);
    assert.ok(cellsOf(heroes[0].area) >= HERO_MIN_CELLS, `hero has ${cellsOf(heroes[0].area)} cells`);
  }
});

test("a quiet hour widens to today; a loud one stays in the hour", async () => {
  const snapshot = await morning();
  assert.equal(composeField(snapshot, RECEIVED, null).window, "hour");
  const quiet = composeField(snapshot, QUIET_NOW, null);
  assert.equal(quiet.window, "today");
  assert.equal(birds(quiet).length, 9, "the whole cast of the day is on the poster");
  for (const block of birds(quiet)) assert.ok(block.ink >= 0.2, "today's ink never drops below the floor");
  const loud = composeField(loudSnapshot(), LOUD_NOW, null);
  assert.equal(loud.window, "hour");
  assert.deepEqual(composeField(null, LOUD_NOW, null), { window: "hour", blocks: [] });
});

test("the hero is the latest call and new-to-garden birds are flagged", () => {
  const field = composeField(loudSnapshot(), LOUD_NOW, null);
  const hero = birds(field).find((block) => block.hero);
  assert.equal(hero.key, "Common Wood Pigeon");
  assert.ok(hero.ink > 0.95);
  assert.ok(hero.age < 60_000);
  assert.equal(birds(field).find((block) => block.key === "Eurasian Jay").newToGarden, true);
  assert.equal(hero.newToGarden, false);
});

test("the field is deterministic", async () => {
  const snapshot = loudSnapshot();
  assert.deepEqual(composeField(snapshot, LOUD_NOW, null), composeField(snapshot, LOUD_NOW, null));
  const quiet = await morning();
  assert.deepEqual(composeField(quiet, QUIET_NOW, null), composeField(quiet, QUIET_NOW, null));
});

test("a repeat call that changes no shape leaves every block where it was", () => {
  const snapshot = loudSnapshot();
  const previous = composeField(snapshot, LOUD_NOW, null);
  const later = LOUD_NOW + 30_000;
  const next = composeField(
    applyDetection(snapshot, detectionFor(snapshot, "Common Wood Pigeon", later - 10_000)),
    later,
    previous,
  );
  const before = areasByName(previous);
  const after = areasByName(next);
  assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort());
  for (const [name, area] of before) {
    assert.equal(cellsOf(after.get(name)), cellsOf(area), `${name} keeps its cell count`);
    assert.deepEqual(after.get(name), area, `${name} keeps its area`);
  }
});

test("when the hero grows it grows in place and most neighbours stay put", () => {
  const snapshot = loudSnapshot();
  const previous = composeField(snapshot, LOUD_NOW, null);
  const later = LOUD_NOW + 30_000;
  const next = composeField(
    applyDetection(snapshot, detectionFor(snapshot, "Eurasian Blue Tit", later - 10_000)),
    later,
    previous,
  );
  const before = areasByName(previous);
  const after = areasByName(next);
  const hero = birds(next).find((block) => block.hero);
  assert.equal(hero.key, "Eurasian Blue Tit");
  assert.ok(cellsOf(hero.area) > cellsOf(before.get(hero.key)), "the new hero grew");
  assert.ok(sameOrigin(hero.area, before.get(hero.key)), "the hero kept its origin");
  const others = [...before.keys()].filter((name) => name !== hero.key && after.has(name));
  const kept = others.filter((name) => sameOrigin(before.get(name), after.get(name)));
  assert.ok(
    kept.length >= Math.ceil(others.length * 0.7),
    `${kept.length} of ${others.length} kept their origin\n${describeField(previous)}\n\n${describeField(next)}`,
  );
  assertTiled(next);
});

test("a newcomer opens small, into the room at most one block makes for it", () => {
  const snapshot = loudSnapshot();
  const previous = composeField(snapshot, LOUD_NOW, null);
  const goldcrest = {
    commonName: "Goldcrest",
    scientificName: "Regulus regulus",
    count: 1,
    tier: "probable",
    lastHeard: LOUD_NOW - 10 * 60_000,
  };
  const next = composeField(
    { ...snapshot, species: [...snapshot.species, goldcrest] },
    LOUD_NOW + 30_000,
    previous,
  );
  const before = areasByName(previous);
  const after = areasByName(next);
  const resized = [...before.keys()].filter((name) => cellsOf(after.get(name)) !== cellsOf(before.get(name)));
  assert.ok(resized.length <= 1, `resized: ${resized.join(", ")}`);
  const freed = resized.reduce((sum, name) => sum + cellsOf(before.get(name)) - cellsOf(after.get(name)), 0);
  assert.ok(freed >= 1, "the one block that changes makes room by shrinking");
  const newcomer = after.get("Goldcrest");
  assert.ok(cellsOf(newcomer) <= freed, `the newcomer's ${cellsOf(newcomer)} cells fit the ${freed} made for it`);
  for (const name of before.keys()) {
    if (resized.includes(name)) continue;
    assert.deepEqual(after.get(name), before.get(name), `${name} keeps its area`);
  }
  assert.equal(next.blocks.filter((block) => block.kind === "ground").length, 0, "nothing is left for the next tick to absorb");
  assertTiled(next);
});

test("a newcomer hero opens at full size and the field then holds still without an event", () => {
  const snapshot = loudSnapshot();
  const first = composeField(snapshot, LOUD_NOW, null);
  const arrival = LOUD_NOW + 30_000;
  const goldcrest = {
    id: 10_500,
    commonName: "Goldcrest",
    scientificName: "Regulus regulus",
    confidence: 0.9,
    at: arrival - 5_000,
    seenAt: arrival - 5_000,
    tier: "probable",
  };
  const arrived = applyDetection(snapshot, goldcrest);
  const second = composeField(arrived, arrival, first);
  const hero = birds(second).find((block) => block.hero);
  assert.equal(hero.key, "Goldcrest");
  assert.ok(
    cellsOf(hero.area) >= HERO_MIN_CELLS,
    `the newcomer hero has ${cellsOf(hero.area)} cells\n${describeField(first)}\n\n${describeField(second)}`,
  );
  assertTiled(second);
  const third = composeField(arrived, arrival + 15_000, second);
  assert.deepEqual(
    [...areasByName(third)],
    [...areasByName(second)],
    `blocks moved with no event behind it\n${describeField(second)}\n\n${describeField(third)}`,
  );
  assertTiled(third);
});

test("birds dropped by a cap leave no ground: their neighbours grow into the cells", () => {
  const snapshot = loudSnapshot();
  const first = composeField(snapshot, LOUD_NOW, null);
  const second = composeField(snapshot, LOUD_NOW + 15_000, first, { maxBirds: 10 });
  assert.equal(birds(second).length, 10);
  assert.equal(second.blocks.find((block) => block.kind === "more").names.length, 4);
  const ground = second.blocks.filter((block) => block.kind === "ground");
  assert.equal(ground.length, 0, `ground left behind\n${describeField(first)}\n\n${describeField(second)}`);
  const before = areasByName(first);
  for (const block of birds(second)) assert.ok(sameOrigin(block.area, before.get(block.key)), `${block.key} kept its origin`);
  assertTiled(second);
});

test("the loud field leaves little ground", () => {
  const field = composeField(loudSnapshot(), LOUD_NOW, null);
  const ground = field.blocks.filter((block) => block.kind === "ground");
  assert.ok(ground.length <= 6, `${ground.length} ground blocks\n${describeField(field)}`);
});

test("describeField draws the grid one character per cell", async () => {
  const lines = describeField(composeField(await morning(), QUIET_NOW, null)).split("\n");
  assert.equal(lines.length, FIELD_ROWS);
  for (const line of lines) assert.equal(line.length, FIELD_COLS);
});

test("the today window can be forced on a loud hour", () => {
  const snapshot = loudSnapshot();
  const field = composeField(snapshot, LOUD_NOW, null, { window: "today" });
  assert.equal(field.window, "today");
  const birds = field.blocks.filter((block) => block.kind === "bird");
  assert.ok(birds.length > 0);
  const more = field.blocks.find((block) => block.kind === "more");
  assert.ok(more, "fifty-one species do not fit; the rest are in the more block");
  assert.equal(birds.length + more.names.length, snapshot.todaySpeciesCount);
});

test("fieldVoices counts every voice the field was composed from, capped or not", () => {
  const snapshot = loudSnapshot();
  const heard = snapshot.species.filter(
    (species) => species.lastHeard !== undefined && inkFor(species.lastHeard, LOUD_NOW, snapshot.windowMinutes) > 0,
  ).length;
  assert.equal(heard, LOUD.length, "every loud species is still within the hour");
  assert.equal(fieldVoices(composeField(snapshot, LOUD_NOW, null)), heard);
  const capped = composeField(snapshot, LOUD_NOW, null, { maxBirds: 6 });
  assert.equal(birds(capped).length, 6);
  assert.equal(fieldVoices(capped), heard, "capped birds are counted through the more block");
  assert.equal(fieldVoices(composeField(snapshot, LOUD_NOW, null, { window: "today" })), snapshot.todaySpeciesCount);
  assert.equal(fieldVoices({ window: "hour", blocks: [] }), 0);
});

test("a cap on bird blocks keeps the hero, sends the rest to more, and holds steady", () => {
  const snapshot = loudSnapshot();
  const first = composeField(snapshot, LOUD_NOW, null, { window: "today", maxBirds: 14 });
  const birds = first.blocks.filter((block) => block.kind === "bird");
  assert.equal(birds.length, 14);
  assert.ok(birds.some((block) => block.hero), "the hero survives the cap");
  const more = first.blocks.find((block) => block.kind === "more");
  assert.equal(birds.length + more.names.length, snapshot.todaySpeciesCount);
  assertTiled(first);
  const second = composeField(snapshot, LOUD_NOW + 15_000, first, { window: "today", maxBirds: 14 });
  assert.deepEqual(
    second.blocks.filter((block) => block.kind === "bird").map((block) => block.key).sort(),
    birds.map((block) => block.key).sort(),
  );
});
