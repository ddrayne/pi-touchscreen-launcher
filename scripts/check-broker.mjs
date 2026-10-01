// Checks the Mac broker the kitchen screen depends on: health, the weather,
// the kitchen speaker and the first event of the live home stream. Run it on
// the Mac, or from any address in VOICE_BROKER_ALLOWED_IPS.
const brokerUrl = (
  process.env.VOICE_BROKER_URL || "http://127.0.0.1:18890"
).replace(/\/+$/, "");

async function readJson(path) {
  const response = await fetch(`${brokerUrl}${path}`, {
    signal: AbortSignal.timeout(15_000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      `${path}: ${typeof body.error === "string" ? body.error : `HTTP ${response.status}`}`,
    );
  }
  return body;
}

async function firstEvent(path) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(`${brokerUrl}${path}`, {
      headers: { Accept: "text/event-stream" },
      signal: controller.signal,
    });
    if (!response.ok || !response.body) throw new Error(`${path}: HTTP ${response.status}`);
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let end;
      while ((end = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const event = block.match(/^event: (.+)$/m)?.[1];
        const data = block
          .split("\n")
          .filter((line) => line.startsWith("data: "))
          .map((line) => line.slice(6))
          .join("\n");
        if (event && data) return { event, data: JSON.parse(data) };
      }
    }
    throw new Error(`${path}: the stream ended before its first event`);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

const health = await readJson("/health");
const weather = await readJson("/weather");
const media = await readJson("/media");
const home = await firstEvent("/home/events");

console.log(
  JSON.stringify(
    {
      health: {
        ok: health.ok === true,
        homeAssistantConnected: health.homeAssistantConnected,
      },
      weather: {
        now: weather.now,
        hours: Array.isArray(weather.hours) ? weather.hours.length : 0,
        stale: weather.stale === true,
      },
      media: { entityId: media.entityId, state: media.state, title: media.title },
      home: {
        event: home.event,
        presence: home.data?.presence ?? null,
        media: home.data?.media?.state ?? null,
      },
    },
    null,
    2,
  ),
);
