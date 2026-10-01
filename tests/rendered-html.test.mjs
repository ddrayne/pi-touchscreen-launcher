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

function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

test("server-renders the kitchen screen before any data arrives", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>Kitchen Screen<\/title>/i);
  assert.match(html, /aria-label="Kitchen screen"/);
  assert.match(html, /Listening to the garden/);
  assert.match(html, /BirdFrame is listening/);
  assert.match(html, /aria-label="Voice is offline"/);
  assert.doesNotMatch(html, /HA_TOKEN|Bearer\s+[A-Za-z0-9._-]+/);
});

test("keeps Home Assistant, the microphone and shopping behind narrow boundaries", async () => {
  const [screen, hooks, bridge, broker, skill, voiceUnit, kioskUnit, install] =
    await Promise.all([
      source("components/KitchenScreen.tsx"),
      source("components/kitchen/hooks.ts"),
      source("bridge/launcher_bridge.py"),
      source("broker/openclaw_voice_broker.ts"),
      source("openclaw/house-shopping-list/SKILL.md"),
      source("deploy/pi/linux-voice-assistant.service"),
      source("deploy/pi/touchscreen-launcher.service"),
      source("deploy/pi/install.sh"),
    ]);

  // The screen talks to the Pi's own bridge and to Linux Voice Assistant on loopback.
  assert.match(screen, /ws:\/\/127\.0\.0\.1:6055/);
  assert.match(hooks, /\/api\/home\/events/);
  assert.match(screen, /\/api\/media\/control/);
  for (const client of [screen, hooks]) {
    assert.doesNotMatch(client, /HA_TOKEN|homeassistant\.local|192\.168\./);
  }

  // The bridge proxies; it never holds a Home Assistant token or the V1 voice routes.
  assert.match(bridge, /"\/api\/shopping"/);
  assert.match(bridge, /"\/api\/home\/events"/);
  assert.match(bridge, /"\/api\/display"/);
  assert.doesNotMatch(bridge, /HA_TOKEN/);
  assert.doesNotMatch(bridge, /\/api\/(voice|wake|camera)/);

  // The broker stands alone, keeps its allowlists and reads the token from Keychain.
  assert.doesNotMatch(broker, /from ["'][^"']*openclaw/i);
  assert.match(broker, /ALLOWED_IPS/);
  assert.match(broker, /HOME_ASSISTANT_KEYCHAIN_SERVICE/);
  assert.match(broker, /const MEDIA_SERVICES: Record<string, string> = \{/);
  assert.match(broker, /SHOPPING_ENTITY_ID/);
  assert.match(broker, /todo\/get_items\?return_response/);
  assert.match(broker, /shopping_list_updated/);

  // The voice satellite's peripheral socket has no auth: loopback only.
  assert.match(voiceUnit, /^Environment=PERIPHERAL_HOST=127\.0\.0\.1$/m);
  // Chromium no longer gets the microphone or V1's extension.
  assert.doesNotMatch(kioskUnit, /use-fake-ui-for-media-stream|load-extension/);
  assert.match(install, /disable --now touchscreen-wake\.service/);

  assert.match(skill, /canonical list is Home Assistant `todo\.shopping_list`/);
  assert.match(skill, /http:\/\/127\.0\.0\.1:18890\/shopping/);
  assert.doesNotMatch(skill, /HA_TOKEN|Bearer /);
});
