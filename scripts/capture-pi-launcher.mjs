import { writeFile } from "node:fs/promises";
import WebSocket from "ws";

const debuggerOrigin =
  process.env.TOUCHSCREEN_CDP_ORIGIN || "http://127.0.0.1:9223";
const outputPath =
  process.env.TOUCHSCREEN_SCREENSHOT ||
  "/Users/dan/pi-touchscreen-launcher/outputs/pi-launcher.png";

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
socket.on("message", (raw) => {
  const message = JSON.parse(raw);
  if (message.id && pending.has(message.id)) {
    pending.get(message.id)(message);
    pending.delete(message.id);
  }
});
function call(method, params = {}) {
  return new Promise((resolve) => {
    const id = ++nextId;
    pending.set(id, resolve);
    socket.send(JSON.stringify({ id, method, params }));
  });
}

await call("Page.enable");
await call("Runtime.enable");
const requestedView = process.env.TOUCHSCREEN_VIEW?.trim();
if (requestedView) {
  const viewSteps = {
    home: [
      { label: "← Home", optional: true },
      { label: "Voice home" },
    ],
    household: [
      { label: "← Home", optional: true },
      { label: "Household hub" },
    ],
    shopping: [
      { label: "← Home", optional: true },
      { label: "House shopping" },
    ],
    camera: [
      { label: "← Home", optional: true },
      { label: "Voice home" },
      { label: "Look" },
    ],
  };
  const steps = viewSteps[requestedView];
  if (!steps) {
    throw new Error(
      `Unknown TOUCHSCREEN_VIEW ${JSON.stringify(requestedView)}`,
    );
  }
  for (const step of steps) {
    const { label, optional = false } = step;
    const interaction = await call("Runtime.evaluate", {
      expression: `(() => {
        const label = ${JSON.stringify(label)};
        const candidate = [...document.querySelectorAll("button")].find((button) =>
          button.getAttribute("aria-label") === label ||
          button.textContent?.trim().includes(label)
        );
        if (!candidate) return { clicked: false, label };
        candidate.click();
        return { clicked: true, label };
      })()`,
      returnByValue: true,
    });
    if (!interaction.result?.result?.value?.clicked && !optional) {
      throw new Error(`Could not open touchscreen view ${requestedView}`);
    }
    if (interaction.result?.result?.value?.clicked) {
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }
}
await new Promise((resolve) => setTimeout(resolve, 1_000));
const state = await call("Runtime.evaluate", {
  expression: `(() => ({
    href: location.href,
    title: document.title,
    bodyText: document.body?.innerText,
    viewport: { width: innerWidth, height: innerHeight, ratio: devicePixelRatio },
    scroll: {
      width: document.documentElement.scrollWidth,
      height: document.documentElement.scrollHeight,
    },
  }))()`,
  returnByValue: true,
});
const capture = await call("Page.captureScreenshot", {
  format: "png",
  fromSurface: true,
  captureBeyondViewport: false,
});
if (!capture.result?.data) throw new Error("Chromium returned no screenshot");
await writeFile(outputPath, Buffer.from(capture.result.data, "base64"));
console.log(
  JSON.stringify(
    { outputPath, ...state.result?.result?.value },
    null,
    2,
  ),
);
socket.close();
