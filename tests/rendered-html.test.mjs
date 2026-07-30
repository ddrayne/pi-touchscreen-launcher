import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders the touchscreen launcher", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>Touchscreen Assistant<\/title>/i);
  assert.match(html, /A quiet intelligence/);
  assert.match(html, /What would you like to know\?/);
  assert.match(html, /Live from BirdFrame/);
  assert.match(html, /House shopping/);
  assert.match(html, /\+ Add item/);
  assert.match(html, />Look</);
  assert.doesNotMatch(html, /HA_TOKEN|Bearer\s+[A-Za-z0-9._-]+/);
});

test("keeps shopping writes behind the narrow broker boundary", async () => {
  const [launcher, css, bridge, broker, skill] = await Promise.all([
    readFile(new URL("../components/Launcher.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../bridge/launcher_bridge.py", import.meta.url), "utf8"),
    readFile(
      new URL("../broker/openclaw_voice_broker.ts", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL(
        "../openclaw/house-shopping-list/SKILL.md",
        import.meta.url,
      ),
      "utf8",
    ),
  ]);

  assert.match(launcher, /fetch\("\/api\/shopping"/);
  assert.match(launcher, /\/api\/shopping\/items/);
  assert.match(launcher, /shopping-sheet__check/);
  assert.doesNotMatch(launcher, /HA_TOKEN|homeassistant\.local/);

  assert.match(css, /\.shopping-card/);
  assert.match(css, /\.shopping-sheet/);

  assert.match(bridge, /"\/api\/shopping"/);
  assert.match(bridge, /proxy_shopping_write/);
  assert.doesNotMatch(bridge, /HA_TOKEN/);

  assert.match(broker, /SHOPPING_ENTITY_ID/);
  assert.match(broker, /todo\/get_items\?return_response/);
  assert.match(broker, /HOME_ASSISTANT_KEYCHAIN_SERVICE/);
  assert.match(broker, /ALLOWED_IPS/);

  assert.match(skill, /canonical list is Home Assistant `todo\.shopping_list`/);
  assert.match(skill, /http:\/\/127\.0\.0\.1:18890\/shopping/);
  assert.doesNotMatch(skill, /HA_TOKEN|Bearer /);
});
