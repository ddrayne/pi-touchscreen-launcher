import assert from "node:assert/strict";
import test from "node:test";

import { parseFocal, parsePortrait, parseTint } from "../lib/frame/portraits.ts";

function without(record, ...keys) {
  return Object.fromEntries(Object.entries(record).filter(([key]) => !keys.includes(key)));
}

const full = {
  image: "/api/birdframe/portrait/Erithacus%20rubecula/image",
  title: "European robin",
  artist: "Francis C. Franklin",
  license: "CC BY-SA 3.0",
  source: "https://commons.wikimedia.org/wiki/File:Robin.jpg",
  tint: [171, 92, 40],
  focal: { x: 0.612, y: 0.44 },
};

test("parsePortrait reads a full record", () => {
  assert.deepEqual(parsePortrait(full), { ...full });
});

test("parsePortrait tolerates a record without features", () => {
  const bare = without(full, "tint", "focal");
  const portrait = parsePortrait(bare);
  assert.equal(portrait.tint, null);
  assert.equal(portrait.focal, null);
  assert.equal(portrait.title, "European robin");
  assert.deepEqual(parsePortrait({ ...bare, tint: null, focal: null }), { ...bare, tint: null, focal: null });
});

test("parsePortrait falls back to the given title and the default credit", () => {
  const portrait = parsePortrait({ image: "/img" }, "Turdus merula");
  assert.equal(portrait.title, "Turdus merula");
  assert.equal(portrait.artist, "Wikimedia contributor");
  assert.equal(portrait.license, "");
  assert.equal(portrait.source, "");
});

test("parsePortrait returns null without an image", () => {
  assert.equal(parsePortrait(without(full, "image")), null);
  assert.equal(parsePortrait({ ...full, image: "" }), null);
  assert.equal(parsePortrait({ ...full, image: 7 }), null);
  assert.equal(parsePortrait(null), null);
  assert.equal(parsePortrait("robin"), null);
  assert.equal(parsePortrait([full]), null);
});

test("parseTint accepts exactly three channels in 0..255, rounded", () => {
  assert.deepEqual(parseTint([171, 92, 40]), [171, 92, 40]);
  assert.deepEqual(parseTint([0, 255, 12.6]), [0, 255, 13]);
  assert.equal(parseTint([1, 2]), null);
  assert.equal(parseTint([1, 2, 3, 4]), null);
  assert.equal(parseTint(["171", "92", "40"]), null);
  assert.equal(parseTint("171,92,40"), null);
  assert.equal(parseTint([256, 0, 0]), null);
  assert.equal(parseTint([-1, 0, 0]), null);
  assert.equal(parseTint([NaN, 0, 0]), null);
  assert.equal(parseTint(null), null);
  assert.equal(parseTint(undefined), null);
  assert.equal(parsePortrait({ ...full, tint: [1, 2] }).tint, null);
});

test("parseFocal accepts finite fractions in 0..1", () => {
  assert.deepEqual(parseFocal({ x: 0, y: 1 }), { x: 0, y: 1 });
  assert.deepEqual(parseFocal({ x: 0.5, y: 0.25 }), { x: 0.5, y: 0.25 });
  assert.equal(parseFocal({ x: 1.2, y: 0.5 }), null);
  assert.equal(parseFocal({ x: 0.5, y: -0.1 }), null);
  assert.equal(parseFocal({ x: "0.5", y: 0.5 }), null);
  assert.equal(parseFocal({ x: 0.5 }), null);
  assert.equal(parseFocal({ x: Infinity, y: 0.5 }), null);
  assert.equal(parseFocal([0.5, 0.5]), null);
  assert.equal(parseFocal(null), null);
  assert.equal(parsePortrait({ ...full, focal: { x: 3, y: 0.5 } }).focal, null);
});
