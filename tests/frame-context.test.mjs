import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { DEFAULT_FRAME_CONFIG } from "../lib/frame/config.ts";
import { gardenContext } from "../lib/frame/context.ts";
import { parseSnapshot } from "../lib/frame/scene.ts";

test("the voice session is told what the garden is doing", async () => {
  const raw = JSON.parse(await readFile(new URL("../fixtures/now-morning.json", import.meta.url), "utf8"));
  const received = new Date(2026, 9, 6, 7, 42, 10).getTime();
  const snapshot = parseSnapshot({ ...raw, new_today: ["Redwing"] }, received);
  const text = gardenContext(received, DEFAULT_FRAME_CONFIG, snapshot, {
    condition: "partlycloudy",
    temperature: 12,
    windSpeed: 14,
    windSpeedUnit: "km/h",
  });
  assert.match(text, /Edinburgh window/);
  assert.match(text, /most recent bird was a Eurasian Blackbird at 07:41 \(confirmed, 91% confidence\)/);
  assert.match(text, /Eurasian Blackbird \(5 calls, confirmed, last 07:41\)/);
  assert.match(text, /9 species have been heard today/);
  assert.match(text, /New to this garden today.*Redwing/);
  assert.match(text, /partly ?cloudy, 12°C, wind 14 km\/h/);
  assert.ok(text.length < 1_500, `${text.length} characters`);
  const offline = gardenContext(received, DEFAULT_FRAME_CONFIG, null, null);
  assert.match(offline, /not reachable/);
});
