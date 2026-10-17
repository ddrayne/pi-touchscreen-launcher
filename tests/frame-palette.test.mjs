import assert from "node:assert/strict";
import test from "node:test";

import {
  blockTint,
  cooling,
  GOLD,
  groundPalette,
  PAPER_DAY,
  PAPER_NIGHT,
  tierWeight,
  typeInkFor,
  typeOver,
  TYPE_DAY,
  TYPE_NIGHT,
} from "../lib/frame/palette.ts";
import { skyPalette } from "../lib/frame/solar.ts";

const MINUTE = 60_000;

function skyAt(darkness) {
  return { ...skyPalette(45), glow: [250, 222, 168], darkness };
}

test("a block cools from full ink to a pale square over forty minutes", () => {
  assert.deepEqual(cooling(0), { saturation: 1, tintMix: 0 });
  const cooled = cooling(40 * MINUTE);
  assert.ok(Math.abs(cooled.saturation - 0.15) < 1e-9);
  assert.ok(Math.abs(cooled.tintMix - 0.85) < 1e-9);
  assert.deepEqual(cooling(3 * 60 * MINUTE), cooled, "it never cools past the floor");
  let previous = cooling(0);
  for (let age = MINUTE; age <= 40 * MINUTE; age += MINUTE) {
    const next = cooling(age);
    assert.ok(next.saturation <= previous.saturation, `saturation falls at ${age}`);
    assert.ok(next.tintMix >= previous.tintMix, `tint mix rises at ${age}`);
    previous = next;
  }
  assert.ok(cooling(5 * MINUTE, 10 * MINUTE).tintMix > cooling(5 * MINUTE).tintMix, "a shorter cool runs faster");
});

test("a block without a tint sits on the deep paper; a tinted one sinks toward the paper", () => {
  const ground = groundPalette(skyAt(0), false);
  assert.deepEqual(blockTint(null, ground, 0.5), ground.paperDeep);
  const tint = [40, 90, 160];
  assert.deepEqual(blockTint(tint, ground, 0), tint);
  assert.deepEqual(blockTint(tint, ground, 1), ground.paper);
  const half = blockTint(tint, ground, 0.5);
  assert.ok(half[0] > tint[0] && half[0] < ground.paper[0]);
});

test("type reads cream over dark tints and ink over light ones", () => {
  assert.deepEqual(typeOver([20, 20, 20]), TYPE_NIGHT);
  assert.deepEqual(typeOver([240, 235, 220]), TYPE_DAY);
});

test("the ground is paper by day, deep navy at night, blushed at twilight", () => {
  const day = groundPalette(skyAt(0), false);
  assert.deepEqual(day.paper, PAPER_DAY);
  assert.deepEqual(day.type, TYPE_DAY);
  assert.deepEqual(day.gold, GOLD);
  assert.equal(day.dim, 0);
  assert.ok(day.paperDeep.every((channel, index) => channel < PAPER_DAY[index]), "deep paper is darker by day");

  const night = groundPalette(skyAt(1), false);
  assert.deepEqual(night.paper, PAPER_NIGHT);
  assert.deepEqual(night.type, TYPE_NIGHT);
  assert.ok(Math.abs(night.dim - 0.4) < 1e-9);
  assert.ok(night.paperDeep.every((channel, index) => channel > PAPER_NIGHT[index]), "deep paper is lighter at night");

  const dusk = groundPalette(skyAt(0.5), false);
  const dawn = groundPalette(skyAt(0.5), true);
  const midpoint = PAPER_DAY.map((channel, index) => Math.round((channel + PAPER_NIGHT[index]) / 2));
  assert.notDeepEqual(dusk.paper, midpoint, "dusk paper carries the glow");
  assert.notDeepEqual(dusk.paper, dawn.paper, "dawn and dusk blush differently");
  assert.equal(groundPalette(skyAt(0.2), false).paper.join(), groundPalette({ ...skyAt(0.2), glow: [0, 0, 0] }, false).paper.join(), "no glow at the edge of the band");
  assert.ok(groundPalette(skyAt(0.6), false).dim === 0 && groundPalette(skyAt(0.8), false).dim > 0);
});

test("type weight follows the tier and the type ink follows the paper", () => {
  assert.equal(tierWeight("confirmed"), 700);
  assert.equal(tierWeight("probable"), 500);
  assert.equal(tierWeight("tentative"), 300);
  assert.equal(tierWeight(undefined), 500);
  assert.deepEqual(typeInkFor(0), TYPE_DAY);
  assert.deepEqual(typeInkFor(1), TYPE_NIGHT);
});
