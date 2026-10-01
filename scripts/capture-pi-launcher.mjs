// Screenshots the kitchen screen as Chromium on the Pi shows it, through the
// kiosk's DevTools port (forward it first: ssh -L 9223:127.0.0.1:9222 the Pi).
import { writeFile } from "node:fs/promises";
import WebSocket from "ws";

const debuggerOrigin =
  process.env.TOUCHSCREEN_CDP_ORIGIN || "http://127.0.0.1:9223";
const outputPath =
  process.env.TOUCHSCREEN_SCREENSHOT ||
  "/Users/dan/pi-touchscreen-launcher/outputs/kitchen-screen.png";

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
