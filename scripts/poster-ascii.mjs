#!/usr/bin/env node
/**
 * Prints the poster field for a pair of BirdFrame fixtures, for eyeballing.
 *
 *   node scripts/poster-ascii.mjs fixtures/now-morning.json fixtures/today-morning.json [ISO now]
 *
 * Without an ISO time, "now" is the latest call plus its reported seconds_ago,
 * so a fixture renders as it would have on the day it was captured.
 */

import { readFile } from "node:fs/promises";

import { blockGlyph, composeField, describeField } from "../lib/frame/poster.ts";
import { parseBirdframeTime, parseSnapshot } from "../lib/frame/scene.ts";

const [nowPath, todayPath, isoNow] = process.argv.slice(2);
if (!nowPath) {
  console.error("usage: poster-ascii.mjs <now.json> [today.json] [ISO now]");
  process.exit(2);
}

const nowRaw = JSON.parse(await readFile(nowPath, "utf8"));
const todayRaw = todayPath ? JSON.parse(await readFile(todayPath, "utf8")) : undefined;

function clockOf(raw, iso) {
  if (iso) return new Date(iso).getTime();
  const newest = raw.feed?.[0]?.timestamp ?? raw.latest?.at;
  const seedless = new Date(2000, 0, 1).getTime();
  const at = parseBirdframeTime(newest, seedless);
  return at === seedless ? seedless : at + (raw.latest?.seconds_ago ?? 0) * 1000;
}

const now = clockOf(nowRaw, isoNow);
const snapshot = parseSnapshot(nowRaw, now, todayRaw);
const field = composeField(snapshot, now, null);

const minutes = (ms) => `${Math.round(ms / 60_000)} min`;
console.log(`${new Date(now).toLocaleString("en-GB")} · window: ${field.window}\n`);
console.log(describeField(field));
console.log();
for (const block of field.blocks) {
  const glyph = blockGlyph(field, block);
  const { cols, rows, col, row } = block.area;
  const where = `${cols}×${rows} at ${col},${row}`;
  if (block.kind === "bird") {
    const flags = [block.hero ? "hero" : "", block.newToGarden ? "new to garden" : ""].filter(Boolean).join(", ");
    console.log(
      `${glyph}  ${block.key.padEnd(24)} ${String(block.species.count).padStart(3)} calls  ${where.padEnd(12)} ` +
        `ink ${block.ink.toFixed(2)}  ${minutes(block.age).padStart(7)} ago${flags ? `  (${flags})` : ""}`,
    );
  } else if (block.kind === "more") {
    console.log(`${glyph}  and ${block.names.length} more: ${block.names.join(", ")}  ${where}`);
  }
}
const ground = field.blocks.filter((block) => block.kind === "ground");
if (ground.length) {
  const cells = ground.reduce((sum, block) => sum + block.area.cols * block.area.rows, 0);
  console.log(`.  ground: ${ground.length} block${ground.length === 1 ? "" : "s"}, ${cells} cell${cells === 1 ? "" : "s"}`);
}
