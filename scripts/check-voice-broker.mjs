import { randomUUID } from "node:crypto";

const brokerUrl = (
  process.env.VOICE_BROKER_URL || "http://127.0.0.1:18890"
).replace(/\/+$/, "");

async function readJson(response) {
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      typeof result.error === "string"
        ? result.error
        : `HTTP ${response.status}`,
    );
  }
  return result;
}

const health = await readJson(await fetch(`${brokerUrl}/health`));
const session = await readJson(
  await fetch(`${brokerUrl}/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  }),
);
const callId = `broker-probe-${randomUUID()}`;
const consult = await readJson(
  await fetch(`${brokerUrl}/tool`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      callId,
      name: "openclaw_agent_consult",
      args: {
        question:
          "This is an automated voice-path health check. Reply with a brief confirmation.",
        responseStyle: "One short sentence.",
      },
    }),
  }),
);

console.log(
  JSON.stringify(
    {
      health: health.ok === true,
      session: {
        provider: session.provider,
        transport: session.transport,
        model: session.model,
        voice: session.voice,
        hasClientSecret:
          typeof session.clientSecret === "string" &&
          session.clientSecret.length > 0,
        expiresAt: session.expiresAt,
      },
      consult: {
        ok:
          typeof consult.result === "string" &&
          consult.result.trim().length > 0,
        resultCharacters:
          typeof consult.result === "string" ? consult.result.length : 0,
        error: typeof consult.error === "string" ? consult.error : undefined,
      },
    },
    null,
    2,
  ),
);
