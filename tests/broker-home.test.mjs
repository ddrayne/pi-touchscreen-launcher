import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const MEDIA = "media_player.kitchen_kitchen";
const ART = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function json(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

function acceptKey(key) {
  return createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
}

// Server-to-client WebSocket text frame; every message here is under 126 bytes.
function textFrame(value) {
  const payload = Buffer.from(JSON.stringify(value));
  return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
}

async function startFakes({ websocket = false } = {}) {
  const calls = [];
  const sockets = new Set();
  const states = {
    "zone.home": { state: "0", attributes: { latitude: 51.4779, longitude: -0.0015 } },
    [MEDIA]: {
      state: "playing",
      attributes: {
        media_title: "Sounds of the Garden",
        media_artist: "BBC Radio 4",
        volume_level: 0.3,
        entity_picture: `/api/media_player_proxy/${MEDIA}?token=abc&cache=1`,
      },
    },
    "binary_sensor.kitchen_motion_sensor_motion": {
      state: "on",
      last_changed: "2026-10-06T12:14:00+00:00",
    },
    "sensor.kitchen_motion_sensor_illuminance": { state: "123.4" },
  };
  const homeAssistant = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
    calls.push({ method: request.method, url: request.url, auth: request.headers.authorization, body });
    if (request.headers.authorization !== "Bearer test-token") return json(response, 401, {});
    const stateMatch = request.url.match(/^\/api\/states\/([a-z_]+\.[a-z0-9_]+)$/);
    if (request.method === "GET" && stateMatch) {
      const state = states[stateMatch[1]];
      return state ? json(response, 200, { entity_id: stateMatch[1], ...state }) : json(response, 404, { message: "Entity not found." });
    }
    if (request.method === "GET" && request.url.startsWith("/api/media_player_proxy/")) {
      response.writeHead(200, { "Content-Type": "image/jpeg" });
      return response.end(ART);
    }
    if (request.method === "POST" && request.url.startsWith("/api/services/media_player/")) {
      return json(response, 200, []);
    }
    json(response, 404, { message: "Not found" });
  });
  const openMeteo = createServer((request, response) => {
    const url = new URL(request.url, "http://open-meteo.test");
    calls.push({ method: "GET", url: request.url });
    const time = Array.from({ length: 48 }, (_, index) => {
      const day = index < 24 ? "06" : "07";
      return `2026-10-${day}T${String(index % 24).padStart(2, "0")}:00`;
    });
    json(response, 200, {
      latitude: Number(url.searchParams.get("latitude")),
      current: { time: "2026-10-06T13:15", temperature_2m: 11.6, weather_code: 3, is_day: 1 },
      hourly: {
        time,
        temperature_2m: time.map(() => 11),
        precipitation_probability: time.map((_, index) => (index >= 14 && index <= 17 ? 80 : 10)),
        precipitation: time.map(() => 0),
        weather_code: time.map(() => 3),
      },
      daily: {
        time: ["2026-10-06", "2026-10-07"],
        temperature_2m_max: [14.2, 12],
        temperature_2m_min: [7.1, 6],
        sunrise: ["2026-10-06T07:24", "2026-10-07T07:26"],
        sunset: ["2026-10-06T18:41", "2026-10-07T18:38"],
      },
    });
  });
  // Just enough of Home Assistant's event socket to authenticate the broker.
  let authenticated = 0;
  if (websocket) {
    homeAssistant.on("upgrade", (request, socket) => {
      socket.write(
        [
          "HTTP/1.1 101 Switching Protocols",
          "Upgrade: websocket",
          "Connection: Upgrade",
          `Sec-WebSocket-Accept: ${acceptKey(request.headers["sec-websocket-key"])}`,
          "",
          "",
        ].join("\r\n"),
      );
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.on("error", () => {});
      socket.write(textFrame({ type: "auth_required" }));
      socket.once("data", () => {
        authenticated += 1;
        socket.write(textFrame({ type: "auth_ok" }));
      });
    });
  }
  const haPort = await listen(homeAssistant);
  const meteoPort = await listen(openMeteo);
  return {
    calls,
    states,
    haPort,
    meteoPort,
    authenticated: () => authenticated,
    /** Drops the broker's event socket, as a Home Assistant restart does. */
    dropEventSockets: () => {
      for (const socket of sockets) socket.destroy();
    },
    close: () => {
      for (const socket of sockets) socket.destroy();
      homeAssistant.close();
      openMeteo.close();
    },
  };
}

async function startBroker(fakes) {
  const directory = await mkdtemp(join(tmpdir(), "kitchen-broker-"));
  const port = 20_000 + Math.floor(Math.random() * 20_000);
  const child = spawn(process.execPath, ["broker/openclaw_voice_broker.ts"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      HA_URL: `http://127.0.0.1:${fakes.haPort}`,
      HA_TOKEN: "test-token",
      OPEN_METEO_URL: `http://127.0.0.1:${fakes.meteoPort}/v1/forecast`,
      VOICE_BROKER_HOST: "127.0.0.1",
      VOICE_BROKER_PORT: String(port),
      VOICE_BROKER_ALLOWED_IPS: "127.0.0.1,::1",
      SHOPPING_ACTIVITY_PATH: join(directory, "activity.jsonl"),
      SHOPPING_SETTINGS_PATH: join(directory, "settings.json"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stderr.on("data", (chunk) => { output += chunk; });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`broker did not start:\n${output}`)), 15_000);
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (output.includes("Kitchen broker listening")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once("exit", (code) => reject(new Error(`broker exited ${code}:\n${output}`)));
  });
  return {
    url: `http://127.0.0.1:${port}`,
    async stop() {
      child.kill("SIGTERM");
      await once(child, "exit").catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    },
  };
}

/** Reads a server-sent event stream one named event at a time. */
function eventReader(url) {
  const controller = new AbortController();
  const decoder = new TextDecoder();
  let reader = null;
  let buffer = "";
  return {
    async next(timeoutMs = 5_000) {
      reader ??= (await fetch(url, { signal: controller.signal })).body.getReader();
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const end = buffer.indexOf("\n\n");
        if (end !== -1) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const event = block.match(/^event: (.+)$/m)?.[1];
          if (event) return { event, data: JSON.parse(block.match(/^data: (.+)$/m)?.[1] ?? "null") };
          continue;
        }
        let timer;
        const timeout = new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("no event in time")), Math.max(0, deadline - Date.now()));
        });
        const result = await Promise.race([reader.read(), timeout]).finally(() => clearTimeout(timer));
        if (result.done) throw new Error("the stream ended");
        buffer += decoder.decode(result.value, { stream: true });
      }
    },
    close: () => controller.abort(),
  };
}

async function until(condition, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function firstEvent(url) {
  const controller = new AbortController();
  const response = await fetch(url, { signal: controller.signal });
  const reader = response.body.getReader();
  let text = "";
  while (!text.includes("\n\n")) {
    const { value, done } = await reader.read();
    if (done) break;
    text += new TextDecoder().decode(value);
  }
  controller.abort();
  const event = text.match(/^event: (.+)$/m)?.[1];
  const data = JSON.parse(text.match(/^data: (.+)$/m)?.[1] ?? "null");
  return { event, data, contentType: response.headers.get("content-type") };
}

// The fake Home Assistant also refuses the WebSocket upgrade, which used to
// crash the broker with a stack overflow; the broker must keep serving.
test("broker serves weather, the kitchen speaker and presence without OpenClaw", async (t) => {
  const fakes = await startFakes();
  const broker = await startBroker(fakes);
  t.after(async () => {
    await broker.stop();
    fakes.close();
  });

  const health = await fetch(`${broker.url}/health`).then((response) => response.json());
  assert.equal(health.ok, true);
  assert.equal(health.service, "kitchen-home-broker");

  const media = await fetch(`${broker.url}/media`).then((response) => response.json());
  assert.equal(media.state, "playing");
  assert.equal(media.title, "Sounds of the Garden");
  assert.equal(media.artist, "BBC Radio 4");
  assert.match(media.artVersion, /^[0-9a-f]{12}$/);
  assert.doesNotMatch(JSON.stringify(media), /token=|media_player_proxy/, "no HA URLs leak");

  const art = await fetch(`${broker.url}/media/art`);
  assert.equal(art.headers.get("content-type"), "image/jpeg");
  assert.deepEqual(Buffer.from(await art.arrayBuffer()), ART);

  const next = await fetch(`${broker.url}/media/control`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "next" }),
  });
  assert.equal(next.status, 200);
  assert.ok(
    fakes.calls.some((call) => call.url === "/api/services/media_player/media_next_track" && call.body.entity_id === MEDIA),
  );
  const refused = await fetch(`${broker.url}/media/control`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "turn_off" }),
  });
  assert.equal(refused.status, 400, "only allowlisted actions reach Home Assistant");

  const weather = await fetch(`${broker.url}/weather`).then((response) => response.json());
  assert.equal(weather.now.temperature, 11.6);
  assert.equal(weather.today.sunset, "2026-10-06T18:41");
  assert.equal(weather.hours.length, 16);
  assert.equal(weather.hours[0].time, "2026-10-06T13:00", "starts at the current hour");
  assert.equal(weather.hours[1].precipitationProbability, 80);
  assert.ok(fakes.calls.some((call) => call.url.includes("latitude=51.4779")), "uses zone.home");

  const snapshot = await firstEvent(`${broker.url}/home/events`);
  assert.match(snapshot.contentType, /text\/event-stream/);
  assert.equal(snapshot.event, "snapshot");
  assert.equal(snapshot.data.presence.known, true);
  assert.equal(snapshot.data.presence.occupied, true);
  assert.equal(snapshot.data.presence.illuminance, 123);
  assert.equal(snapshot.data.media.title, "Sounds of the Garden");

  const { stdout } = await promisify(execFile)(process.execPath, ["scripts/check-broker.mjs"], {
    env: { ...process.env, VOICE_BROKER_URL: broker.url },
  });
  const check = JSON.parse(stdout);
  assert.equal(check.health.ok, true);
  assert.equal(check.weather.hours, 16);
  assert.equal(check.media.state, "playing");
  assert.equal(check.home.event, "snapshot");
  assert.equal(check.home.presence.occupied, true);
});

test("broker resends presence after Home Assistant's event socket comes back", async (t) => {
  const fakes = await startFakes({ websocket: true });
  const broker = await startBroker(fakes);
  const events = eventReader(`${broker.url}/home/events`);
  t.after(async () => {
    events.close();
    await broker.stop();
    fakes.close();
  });

  await until(() => fakes.authenticated() === 1);
  const first = await events.next();
  assert.equal(first.event, "snapshot");
  assert.equal(first.data.presence.occupied, true);

  // Everyone leaves while Home Assistant restarts, so no state_changed arrives.
  fakes.states["binary_sensor.kitchen_motion_sensor_motion"] = {
    state: "off",
    last_changed: "2026-10-06T12:30:00+00:00",
  };
  fakes.dropEventSockets();
  let latest = first;
  while (latest.event !== "snapshot" || latest.data.presence.occupied !== false) {
    latest = await events.next(10_000);
  }
  assert.equal(fakes.authenticated(), 2, "the broker reconnected and refreshed");
  assert.equal(latest.data.presence.changedAt, "2026-10-06T12:30:00+00:00");
});

test("broker reports an unreachable Home Assistant without breaking the stream", async (t) => {
  const meteo = await startFakes();
  const closed = createServer();
  const closedPort = await listen(closed);
  closed.close();
  const broker = await startBroker({ ...meteo, haPort: closedPort });
  t.after(async () => {
    await broker.stop();
    meteo.close();
  });
  // EventSource treats an event named "error" as a broken stream.
  const first = await firstEvent(`${broker.url}/home/events`);
  assert.equal(first.event, "unavailable");
});
