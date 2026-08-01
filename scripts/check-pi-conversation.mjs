import assert from "node:assert/strict";
import WebSocket from "ws";

const debuggerOrigin =
  process.env.TOUCHSCREEN_CDP_ORIGIN || "http://127.0.0.1:9223";
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
  if (!message.id || !pending.has(message.id)) return;
  pending.get(message.id)(message);
  pending.delete(message.id);
});

function call(method, params = {}) {
  return new Promise((resolve) => {
    const id = ++nextId;
    pending.set(id, resolve);
    socket.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression, userGesture = false) {
  const result = await call("Runtime.evaluate", {
    expression,
    returnByValue: true,
    userGesture,
  });
  if (result.result?.exceptionDetails) {
    throw new Error(result.result.exceptionDetails.text || "Kiosk evaluation failed");
  }
  return result.result?.result?.value;
}

async function waitFor(expression, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await evaluate(expression);
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function turnExpression(id, text) {
  return `(() => {
    const test = window.__touchscreenConversationTest;
    const channel = test?.channel;
    if (!test || !channel || channel.readyState !== "open") return false;
    const emit = (payload) => {
      const event = { data: JSON.stringify(payload) };
      for (const listener of test.messageListeners) listener.call(channel, event);
    };
    emit({ type: "input_audio_buffer.speech_started", item_id: ${JSON.stringify(id)} });
    emit({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: ${JSON.stringify(id)},
      transcript: ${JSON.stringify(text)},
    });
    emit({ type: "input_audio_buffer.speech_stopped", item_id: ${JSON.stringify(id)} });
    channel.send(JSON.stringify({
      type: "conversation.item.create",
      item: {
        id: ${JSON.stringify(id)},
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: ${JSON.stringify(text)} }],
      },
    }));
    channel.send(JSON.stringify({ type: "response.create" }));
    return true;
  })()`;
}

function followUpExpression(assistantCount) {
  return `(() => {
    const button = document.querySelector(".assistant__orb-button");
    const status = document.querySelector(".assistant__status")?.textContent || "";
    const assistants = document.querySelectorAll(
      '.assistant__utterance[data-role="assistant"]',
    ).length;
    return button?.getAttribute("data-state") === "listening" &&
      status.includes("ask a follow-up") && assistants >= ${assistantCount};
  })()`;
}

await call("Runtime.enable");
let summary;
try {
  await evaluate(`(() => {
    const prototype = RTCPeerConnection.prototype;
    if (!prototype.__touchscreenOriginalCreateDataChannel) {
      prototype.__touchscreenOriginalCreateDataChannel = prototype.createDataChannel;
      prototype.createDataChannel = function (...args) {
        const channel = prototype.__touchscreenOriginalCreateDataChannel.apply(this, args);
        const test = window.__touchscreenConversationTest;
        test.channel = channel;
        const originalAddEventListener = channel.addEventListener.bind(channel);
        channel.addEventListener = function (type, listener, options) {
          if (type === "message") test.messageListeners.push(listener);
          return originalAddEventListener(type, listener, options);
        };
        originalAddEventListener("message", (event) => {
          try {
            const payload = JSON.parse(String(event.data));
            test.serverEvents.push(payload.type || "unknown");
          } catch {}
        });
        return channel;
      };
    }
    window.__touchscreenConversationTest = {
      channel: null,
      messageListeners: [],
      serverEvents: [],
    };
    return true;
  })()`);

  const started = await evaluate(`(() => {
    const button = [...document.querySelectorAll("button")].find(
      (candidate) => candidate.getAttribute("aria-label") === "Start voice conversation",
    );
    if (!button) return false;
    button.click();
    return true;
  })()`, true);
  assert.equal(started, true, "Voice start control was not available");

  await waitFor(
    `window.__touchscreenConversationTest?.channel?.readyState === "open"`,
    20_000,
    "Realtime data channel",
  );

  assert.equal(
    await evaluate(
      turnExpression(
        "voice-test-user-1",
        "Reply with exactly this short sentence: Hello Dan.",
      ),
    ),
    true,
  );
  await waitFor(followUpExpression(1), 35_000, "first follow-up listening window");

  assert.equal(
    await evaluate(
      turnExpression(
        "voice-test-user-2",
        "As a follow-up, reply with exactly this short sentence: The sky is blue.",
      ),
    ),
    true,
  );
  await waitFor(followUpExpression(2), 35_000, "second follow-up listening window");

  summary = await evaluate(`(() => ({
    voiceState: document.querySelector(".assistant__orb-button")
      ?.getAttribute("data-state"),
    status: document.querySelector(".assistant__status")?.textContent?.trim(),
    utterances: [...document.querySelectorAll(".assistant__utterance")].map(
      (entry) => ({
        role: entry.getAttribute("data-role"),
        text: entry.textContent,
        streaming: entry.getAttribute("data-streaming"),
      }),
    ),
    eventCounts: window.__touchscreenConversationTest.serverEvents.reduce(
      (counts, type) => ({ ...counts, [type]: (counts[type] || 0) + 1 }),
      {},
    ),
  }))()`);

  assert.equal(summary.voiceState, "listening");
  assert.match(summary.status, /ask a follow-up/i);
  assert.equal(
    summary.utterances.filter((entry) => entry.role === "user").length,
    2,
  );
  assert.equal(
    summary.utterances.filter((entry) => entry.role === "assistant").length,
    2,
  );
  assert.equal(summary.utterances.some((entry) => entry.streaming === "true"), false);
} finally {
  await evaluate(`(() => {
    [...document.querySelectorAll("button")]
      .find((button) => button.getAttribute("aria-label") === "End voice conversation")
      ?.click();
  })()`, true).catch(() => undefined);
  socket.close();
}

console.log(JSON.stringify(summary, null, 2));
