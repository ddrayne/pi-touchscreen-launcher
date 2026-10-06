#!/usr/bin/env node
/**
 * A stand-in for the BirdFrame server, so the real Pi bridge can be run on a
 * laptop end to end:
 *
 *   node scripts/mock-birdframe.mjs                      # port 9355
 *   BIRDFRAME_URL=http://127.0.0.1:9355 LAUNCHER_STATIC_ROOT=dist-appliance \
 *     LAUNCHER_CACHE_ROOT=/tmp/touchscreen-cache LAUNCHER_PORT=8765 \
 *     python3 bridge/launcher_bridge.py
 *
 * It serves the GET subset the bridge uses, with a long poll that delivers a
 * new call every MOCK_ARRIVAL_SECONDS (default 8).
 */

import { createReadStream, existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join, resolve } from "node:path";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const PORT = Number.parseInt(process.env.PORT || "9355", 10);
const ARRIVAL_SECONDS = Number.parseFloat(process.env.MOCK_ARRIVAL_SECONDS || "8");
const ARTWORK = process.env.MOCK_ARTWORK || "";

const nowFixture = JSON.parse(await readFile(join(ROOT, "fixtures/now-morning.json"), "utf8"));
const todayFixture = JSON.parse(await readFile(join(ROOT, "fixtures/today-morning.json"), "utf8"));

const ARRIVALS = [
  ["European Robin", "Erithacus rubecula", 0.86],
  ["Song Thrush", "Turdus philomelos", 0.9],
  ["Eurasian Wren", "Troglodytes troglodytes", 0.82],
  ["Eurasian Blue Tit", "Cyanistes caeruleus", 0.78],
  ["Common Wood-Pigeon", "Columba palumbus", 0.93],
  ["Eurasian Blackbird", "Turdus merula", 0.91],
];

function stamp(ms) {
  const date = new Date(ms);
  const pad = (value) => `${value}`.padStart(2, "0");
  return {
    date: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    time: `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`,
  };
}

// The feed, re-timed so the fixture's newest call was 20 s before start.
const startedAt = Date.now();
const fixtureLatest = new Date(nowFixture.feed[0].timestamp).getTime();
const shift = startedAt - 20_000 - fixtureLatest;
const feed = nowFixture.feed.map((entry) => {
  const at = new Date(entry.timestamp).getTime() + shift;
  const { date, time } = stamp(at);
  return { ...entry, timestamp: `${date}T${time}`, at: time };
});
let nextId = feed[0].id + 1;
let arrivalIndex = 0;
const waiters = new Set();

function arrive() {
  const [common_name, scientific_name, confidence] = ARRIVALS[arrivalIndex % ARRIVALS.length];
  arrivalIndex += 1;
  const { date, time } = stamp(Date.now());
  const row = {
    id: nextId,
    timestamp: `${date}T${time}`,
    at: time,
    common_name,
    scientific_name,
    confidence,
    rms_dbfs: -34,
    peak_dbfs: -18,
    noise_floor_dbfs: -52,
    snr_db: 18,
  };
  nextId += 1;
  feed.unshift(row);
  feed.length = Math.min(feed.length, 40);
  for (const wake of waiters) wake();
  console.log(`call: ${common_name} #${row.id}`);
}
setInterval(arrive, ARRIVAL_SECONDS * 1000).unref();

function json(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function nowPayload() {
  const now = Date.now();
  const latest = feed[0];
  const { date } = stamp(now);
  const speciesCounts = new Map();
  for (const entry of feed) speciesCounts.set(entry.common_name, (speciesCounts.get(entry.common_name) || 0) + 1);
  const window_species = [...speciesCounts.entries()].map(([common_name, count]) => ({
    common_name,
    scientific_name: feed.find((entry) => entry.common_name === common_name)?.scientific_name,
    count,
    tier: count > 2 ? "confirmed" : "probable",
  }));
  return {
    ...nowFixture,
    now: stamp(now).time,
    cursor: latest.id,
    latest: {
      ...nowFixture.latest,
      ...latest,
      seconds_ago: Math.round((now - new Date(latest.timestamp).getTime()) / 1000),
      tier: "confirmed",
      clip_url: `/api/clip/${date}/${encodeURIComponent(latest.common_name)}`,
    },
    feed,
    window_species,
    today_species_count: speciesCounts.size,
  };
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url || "/", `http://127.0.0.1:${PORT}`);
  const path = url.pathname;
  if (path === "/api/now") return json(response, 200, nowPayload());
  if (path === "/api/today") return json(response, 200, { ...todayFixture, date: stamp(Date.now()).date });
  if (path === "/api/detections") {
    const after = Number.parseInt(url.searchParams.get("after_id") || "0", 10);
    const wait = Math.min(30, Number.parseFloat(url.searchParams.get("wait") || "0"));
    const rows = () => feed.filter((entry) => entry.id > after).sort((left, right) => left.id - right.id);
    const reply = () =>
      json(response, 200, {
        detections: rows(),
        next_cursor: rows().length ? rows()[rows().length - 1].id : after,
        count_semantics: "BirdNET detection events/calls, not individual birds",
      });
    if (rows().length || !wait) return reply();
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      waiters.delete(finish);
      clearTimeout(timer);
      reply();
    };
    const timer = setTimeout(finish, wait * 1000);
    waiters.add(finish);
    request.on("close", () => {
      done = true;
      waiters.delete(finish);
      clearTimeout(timer);
    });
    return;
  }
  if (path.startsWith("/api/day/")) {
    const date = stamp(Date.now()).date;
    return json(response, 200, {
      date,
      species: todayFixture.species,
      new_species: [],
      clips: [{ common_name: "Eurasian Blackbird", scientific_name: "Turdus merula", confidence: 0.91, at: "07:41:52", url: `/api/clip/${date}/Eurasian%20Blackbird` }],
      images: ARTWORK && existsSync(ARTWORK) ? [{ id: 1, path: ARTWORK, created_at: `${date}T18:00:00` }] : [],
      older: null,
      newer: null,
    });
  }
  if (path === "/api/narration") {
    return json(response, 200, {
      narration: "A blackbird opened the day before the light did, and by breakfast the hedge was full of tits.",
      date: stamp(Date.now()).date,
    });
  }
  if (path.startsWith("/api/image/1") && ARTWORK && existsSync(ARTWORK)) {
    response.writeHead(200, { "Content-Type": "image/png", "Content-Length": statSync(ARTWORK).size });
    return createReadStream(ARTWORK).pipe(response);
  }
  if (path.startsWith("/api/clip/")) return json(response, 404, { error: "no clip" });
  if (path === "/api/census") {
    return json(response, 200, {
      totals: { species: todayFixture.species.length },
      life_list: todayFixture.species.map((entry) => ({
        common_name: entry.common_name,
        scientific_name: entry.scientific_name,
        first_heard: "2026-03-01",
      })),
    });
  }
  return json(response, 404, { error: "not found" });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Mock BirdFrame on http://127.0.0.1:${PORT} (a call every ${ARRIVAL_SECONDS}s)`);
});
