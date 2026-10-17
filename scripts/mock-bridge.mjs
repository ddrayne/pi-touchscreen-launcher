#!/usr/bin/env node
/**
 * A stand-in for the Pi bridge so the frame can be developed on a laptop.
 *
 *   MOCK_SCENE=chorus PORT=8765 node scripts/mock-bridge.mjs
 *
 * Scenes: quiet, chorus, rain, night, unreachable, new, winter, summer-noon,
 * loud. Serves dist-appliance/ and the /api routes the launcher uses.
 * Timestamps follow the ?at= the page sends, so dawn can be designed at noon.
 * MOCK_PORTRAITS_DIR points at a copy of the Pi's portrait cache
 * (<Genus_species>.json + image) so the frame shows real birds.
 */

import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, resolve } from "node:path";


const ROOT = resolve(new URL("..", import.meta.url).pathname);
const STATIC = process.env.MOCK_STATIC || join(ROOT, "dist-appliance");
const PORT = Number.parseInt(process.env.PORT || "8765", 10);
const SCENE = process.env.MOCK_SCENE || "quiet";
const ARTWORK = process.env.MOCK_ARTWORK || "";
const PORTRAITS_DIR = process.env.MOCK_PORTRAITS_DIR || "";

const FIXTURES = {
  morning: {
    now: JSON.parse(await readFile(join(ROOT, "fixtures/now-morning.json"), "utf8")),
    today: JSON.parse(await readFile(join(ROOT, "fixtures/today-morning.json"), "utf8")),
  },
  loud: {
    now: JSON.parse(await readFile(join(ROOT, "fixtures/now-loud.json"), "utf8")),
    today: JSON.parse(await readFile(join(ROOT, "fixtures/today-loud.json"), "utf8")),
  },
};

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".woff2": "font/woff2",
  ".json": "application/json; charset=utf-8",
};

const SCENES = {
  quiet: { latestAgoMs: 25 * 60_000, weather: "partlycloudy", arrivals: [] },
  chorus: {
    latestAgoMs: 20_000,
    weather: "sunny",
    arrivals: [
      ["Song Thrush", "Turdus philomelos", 0.9],
      ["European Greenfinch", "Chloris chloris", 0.86],
      ["Herring Gull", "Larus argentatus", 0.7],
      ["Grey Heron", "Ardea cinerea", 0.82],
      ["Eurasian Blackbird", "Turdus merula", 0.91],
      ["Dunnock", "Prunella modularis", 0.78],
      ["Eurasian Curlew", "Numenius arquata", 0.74],
      ["European Robin", "Erithacus rubecula", 0.86],
    ],
    intervalMs: 6_000,
  },
  rain: { latestAgoMs: 3 * 60_000, weather: "pouring", arrivals: [] },
  night: { latestAgoMs: 4 * 60 * 60_000, weather: "clear-night", arrivals: [], owl: true },
  unreachable: { latestAgoMs: 3 * 60 * 60_000, weather: "cloudy", arrivals: [], unreachable: true },
  new: {
    latestAgoMs: 40_000,
    weather: "sunny",
    arrivals: [["Redwing", "Turdus iliacus", 0.84]],
    intervalMs: 2_500,
    newToday: ["Redwing"],
  },
  winter: {
    latestAgoMs: 2 * 60_000,
    weather: "snowy",
    arrivals: [["Eurasian Sparrowhawk", "Accipiter nisus", 0.77]],
    intervalMs: 3_000,
  },
  "summer-noon": { latestAgoMs: 90_000, weather: "sunny", arrivals: [["Herring Gull", "Larus argentatus", 0.74]], intervalMs: 2_000 },
  loud: {
    fixture: "loud",
    latestAgoMs: 60_000,
    weather: "sunny",
    arrivals: [
      ["European Robin", "Erithacus rubecula", 0.9],
      ["Eurasian Wren", "Troglodytes troglodytes", 0.88],
      ["European Goldfinch", "Carduelis carduelis", 0.8],
    ],
    intervalMs: 8_000,
  },
};

const WEATHER = {
  sunny: { condition: "sunny", temperature: 17, humidity: 58, cloudCoverage: 8, windSpeed: 9, windBearing: 240 },
  partlycloudy: { condition: "partlycloudy", temperature: 12, humidity: 72, cloudCoverage: 46, windSpeed: 14, windBearing: 250 },
  cloudy: { condition: "cloudy", temperature: 11, humidity: 80, cloudCoverage: 94, windSpeed: 18, windBearing: 200 },
  pouring: { condition: "pouring", temperature: 9, humidity: 95, cloudCoverage: 100, windSpeed: 38, windBearing: 270 },
  "clear-night": { condition: "clear-night", temperature: 6, humidity: 84, cloudCoverage: 4, windSpeed: 5, windBearing: 90 },
  snowy: { condition: "snowy", temperature: -1, humidity: 90, cloudCoverage: 96, windSpeed: 12, windBearing: 30 },
};

const scene = SCENES[SCENE] ?? SCENES.quiet;
const { now: nowFixture, today: todayFixture } = FIXTURES[scene.fixture ?? "morning"];

function sceneNow(url) {
  const at = url.searchParams.get("at");
  const parsed = at ? new Date(at).getTime() : Number.NaN;
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function stamp(ms) {
  const date = new Date(ms);
  const pad = (value) => `${value}`.padStart(2, "0");
  return {
    date: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    time: `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`,
  };
}

/** How far the fixture's clock moves so its newest call lands `latestAgoMs` before `now`. */
function fixtureShift(now) {
  const latestMs = now - scene.latestAgoMs;
  const fixtureLatest = new Date(nowFixture.feed[0].timestamp).getTime();
  return latestMs - fixtureLatest;
}

/** Species entries may carry a `last_heard` clock (HH:MM:SS); the morning fixture's do not. */
function retimedSpecies(entries, shift, day) {
  return entries.map((entry) => {
    if (typeof entry.last_heard !== "string") return entry;
    const at = new Date(`${day}T${entry.last_heard}`).getTime() + shift;
    return { ...entry, last_heard: stamp(at).time };
  });
}

function retimedToday(now) {
  const shift = fixtureShift(now);
  return {
    ...todayFixture,
    date: stamp(now).date,
    species: retimedSpecies(todayFixture.species, shift, todayFixture.date),
  };
}

function retimedNow(now) {
  const shift = fixtureShift(now);
  const fixtureDay = nowFixture.feed[0].timestamp.slice(0, 10);
  const feed = nowFixture.feed.map((entry) => {
    const at = new Date(entry.timestamp).getTime() + shift;
    const { date, time } = stamp(at);
    return { ...entry, timestamp: `${date}T${time}`, at: time };
  });
  if (scene.owl) {
    const at = now - 9 * 60_000;
    const { date, time } = stamp(at);
    feed.unshift({
      id: 48300,
      timestamp: `${date}T${time}`,
      at: time,
      common_name: "Tawny Owl",
      scientific_name: "Strix aluco",
      confidence: 0.83,
      rms_dbfs: -40,
      peak_dbfs: -24,
      noise_floor_dbfs: -56,
      snr_db: 16,
    });
  }
  const latest = { ...nowFixture.latest, ...feed[0], seconds_ago: Math.round((now - new Date(feed[0].timestamp).getTime()) / 1000) };
  const latestStamp = stamp(new Date(feed[0].timestamp).getTime());
  latest.at = latestStamp.time;
  latest.clip_url = `/api/clip/${latestStamp.date}/${encodeURIComponent(latest.common_name)}`;
  const fixtureWindow = retimedSpecies(nowFixture.window_species, shift, fixtureDay);
  const windowSpecies = scene.owl
    ? [{ common_name: "Tawny Owl", scientific_name: "Strix aluco", count: 2, tier: "confirmed" }, ...fixtureWindow]
    : fixtureWindow;
  const quietWindow = scene.latestAgoMs > 60 * 60_000;
  return {
    ...nowFixture,
    now: stamp(now).time,
    latest,
    feed,
    window_species: quietWindow ? (scene.owl ? windowSpecies.slice(0, 1) : []) : windowSpecies,
    new_today: scene.newToday ?? [],
  };
}

let nextId = 48400;
function arrival(index, now) {
  const [common_name, scientific_name, confidence] = scene.arrivals[index % scene.arrivals.length];
  const { date, time } = stamp(now);
  nextId += 1;
  return {
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
}

const FORECASTS = {
  sunny: ["sunny", "partlycloudy", "rainy", "cloudy", "sunny"],
  partlycloudy: ["partlycloudy", "rainy", "cloudy", "sunny", "partlycloudy"],
  cloudy: ["cloudy", "rainy", "pouring", "cloudy", "partlycloudy"],
  pouring: ["pouring", "rainy", "windy", "partlycloudy", "sunny"],
  "clear-night": ["partlycloudy", "sunny", "cloudy", "rainy", "partlycloudy"],
  snowy: ["snowy", "snowy", "cloudy", "sunny", "partlycloudy"],
};

function forecast(now) {
  const base = WEATHER[scene.weather] ?? WEATHER.partlycloudy;
  const conditions = FORECASTS[scene.weather] ?? FORECASTS.partlycloudy;
  return conditions.map((condition, index) => {
    const day = new Date(now);
    day.setHours(12, 0, 0, 0);
    day.setDate(day.getDate() + index);
    const swing = [0, 1, -2, 2, 1][index];
    return {
      date: `${stamp(day.getTime()).date}T12:00:00`,
      condition,
      high: Math.round(base.temperature + 4 + swing),
      low: Math.round(base.temperature - 3 + swing),
      precipitation: condition.includes("rain") || condition === "pouring" ? 70 : condition === "snowy" ? 60 : 10,
      windSpeed: base.windSpeed,
    };
  });
}

function household(now) {
  const weather = WEATHER[scene.weather] ?? WEATHER.partlycloudy;
  const day = (offset, hour) => {
    const date = new Date(now);
    date.setDate(date.getDate() + offset);
    const { date: d } = stamp(date.getTime());
    return hour === undefined ? d : `${d}T${String(hour).padStart(2, "0")}:30:00`;
  };
  return {
    weather: { entityId: "weather.home", name: "Home", unit: "°C", windSpeedUnit: "km/h", ...weather },
    forecast: forecast(now),
    events: [
      { calendar: "calendar.workday", summary: "Bins out · green and blue", start: day(1), end: day(2), allDay: true },
      { calendar: "calendar.household", summary: "Piano lesson", start: day(1, 16), end: day(1, 17), allDay: false },
      { calendar: "calendar.household", summary: "Dentist", start: day(3, 9), end: day(3, 10), allDay: false },
      { calendar: "calendar.workday", summary: "Garden waste collection", start: day(8), end: day(9), allDay: true },
    ],
    controls: [
      { entityId: "light.kitchen", name: "Kitchen", state: "on", active: true },
      { entityId: "light.hall", name: "Hall", state: "off", active: false },
      { entityId: "light.living_room", name: "Living room", state: "off", active: false },
      { entityId: "light.garden", name: "Garden", state: "off", active: false },
    ],
    refreshedAt: new Date().toISOString(),
  };
}

const shopping = {
  items: [
    { id: "a1", text: "Milk", completed: false, name: "milk", category: "chilled" },
    { id: "a2", text: "Coffee beans", completed: false, name: "coffee beans", category: "pantry" },
    { id: "a3", text: "Apples", completed: false, name: "apples", category: "produce" },
    { id: "a4", text: "Bird seed", completed: true, name: "bird seed", category: "household" },
  ],
  activeCount: 3,
  completedCount: 1,
  syncedAt: new Date().toISOString(),
};

/** Mirrors the bridge's `safe_name`: the cache key for a scientific name. */
function safeName(value) {
  return value
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^[._]+|[._]+$/g, "")
    .slice(0, 120) || "unknown";
}

/**
 * The Pi's portrait cache keeps `<safe>.json` beside the image it names. Returns
 * the credit record with an absolute `path` to the image, a bare `{ path }` for
 * the older `<Genus species>.jpg` layout, or null when neither exists.
 */
function cachedPortrait(scientificName) {
  if (!PORTRAITS_DIR) return null;
  const metaPath = join(PORTRAITS_DIR, `${safeName(scientificName)}.json`);
  if (existsSync(metaPath)) {
    try {
      const meta = JSON.parse(readFileSync(metaPath, "utf8"));
      const imagePath = typeof meta.file === "string" ? join(PORTRAITS_DIR, meta.file) : "";
      if (meta && !meta.missing && imagePath && existsSync(imagePath)) return { ...meta, path: imagePath };
    } catch {
      // fall through to the flat layout
    }
  }
  const flat = join(PORTRAITS_DIR, `${scientificName}.jpg`);
  return existsSync(flat) ? { path: flat, contentType: "image/jpeg" } : null;
}

function placeholderPortrait(scientificName) {
  const initials = scientificName
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => word.slice(0, 1).toUpperCase())
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400" width="800" height="800">
<defs><radialGradient id="g" cx="40%" cy="35%"><stop offset="0" stop-color="#f7f3e6"/><stop offset="1" stop-color="#c9d5c7"/></radialGradient></defs>
<rect width="400" height="400" fill="url(#g)"/>
<text x="200" y="232" text-anchor="middle" font-family="Georgia, serif" font-size="120" fill="#1c3a31" opacity=".55">${initials}</text>
</svg>`;
}

function json(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(body));
}

function sendFile(response, path, type) {
  const size = statSync(path).size;
  response.writeHead(200, { "Content-Type": type || MIME[extname(path)] || "application/octet-stream", "Content-Length": size });
  createReadStream(path).pipe(response);
}

function sse(response) {
  response.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
  });
  response.write(": hello\n\n");
  return (event, data) => response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url || "/", `http://127.0.0.1:${PORT}`);
  const path = url.pathname;
  const now = sceneNow(url);

  if (path === "/api/status") {
    return json(response, 200, {
      gatewayReady: true,
      voiceReady: true,
      birdframeReady: !scene.unreachable,
      birdframeRunning: true,
      wakeReady: true,
      shoppingReady: true,
      openClawUrl: "http://192.168.86.24:18789",
    });
  }
  if (path === "/api/config") {
    return json(response, 200, { latitude: 55.95, longitude: -3.19, facing: 180, place: "Edinburgh" });
  }
  if (path === "/api/birdframe") {
    if (scene.unreachable) return json(response, 502, { error: "BirdFrame is unavailable" });
    return json(response, 200, retimedNow(now));
  }
  if (path === "/api/birdframe/today") {
    if (scene.unreachable) return json(response, 502, { error: "BirdFrame is unavailable" });
    return json(response, 200, retimedToday(now));
  }
  if (path === "/api/birdframe/events") {
    const send = sse(response);
    send("snapshot", { now: retimedNow(now), today: retimedToday(now), reachable: !scene.unreachable });
    const timers = [];
    if (scene.arrivals.length && !scene.unreachable) {
      let index = 0;
      const interval = scene.intervalMs ?? 6_000;
      const tick = () => {
        const elapsed = Date.now() - startedAt;
        send("detection", arrival(index, now + elapsed));
        index += 1;
        if (index < scene.arrivals.length * 3) timers.push(setTimeout(tick, interval));
      };
      const startedAt = Date.now();
      timers.push(setTimeout(tick, Math.min(interval, 2_500)));
    }
    timers.push(setInterval(() => send("heartbeat", { reachable: !scene.unreachable }), 15_000));
    request.on("close", () => timers.forEach((timer) => clearTimeout(timer)));
    return;
  }
  if (path.startsWith("/api/birdframe/portrait/")) {
    const rest = decodeURIComponent(path.slice("/api/birdframe/portrait/".length));
    const [scientificName, part] = rest.split("/");
    const cached = cachedPortrait(scientificName);
    if (part === "image") {
      if (cached) return sendFile(response, cached.path, cached.contentType || "image/jpeg");
      response.writeHead(200, { "Content-Type": "image/svg+xml", "Cache-Control": "max-age=3600" });
      return response.end(placeholderPortrait(scientificName));
    }
    const portrait = {
      image: `/api/birdframe/portrait/${encodeURIComponent(scientificName)}/image`,
      title: cached?.title ?? scientificName,
      artist: cached?.artist ?? (cached ? "Photographer" : "Placeholder"),
      license: cached?.license ?? "CC BY-SA 4.0",
      source: cached?.source ?? "https://commons.wikimedia.org/",
    };
    if (cached?.tint !== undefined) portrait.tint = cached.tint;
    if (cached?.focal !== undefined) portrait.focal = cached.focal;
    return json(response, 200, portrait);
  }
  if (path === "/api/birdframe/day") {
    if (scene.unreachable) return json(response, 502, { error: "BirdFrame is unavailable" });
    return json(response, 200, {
      date: stamp(now).date,
      species: retimedToday(now).species,
      new_species: scene.newToday ?? [],
      clips: [],
      images: ARTWORK && existsSync(ARTWORK) ? [{ id: 1, url: "/api/birdframe/artwork/1" }] : [],
      narration:
        "A blackbird opened the day before the light did, and by breakfast the hedge was full of tits and a wren scolding from the ferns.",
    });
  }
  if (path === "/api/birdframe/artwork/1" && ARTWORK && existsSync(ARTWORK)) {
    return sendFile(response, ARTWORK);
  }
  if (path.startsWith("/api/birdframe/clip")) {
    const clip = process.env.MOCK_CLIP || "";
    if (clip && existsSync(clip)) return sendFile(response, clip, "audio/ogg");
    return json(response, 404, { error: "no clip" });
  }
  if (path === "/api/household") return json(response, 200, household(now));
  if (path === "/api/shopping") return json(response, 200, shopping);
  if (path === "/api/shopping/events") {
    const send = sse(response);
    send("snapshot", shopping);
    const timer = setInterval(() => response.write(": keepalive\n\n"), 15_000);
    request.on("close", () => clearInterval(timer));
    return;
  }
  if (path.startsWith("/api/shopping/activity")) return json(response, 200, { activities: [] });
  if (path === "/api/shopping/household") {
    return json(response, 200, {
      settings: { enabled: false, zoneEntityId: null, personEntityId: "person.dan", notifyService: "notify.mobile_app_phone" },
      zones: [],
      people: [{ entityId: "person.dan", name: "Dan" }],
      notificationTargets: [{ service: "notify.mobile_app_phone", name: "Dan's phone" }],
    });
  }
  if (path === "/api/wake") return json(response, 200, { pending: false, sequence: 0, muted: false });
  if (path === "/api/wake/events") {
    response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
    response.write(": wake stream\n\n");
    return;
  }
  if (path === "/api/window") return json(response, 200, { ok: true, target: "birdframe", detail: "mock" });
  if (path === "/api/display") return json(response, 200, { ok: true, brightness: 1 });
  if (path.startsWith("/api/")) {
    if (request.method === "GET") return json(response, 404, { error: "Not found" });
    return json(response, 200, shopping);
  }

  const requested = path === "/" ? "/index.html" : path;
  let file = join(STATIC, requested);
  if (!file.startsWith(STATIC) || !existsSync(file) || statSync(file).isDirectory()) {
    file = join(STATIC, "index.html");
  }
  if (!existsSync(file)) {
    response.writeHead(404);
    return response.end("Build the appliance first: npm run appliance:build");
  }
  return sendFile(response, file);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Mock bridge (${SCENE}) on http://127.0.0.1:${PORT} serving ${STATIC}`);
});
