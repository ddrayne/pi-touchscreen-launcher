import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("voice broker uses the headless gateway client identity", async () => {
  const source = await readFile(
    new URL("../broker/openclaw_voice_broker.ts", import.meta.url),
    "utf8",
  );

  assert.match(source, /clientName: GATEWAY_CLIENT_NAMES\.GATEWAY_CLIENT/);
  assert.match(source, /mode: GATEWAY_CLIENT_MODES\.BACKEND/);
  assert.match(source, /const SESSION_KEY = "agent:main:main"/);
  assert.doesNotMatch(source, /clientName: GATEWAY_CLIENT_NAMES\.CONTROL_UI/);
  assert.doesNotMatch(source, /origin: \"http:\/\/127\.0\.0\.1:18789\"/);
  assert.doesNotMatch(source, /const SESSION_KEY = "main"/);
});
