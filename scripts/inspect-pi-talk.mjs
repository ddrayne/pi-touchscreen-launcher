import WebSocket from "ws";

const debuggerOrigin =
  process.env.TOUCHSCREEN_CDP_ORIGIN || "http://127.0.0.1:9223";
const noAction = process.env.TOUCHSCREEN_NO_ACTION === "1";
const stopAfter = process.env.TOUCHSCREEN_STOP_AFTER === "1";
const pages = await fetch(`${debuggerOrigin}/json/list`).then((response) =>
  response.json(),
);
const page = pages.find((entry) => entry.type === "page");
if (!page) throw new Error("No Chromium page target found");

const socketUrl = page.webSocketDebuggerUrl.replace(
  "127.0.0.1:9222",
  new URL(debuggerOrigin).host,
);
const socket = new WebSocket(socketUrl);
await new Promise((resolve, reject) => {
  socket.once("open", resolve);
  socket.once("error", reject);
});

let nextId = 0;
const pending = new Map();
const providerResponses = [];
const browserEvents = [];

socket.on("message", (raw) => {
  const message = JSON.parse(raw);
  if (message.id && pending.has(message.id)) {
    pending.get(message.id)(message);
    pending.delete(message.id);
    return;
  }
  if (
    message.method === "Network.responseReceived" &&
    (message.params?.response?.url?.includes("api.openai.com") ||
      message.params?.response?.url?.includes("/api/voice/"))
  ) {
    providerResponses.push({
      requestId: message.params.requestId,
      url: message.params.response.url,
      status: message.params.response.status,
      statusText: message.params.response.statusText,
    });
    return;
  }
  if (
    message.method === "Runtime.exceptionThrown" ||
    message.method === "Log.entryAdded"
  ) {
    browserEvents.push(message);
  }
});

function call(method, params = {}) {
  return new Promise((resolve) => {
    const id = ++nextId;
    pending.set(id, resolve);
    socket.send(JSON.stringify({ id, method, params }));
  });
}

await call("Runtime.enable");
await call("Log.enable");
await call("Network.enable");
if (!noAction) {
  await call("Runtime.evaluate", {
    expression: `(() => {
      [...document.querySelectorAll("button")]
        .find((button) =>
          button.getAttribute("aria-label") === "Start voice conversation"
        )
        ?.click();
    })()`,
    returnByValue: true,
    userGesture: true,
  });
}

await new Promise((resolve) => setTimeout(resolve, noAction ? 2_000 : 8_000));

const stateResult = await call("Runtime.evaluate", {
  expression: `(() => ({
    text: (document.body?.innerText || "").slice(0, 2_400),
    voiceState: document.querySelector(".assistant__orb-button")
      ?.getAttribute("data-state"),
    prompt: document.querySelector(".assistant__prompt")?.textContent,
    utterances: [...document.querySelectorAll(".assistant__utterance")]
      .map((entry) => ({
        role: entry.getAttribute("data-role"),
        text: entry.textContent,
        streaming: entry.getAttribute("data-streaming"),
      })),
    remoteAudio: [...document.querySelectorAll("audio")]
      .map((audio) => ({
        paused: audio.paused,
        readyState: audio.readyState,
        hasStream: audio.srcObject instanceof MediaStream,
      })),
    voiceControls: [...document.querySelectorAll("button")]
      .map((button) => button.getAttribute("aria-label"))
      .filter((label) => label?.toLowerCase().includes("voice")),
  }))()`,
  returnByValue: true,
});

console.log(
  JSON.stringify(
    {
      state: stateResult.result.result.value,
      responses: providerResponses.map((response) => ({
        url: response.url,
        status: response.status,
        statusText: response.statusText,
      })),
      events: browserEvents
        .map(
          (event) =>
            event.params?.entry?.text ||
            event.params?.exceptionDetails?.text,
        )
        .filter(Boolean),
    },
    null,
    2,
  ),
);
if (stopAfter) {
  await call("Runtime.evaluate", {
    expression: `(() => {
      [...document.querySelectorAll("button")]
        .find((button) =>
          button.getAttribute("aria-label") === "End voice conversation"
        )
        ?.click();
    })()`,
    returnByValue: true,
    userGesture: true,
  });
}
socket.close();
