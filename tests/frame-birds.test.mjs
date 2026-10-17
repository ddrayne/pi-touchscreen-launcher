import assert from "node:assert/strict";
import test from "node:test";

import { todayTiles } from "../lib/frame/birds.ts";

const NOW = new Date(2026, 9, 12, 21, 30, 0).getTime();
const MIN = 60_000;

function species(commonName, lastHeard, count = 1) {
  return { commonName, scientificName: `${commonName} sci`, count, tier: "confirmed", lastHeard };
}

function snapshot({ window = [], today = [] } = {}) {
  return {
    receivedAt: NOW,
    windowMinutes: 60,
    cursor: 0,
    latest: null,
    species: window,
    feed: [],
    today,
    todaySpeciesCount: today.length,
    newToday: [],
    activity: [],
  };
}

test("today's tiles put the last hour first, newest first, then the rest of today", () => {
  const { tiles, more } = todayTiles(
    snapshot({
      window: [species("Robin", NOW - 20 * MIN), species("Redwing", NOW - 2 * MIN, 3)],
      today: [species("Redwing", NOW - 2 * MIN), species("Wren", NOW - 4 * 60 * MIN), species("Robin", NOW - 20 * MIN), species("Coot", undefined)],
    }),
    NOW,
  );
  assert.deepEqual(
    tiles.map((tile) => tile.species.commonName),
    ["Redwing", "Robin", "Wren", "Coot"],
  );
  assert.equal(tiles[0].species.count, 3, "the hour's count wins over today's entry");
  assert.ok(tiles[0].recent && tiles[1].recent);
  assert.ok(!tiles[2].recent && !tiles[3].recent);
  assert.ok(tiles[0].recency > tiles[1].recency);
  assert.ok(tiles.every((tile) => tile.recency >= 0.3));
  assert.equal(more, 0);
});

test("today's tiles stop at the limit and count the rest", () => {
  const today = Array.from({ length: 15 }, (_, index) => species(`Bird ${index}`, NOW - (index + 2) * 60 * MIN));
  const { tiles, more } = todayTiles(snapshot({ today }), NOW, 12);
  assert.equal(tiles.length, 12);
  assert.equal(more, 3);
  assert.equal(tiles[0].species.commonName, "Bird 0");
});

test("no snapshot means no tiles", () => {
  assert.deepEqual(todayTiles(null, NOW), { tiles: [], more: 0 });
});

