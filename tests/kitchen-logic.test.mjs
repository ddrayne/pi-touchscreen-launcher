import assert from "node:assert/strict";
import test from "node:test";

import {
  dismissTimer,
  formatCountdown,
  initialLvaState,
  liveTimers,
  reduceLva,
  reduceLvaConnection,
  timerLabel,
  timerSecondsLeft,
  voiceBusy,
} from "../lib/lva.ts";
import {
  bridgeClipPath,
  describeFreshness,
  photoPathFor,
  summariseGarden,
} from "../lib/birds.ts";
import { describeWeather, hourLabel, rainSummary, upcomingHours } from "../lib/weather.ts";
import { isNight, shouldSleep } from "../lib/presence.ts";

function replay(events, start = 1_000) {
  return events.reduce(
    (state, message, index) => reduceLva(state, message, start + index * 1_000),
    initialLvaState,
  );
}

test("follows a voice turn from wake word to reply", () => {
  const state = replay([
    { event: "wake_word_detected" },
    { event: "listening" },
    { event: "stt_text", data: { text: "set a pasta timer for ten minutes" } },
    { event: "thinking" },
    { event: "tts_text", data: { text: "Pasta timer started." } },
    { event: "tts_speaking" },
  ]);
  assert.equal(state.phase, "speaking");
  assert.equal(state.heard, "set a pasta timer for ten minutes");
  assert.equal(state.reply, "Pasta timer started.");

  const stillSpeaking = reduceLva(state, { event: "tts_finished" }, 8_000);
  assert.equal(stillSpeaking.phase, "speaking", "idle or a follow-up comes straight after");
  const finished = reduceLva(stillSpeaking, { event: "idle" }, 9_000);
  assert.equal(finished.phase, "idle");
  assert.equal(finished.reply, "Pasta timer started.", "captions linger after idle");

  const next = reduceLva(finished, { event: "wake_word_detected" }, 10_000);
  assert.equal(next.heard, null, "a new turn clears the old captions");
  assert.equal(next.reply, null);
});

test("reports pipeline errors and Home Assistant connectivity", () => {
  let state = reduceLva(initialLvaState, { event: "zeroconf", data: { status: "connected" } }, 1);
  assert.equal(state.homeAssistantConnected, true);
  state = reduceLva(state, { event: "pipeline_error", data: { reason: "stt-no-text-recognized" } }, 2);
  assert.equal(state.phase, "error");
  assert.equal(state.error, "stt-no-text-recognized");
  // LVA ends the failed run straight away; the error stays up like a caption.
  const ended = replay([{ event: "pipeline_error" }, { event: "tts_finished" }, { event: "idle" }]);
  assert.equal(ended.phase, "idle");
  assert.equal(ended.error, "pipeline-error");
  assert.equal(ended.activityAt, 3_000);
  assert.equal(reduceLva(ended, { event: "wake_word_detected" }, 9_000).error, null);
  state = reduceLva(state, { event: "disconnected" }, 3);
  assert.equal(state.homeAssistantConnected, false);
  assert.equal(reduceLva(state, { event: "something_new" }, 4), state);
  assert.equal(reduceLva(state, { event: "snapshot", data: { muted: true } }, 5).muted, true);
});

test("tracks named timers, counts down locally, and clears cancellations", () => {
  let state = reduceLva(
    initialLvaState,
    { event: "timer_ticking", data: { id: "a", name: "pasta", total_seconds: 600, seconds_left: 600 } },
    0,
  );
  state = reduceLva(
    state,
    { event: "timer_ticking", data: { id: "b", name: "", total_seconds: 120, seconds_left: 120 } },
    0,
  );
  assert.deepEqual(state.timers.map((timer) => timer.id), ["b", "a"], "soonest first");
  assert.equal(timerSecondsLeft(state.timers[1], 18_200), 582);
  assert.equal(timerLabel(state.timers[1]), "Pasta");
  assert.equal(timerLabel(state.timers[0]), "2 minute timer");

  state = reduceLva(
    state,
    { event: "timer_updated", data: { id: "b", name: "", total_seconds: 120, seconds_left: 0 } },
    1_000,
  );
  assert.deepEqual(state.timers.map((timer) => timer.id), ["a"], "zero seconds means cancelled");

  state = reduceLva(
    state,
    { event: "timer_ringing", data: { id: "a", name: "pasta", total_seconds: 600, seconds_left: 0 } },
    600_000,
  );
  assert.equal(state.timers[0].ringing, true);
  assert.equal(timerSecondsLeft(state.timers[0], 700_000), 0);
  assert.deepEqual(dismissTimer(state, "a").timers, []);

  const ignored = reduceLva(state, { event: "timer_ticking", data: { name: "no id" } }, 1);
  assert.equal(ignored, state, "a timer without an id is ignored");
});

test("lets a ringing timer go when it is silenced, but not when a reply ends", () => {
  const pasta = { id: "a", name: "pasta", total_seconds: 600, seconds_left: 0 };
  const bread = { id: "b", name: "bread", total_seconds: 900, seconds_left: 500 };
  const ringing = replay([
    { event: "timer_ticking", data: bread },
    { event: "timer_ringing", data: pasta },
  ]);
  assert.deepEqual(ringing.timers.map((timer) => [timer.id, timer.ringing]), [["a", true], ["b", false]]);

  // "Stop" (or the stop command) ends with a bare idle outside a conversation.
  const stopped = reduceLva(ringing, { event: "idle" }, 5_000);
  assert.deepEqual(stopped.timers.map((timer) => timer.id), ["b"]);

  // The wake word silences it too.
  const woken = reduceLva(ringing, { event: "wake_word_detected" }, 5_000);
  assert.deepEqual(woken.timers.map((timer) => timer.id), ["b"]);

  // A timer that goes off during a reply keeps ringing after the reply ends.
  const midReply = replay([
    { event: "wake_word_detected" },
    { event: "listening" },
    { event: "thinking" },
    { event: "tts_speaking" },
    { event: "timer_ringing", data: pasta },
    { event: "tts_finished" },
    { event: "idle" },
  ]);
  assert.equal(midReply.phase, "idle");
  assert.equal(midReply.timers[0].ringing, true);
});

test("lets go of timers and conversations LVA stopped reporting", () => {
  const timers = replay([
    { event: "timer_ringing", data: { id: "a", name: "", total_seconds: 60, seconds_left: 0 } },
    { event: "timer_ticking", data: { id: "b", name: "", total_seconds: 60, seconds_left: 60 } },
  ], 0).timers;
  const minute = 60_000;
  assert.equal(liveTimers(timers, 14 * minute), timers, "unchanged while all are live");
  assert.deepEqual(liveTimers(timers, 15 * minute).map((timer) => timer.id), ["b"]);
  assert.deepEqual(liveTimers(timers, 16 * minute + 2_000), []);

  const listening = reduceLva(initialLvaState, { event: "listening" }, 0);
  assert.equal(voiceBusy(listening, 60_000), true);
  assert.equal(voiceBusy(listening, 121_000), false, "a stalled pipeline stops holding the screen");
  assert.equal(voiceBusy(initialLvaState, 0), false);
});

test("formats countdowns and resets on disconnect", () => {
  assert.equal(formatCountdown(402), "6:42");
  assert.equal(formatCountdown(59.2), "1:00");
  assert.equal(formatCountdown(3723), "1:02:03");
  assert.equal(formatCountdown(-5), "0:00");

  const listening = reduceLva(
    reduceLvaConnection(initialLvaState, true),
    { event: "listening" },
    1,
  );
  const dropped = reduceLvaConnection(listening, false);
  assert.equal(dropped.connected, false);
  assert.equal(dropped.phase, "idle");
});

const window = [
  { common_name: "Robin", scientific_name: "Erithacus rubecula", tier: "confirmed", clip_url: "/api/clip/2026-10-06/Robin" },
  { common_name: "Wren", scientific_name: "Troglodytes troglodytes", tier: "probable", clip_url: null },
  { common_name: "Nightingale", scientific_name: "Luscinia megarhynchos", tier: "tentative" },
  { common_name: "Eurasian Blackbird", scientific_name: "Turdus merula", tier: "confirmed" },
];

test("picks the latest reliable bird and the ones heard before it", () => {
  const summary = summariseGarden({
    now: "13:10:00",
    latest: { common_name: "Robin", scientific_name: "Erithacus rubecula", at: "13:09:20", seconds_ago: 40, tier: "confirmed" },
    feed: [
      { common_name: "Robin", scientific_name: "Erithacus rubecula", at: "13:09:20" },
      { common_name: "Nightingale", scientific_name: "Luscinia megarhynchos", at: "13:08:00" },
      { common_name: "Wren", scientific_name: "Troglodytes troglodytes", at: "13:05:00" },
      { common_name: "Wren", scientific_name: "Troglodytes troglodytes", at: "13:04:00" },
      { common_name: "Eurasian Blackbird", scientific_name: "Turdus merula", at: "12:58:00" },
    ],
    window_species: window,
    today_species_count: 11,
    new_today: ["Robin"],
  });
  assert.equal(summary.hero.commonName, "Robin");
  assert.equal(summary.hero.label, "Singing now");
  assert.equal(summary.hero.clipPath, "/api/birdframe/clip/2026-10-06/Robin");
  assert.equal(summary.hero.photoPath, "/api/birds/photo?name=Erithacus%20rubecula");
  assert.equal(summary.hero.firstEver, true);
  assert.deepEqual(summary.earlier, ["Wren", "Eurasian Blackbird"], "no tentative birds, no repeats");
  assert.equal(summary.voicesToday, 11);
  assert.equal(summary.quiet, false);
});

test("skips a tentative latest detection and falls back to the feed", () => {
  const summary = summariseGarden({
    now: "00:20:00",
    latest: { common_name: "Nightingale", scientific_name: "Luscinia megarhynchos", at: "00:19:00", seconds_ago: 60, tier: "tentative" },
    feed: [
      { common_name: "Nightingale", scientific_name: "Luscinia megarhynchos", at: "00:19:00" },
      { common_name: "Eurasian Blackbird", scientific_name: "Turdus merula", at: "23:50:00" },
    ],
    window_species: window,
  });
  assert.equal(summary.hero.commonName, "Eurasian Blackbird");
  assert.equal(summary.hero.secondsAgo, 1_800, "counts back across midnight");
  assert.equal(summary.hero.label, "Heard 30 minutes ago");
  assert.equal(summary.hero.clipPath, null);
});

test("reports a quiet garden and maps clip paths safely", () => {
  assert.equal(summariseGarden(null).quiet, true);
  assert.equal(summariseGarden({ feed: [], window_species: [] }).hero, null);
  assert.deepEqual(describeFreshness(4 * 3600, "09:05:00"), {
    freshness: "earlier",
    label: "Last heard at 09:05",
  });
  assert.equal(describeFreshness(65).label, "Singing now");
  assert.equal(describeFreshness(200).label, "Heard 3 minutes ago");
  assert.equal(bridgeClipPath("/api/clip/2026-10-06/Song%20Thrush"), "/api/birdframe/clip/2026-10-06/Song%20Thrush");
  assert.equal(bridgeClipPath("/api/clip/../../etc/passwd"), null);
  assert.equal(bridgeClipPath("https://example.com/api/clip/2026-10-06/Robin"), null);
  assert.equal(photoPathFor("Turdus merula"), "/api/birds/photo?name=Turdus%20merula");
});

function hours(probabilities, startHour = 7) {
  return probabilities.map((probability, index) => ({
    time: `2026-10-06T${String(startHour + index).padStart(2, "0")}:00`,
    temperature: 10,
    precipitationProbability: probability,
    precipitation: 0,
    weatherCode: 3,
  }));
}

test("turns the hourly forecast into one rain decision", () => {
  assert.deepEqual(rainSummary(hours([5, 10, 10, 20, 35, 40, 45, 70, 85, 60, 30])), {
    kind: "later",
    text: "Rain from 2pm",
  });
  assert.deepEqual(rainSummary(hours([80, 70, 40, 10])), { kind: "now", text: "Rain until 9am" });
  assert.deepEqual(rainSummary(hours([80, 90, 95])), { kind: "now", text: "Rain all day" });
  assert.deepEqual(rainSummary(hours([10, 30, 20])), { kind: "showers", text: "A shower is possible" });
  assert.deepEqual(rainSummary(hours([0, 5, 10])), { kind: "dry", text: "Dry" });
  assert.equal(rainSummary([]).kind, "unknown");
  const forecast = hours([10, 20, 70, 80]);
  const later = upcomingHours(forecast, new Date(2026, 9, 6, 8, 40));
  assert.deepEqual(later.map((hour) => hour.time), forecast.slice(1).map((hour) => hour.time));
  assert.equal(upcomingHours(forecast, new Date(2026, 9, 7, 0, 0)).length, 0);
  assert.equal(hourLabel("2026-10-06T00:00"), "midnight");
  assert.equal(hourLabel("2026-10-06T12:00"), "midday");
  assert.equal(hourLabel("2026-10-06T09:00"), "9am");
  assert.equal(describeWeather(61), "Rain");
  assert.equal(describeWeather(null), "");
});

test("sleeps only when the kitchen has been empty for a while", () => {
  const base = {
    now: Date.parse("2026-10-06T13:20:00Z"),
    presence: { known: true, occupied: false, changedAt: "2026-10-06T13:10:00Z" },
    lastTouchAt: 0,
    timersActive: false,
    voiceActive: false,
    sleepAfterMs: 5 * 60_000,
  };
  assert.equal(shouldSleep(base), true);
  assert.equal(shouldSleep({ ...base, presence: { ...base.presence, occupied: true } }), false);
  assert.equal(shouldSleep({ ...base, presence: null }), false, "no sensor data keeps it awake");
  assert.equal(shouldSleep({ ...base, presence: { ...base.presence, known: false } }), false);
  assert.equal(shouldSleep({ ...base, timersActive: true }), false);
  assert.equal(shouldSleep({ ...base, voiceActive: true }), false);
  assert.equal(shouldSleep({ ...base, lastTouchAt: base.now - 60_000 }), false);
  assert.equal(isNight(new Date(2026, 9, 6, 22, 0)), true);
  assert.equal(isNight(new Date(2026, 9, 6, 7, 30)), false);
});
