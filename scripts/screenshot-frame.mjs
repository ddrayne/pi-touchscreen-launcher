#!/usr/bin/env node
/**
 * Renders the frame at panel size (1200 x 1920) for each scene through the
 * mock bridge and writes outputs/frame-<scene>.png. Build the appliance first.
 *
 *   node scripts/screenshot-frame.mjs            # every scene
 *   node scripts/screenshot-frame.mjs night home # a few
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";

const SCENES = [
  { name: "dawn-chorus", scene: "chorus", at: "2026-06-21T04:20:00", wait: 15_000 },
  { name: "morning", scene: "quiet", at: "2026-10-06T07:45:00", wait: 3_000 },
  { name: "summer-noon", scene: "summer-noon", at: "2026-06-21T13:05:00", wait: 6_000 },
  { name: "rain", scene: "rain", at: "2026-10-06T15:10:00", wait: 3_000 },
  { name: "dusk", scene: "quiet", at: "2026-10-06T18:35:00", wait: 3_000 },
  { name: "night", scene: "night", at: "2026-10-06T23:20:00", wait: 3_500 },
  { name: "winter-noon", scene: "winter", at: "2026-12-21T12:10:00", wait: 7_000 },
  { name: "new-to-garden", scene: "new", at: "2026-10-06T09:12:00", wait: 6_000 },
  { name: "unreachable", scene: "unreachable", at: "2026-10-06T14:02:00", wait: 5_000 },
  { name: "home", scene: "quiet", at: "2026-10-06T07:45:00", wait: 2_500, query: "&mode=home" },
];

const TIMEZONE = process.env.FRAME_TZ || "Europe/London";
const ARTWORK =
  process.env.MOCK_ARTWORK ||
  ["/home/user/ddrayne/birdframe/docs/screenshots/artwork.png", "../birdframe/docs/screenshots/artwork.png"].find(
    (candidate) => existsSync(candidate),
  ) ||
  "";
const wanted = process.argv.slice(2);
const selected = wanted.length ? SCENES.filter((entry) => wanted.includes(entry.name)) : SCENES;

async function waitForServer(port) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/status`);
      if (response.ok) return;
    } catch {
      // not yet
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`mock bridge on ${port} did not start`);
}

await mkdir("outputs", { recursive: true });
const browser = await chromium.launch();
let port = 8780;
for (const entry of selected) {
  port += 1;
  const mock = spawn(process.execPath, ["scripts/mock-bridge.mjs"], {
    env: { ...process.env, TZ: TIMEZONE, PORT: String(port), MOCK_SCENE: entry.scene, MOCK_ARTWORK: ARTWORK },
    stdio: ["ignore", "inherit", "inherit"],
  });
  try {
    await waitForServer(port);
    const page = await browser.newPage({
      viewport: { width: 1200, height: 1920 },
      deviceScaleFactor: 1,
      timezoneId: TIMEZONE,
    });
    page.on("pageerror", (error) => console.error(`[${entry.name}] page error: ${error.message}`));
    page.on("console", (message) => {
      if (message.type() === "error") console.error(`[${entry.name}] console: ${message.text()}`);
    });
    await page.goto(`http://127.0.0.1:${port}/?at=${encodeURIComponent(entry.at)}${entry.query || ""}`, {
      waitUntil: "load",
    });
    await page.waitForTimeout(entry.wait);
    await page.screenshot({ path: `outputs/frame-${entry.name}.png` });
    console.log(`wrote outputs/frame-${entry.name}.png`);
    await page.close();
  } finally {
    mock.kill();
  }
}
await browser.close();
