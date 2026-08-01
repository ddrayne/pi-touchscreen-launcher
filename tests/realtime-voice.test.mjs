import assert from "node:assert/strict";
import test from "node:test";

import { InlineRealtimeVoice } from "../lib/realtimeVoice.ts";
import { updateVoiceConversation } from "../lib/voiceConversation.ts";

function installWindowShim() {
  const original = globalThis.window;
  globalThis.window = {
    setTimeout,
    clearTimeout,
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => undefined,
  };
  return () => {
    if (original === undefined) delete globalThis.window;
    else globalThis.window = original;
  };
}

test("deduplicates completed greeting transcripts", () => {
  let entries = updateVoiceConversation([], {
    id: "assistant-1",
    role: "assistant",
    text: "Hello Dan!",
    final: false,
  }, () => 1);
  entries = updateVoiceConversation(entries, {
    id: "assistant-1",
    role: "assistant",
    text: "Hello Dan!",
    final: false,
  }, () => 2);
  entries = updateVoiceConversation(entries, {
    id: "assistant-1",
    role: "assistant",
    text: "Hello Dan!",
    final: true,
  }, () => 3);
  entries = updateVoiceConversation(entries, {
    id: "assistant-1",
    role: "assistant",
    text: "Hello Dan.",
    final: true,
  }, () => 4);

  assert.deepEqual(entries, [
    {
      id: 1,
      transcriptId: "assistant-1",
      role: "assistant",
      text: "Hello Dan.",
      streaming: false,
    },
  ]);
});

test("merges final user text that arrives during assistant output", () => {
  let nextId = 0;
  const createId = () => ++nextId;
  let entries = updateVoiceConversation([], {
    id: "user-1",
    role: "user",
    text: "Hello,can you hear me?",
    final: false,
  }, createId);
  entries = updateVoiceConversation(entries, {
    id: "assistant-1",
    role: "assistant",
    text: "Yes,",
    final: false,
  }, createId);
  entries = updateVoiceConversation(entries, {
    id: "user-1",
    role: "user",
    text: "Hello, can you hear me?",
    final: true,
  }, createId);
  entries = updateVoiceConversation(entries, {
    id: "assistant-1",
    role: "assistant",
    text: " I can hear you.",
    final: false,
  }, createId);
  entries = updateVoiceConversation(entries, {
    id: "assistant-1",
    role: "assistant",
    text: "Yes, I can hear you.",
    final: true,
  }, createId);

  assert.deepEqual(entries, [
    {
      id: 1,
      transcriptId: "user-1",
      role: "user",
      text: "Hello, can you hear me?",
      streaming: false,
    },
    {
      id: 2,
      transcriptId: "assistant-1",
      role: "assistant",
      text: "Yes, I can hear you.",
      streaming: false,
    },
  ]);
});

test("reopens the microphone for a follow-up after response playback", async () => {
  const restoreWindow = installWindowShim();
  const statuses = [];
  let idleTimeouts = 0;
  const track = { enabled: true, stop: () => undefined };
  const voice = new InlineRealtimeVoice({
    onStatus: (status, detail) => statuses.push({ status, detail }),
    onInputLevel: () => undefined,
    onTranscript: () => undefined,
    onIdleTimeout: () => {
      idleTimeouts += 1;
    },
  });

  voice.media = {
    getAudioTracks: () => [track],
    getTracks: () => [track],
  };
  voice.meter = { stop: () => undefined };
  voice.handleEvent(JSON.stringify({ type: "input_audio_buffer.speech_stopped" }));
  assert.equal(track.enabled, false);
  assert.equal(voice.turnLocked, true);

  voice.handleEvent(
    JSON.stringify({
      type: "response.output_audio_transcript.delta",
      delta: "Here you go.",
    }),
  );
  voice.handleEvent(JSON.stringify({ type: "output_audio_buffer.started" }));
  voice.handleEvent(JSON.stringify({ type: "response.done" }));
  assert.equal(track.enabled, false);

  voice.handleEvent(JSON.stringify({ type: "output_audio_buffer.stopped" }));
  await new Promise((resolve) => setTimeout(resolve, 750));

  assert.equal(track.enabled, true);
  assert.equal(voice.turnLocked, false);
  assert.equal(idleTimeouts, 0);
  assert.deepEqual(statuses.at(-1), {
    status: "listening",
    detail: "I’m listening — ask a follow-up",
  });

  voice.stop();
  restoreWindow();
});
