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
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function emitExpression(payload) {
  return `(() => {
    const test = window.__touchscreenInterruptionTest;
    if (!test?.channel) return false;
    const event = { data: ${JSON.stringify(JSON.stringify(payload))} };
    for (const listener of test.messageListeners) listener.call(test.channel, event);
    return true;
  })()`;
}

function sendTextTurnExpression(id, text) {
  return `(() => {
    const channel = window.__touchscreenInterruptionTest?.channel;
    if (!channel || channel.readyState !== "open") return false;
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

await call("Runtime.enable");
await call("Page.enable");
await call("Page.reload", { ignoreCache: true });
await waitFor(
  `document.readyState === "complete" && Boolean(document.querySelector(".assistant__orb-button"))`,
  10_000,
  "reloaded launcher",
);
let summary;
try {
  await evaluate(`(() => {
    const prototype = RTCPeerConnection.prototype;
    if (!prototype.__touchscreenOriginalCreateDataChannel) {
      prototype.__touchscreenOriginalCreateDataChannel = prototype.createDataChannel;
      prototype.createDataChannel = function (...args) {
        const channel = prototype.__touchscreenOriginalCreateDataChannel.apply(this, args);
        const test = window.__touchscreenInterruptionTest;
        test.peer = this;
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
            if (payload.type === "session.created") {
              test.turnDetection = payload.session?.audio?.input?.turn_detection ?? null;
              test.sessionVoice = payload.session?.audio?.output?.voice ?? null;
            }
            if (
              payload.type === "conversation.output_transcript.delta" ||
              payload.type === "response.audio_transcript.delta" ||
              payload.type === "response.output_audio_transcript.delta"
            ) {
              requestAnimationFrame(() => {
                const text = [...document.querySelectorAll(
                  '.assistant__utterance[data-role="assistant"][data-streaming="true"] .assistant__utterance-copy',
                )].at(-1)?.textContent || "";
                if (text && test.streamSnapshots.at(-1) !== text) {
                  test.streamSnapshots.push(text);
                }
              });
            }
          } catch {}
        });
        return channel;
      };
    }
    window.__touchscreenInterruptionTest = {
      peer: null,
      channel: null,
      messageListeners: [],
      serverEvents: [],
      turnDetection: null,
      sessionVoice: null,
      streamSnapshots: [],
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
    `window.__touchscreenInterruptionTest?.channel?.readyState === "open"`,
    20_000,
    "Realtime data channel",
  );

  const firstId = "voice-interrupt-user-1";
  await evaluate(emitExpression({
    type: "input_audio_buffer.speech_started",
    item_id: firstId,
  }));
  await evaluate(emitExpression({
    type: "conversation.item.input_audio_transcription.completed",
    item_id: firstId,
    transcript: "Count slowly from one to twenty, one number at a time.",
  }));
  await evaluate(emitExpression({
    type: "input_audio_buffer.speech_stopped",
    item_id: firstId,
  }));
  assert.equal(
    await evaluate(
      sendTextTurnExpression(
        firstId,
        "Count slowly from one to twenty, one number at a time.",
      ),
    ),
    true,
  );

  await waitFor(
    `window.__touchscreenInterruptionTest.serverEvents.includes("output_audio_buffer.started")`,
    25_000,
    "assistant playback",
  );
  await waitFor(
    `window.__touchscreenInterruptionTest.peer?.getSenders().some(
      (sender) => sender.track?.kind === "audio" && sender.track.enabled
    )`,
    3_000,
    "guarded microphone reopening",
  );

  const secondId = "voice-interrupt-user-2";
  await evaluate(emitExpression({
    type: "input_audio_buffer.speech_started",
    item_id: secondId,
  }));
  const interruptionStatus = await evaluate(
    `document.querySelector(".assistant__status")?.textContent?.trim()`,
  );
  assert.match(interruptionStatus, /go ahead/i);

  await evaluate(`(() => {
    const test = window.__touchscreenInterruptionTest;
    const responseDone = test.serverEvents.includes("response.done");
    if (!responseDone) test.channel.send(JSON.stringify({ type: "response.cancel" }));
    test.channel.send(JSON.stringify({ type: "output_audio_buffer.clear" }));
    return true;
  })()`);
  await waitFor(
    `window.__touchscreenInterruptionTest.serverEvents.includes("output_audio_buffer.cleared")`,
    5_000,
    "interrupted audio buffer clear",
  );

  await evaluate(emitExpression({
    type: "conversation.item.input_audio_transcription.completed",
    item_id: secondId,
    transcript: "Stop counting. Say exactly: Interruption heard.",
  }));
  await evaluate(emitExpression({
    type: "input_audio_buffer.speech_stopped",
    item_id: secondId,
  }));
  assert.equal(
    await evaluate(
      sendTextTurnExpression(
        secondId,
        "Stop counting. Say exactly: Interruption heard.",
      ),
    ),
    true,
  );

  await waitFor(
    `(() => {
      const status = document.querySelector(".assistant__status")?.textContent || "";
      const text = [...document.querySelectorAll(
        '.assistant__utterance[data-role="assistant"]',
      )].at(-1)?.textContent || "";
      return /ask a follow-up/i.test(status) && /interruption heard/i.test(text);
    })()`,
    30_000,
    "replacement response and follow-up window",
  );

  summary = await evaluate(`(() => ({
    interruptionStatus: ${JSON.stringify(interruptionStatus)},
    voiceState: document.querySelector(".assistant__orb-button")
      ?.getAttribute("data-state"),
    status: document.querySelector(".assistant__status")?.textContent?.trim(),
    lastAssistant: [...document.querySelectorAll(
      '.assistant__utterance[data-role="assistant"]',
    )].at(-1)?.textContent,
    microphoneEnabled: window.__touchscreenInterruptionTest.peer?.getSenders().some(
      (sender) => sender.track?.kind === "audio" && sender.track.enabled
    ),
    turnDetection: window.__touchscreenInterruptionTest.turnDetection,
    sessionVoice: window.__touchscreenInterruptionTest.sessionVoice,
    streamSamples: window.__touchscreenInterruptionTest.streamSnapshots
      .filter((text) => text.length >= 12)
      .slice(-8),
    eventCounts: window.__touchscreenInterruptionTest.serverEvents.reduce(
      (counts, type) => ({ ...counts, [type]: (counts[type] || 0) + 1 }),
      {},
    ),
  }))()`);

  assert.equal(summary.voiceState, "listening");
  assert.equal(summary.microphoneEnabled, true);
  assert.equal(summary.turnDetection?.threshold, 0.62);
  assert.equal(summary.turnDetection?.silence_duration_ms, 650);
  assert.equal(summary.turnDetection?.prefix_padding_ms, 300);
  assert.equal(summary.turnDetection?.interrupt_response, true);
  assert.equal(summary.sessionVoice, "marin");
  assert.ok(summary.streamSamples.some((text) => /\s/.test(text)));
  assert.equal(
    summary.streamSamples.some((text) => text.length >= 48 && !/\s/.test(text)),
    false,
  );
  assert.ok(summary.eventCounts["output_audio_buffer.cleared"] >= 1);
} finally {
  await evaluate(`(() => {
    [...document.querySelectorAll("button")]
      .find((button) => button.getAttribute("aria-label") === "End voice conversation")
      ?.click();
  })()`, true).catch(() => undefined);
  socket.close();
}

console.log(JSON.stringify(summary, null, 2));
