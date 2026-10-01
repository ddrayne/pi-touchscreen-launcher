"use client";

import type { CSSProperties } from "react";
import {
  formatCountdown,
  timerLabel,
  timerSecondsLeft,
  type LvaState,
  type LvaTimer,
} from "../../lib/lva";
import { useNow } from "./hooks";
import { MicIcon, StopIcon } from "./icons";

/** LVA reports pipeline errors without a reason; nothing heard means speech failed. */
function friendlyError(voice: LvaState): string {
  return !voice.heard || /stt|no-text|speech/i.test(voice.error ?? "")
    ? "I didn't catch that."
    : "That didn't work.";
}

/** What was said and what the assistant replied, like a smart display's captions. */
export function VoicePanel({ voice }: { voice: LvaState }) {
  const failed = Boolean(voice.error) && (voice.phase === "error" || voice.phase === "idle");
  const status =
    voice.phase === "wake" || voice.phase === "listening"
      ? "Listening…"
      : voice.phase === "thinking"
        ? "Thinking…"
        : failed
          ? friendlyError(voice)
          : null;
  return (
    <section
      className="voice"
      data-phase={failed ? "error" : voice.phase}
      aria-live="polite"
      aria-label="Voice assistant"
    >
      {status ? (
        <p className="voice__status">
          <span className="voice__pulse" aria-hidden="true" />
          {status}
        </p>
      ) : null}
      {voice.heard ? <p className="voice__heard">“{voice.heard}”</p> : null}
      {voice.reply ? <p className="voice__reply">{voice.reply}</p> : null}
    </section>
  );
}

export function TalkButton({
  voice,
  busy,
  onTalk,
  onStop,
}: {
  voice: LvaState;
  /** A conversation is under way (and hasn't stalled). */
  busy: boolean;
  onTalk: () => void;
  onStop: () => void;
}) {
  const active = busy && voice.phase !== "error";
  const ready = voice.connected && voice.homeAssistantConnected;
  return (
    <button
      type="button"
      className="talk"
      data-active={active}
      disabled={!voice.connected}
      onClick={active ? onStop : onTalk}
      aria-label={active ? "Stop listening" : ready ? "Talk" : "Voice is offline"}
    >
      {active ? <StopIcon /> : <MicIcon />}
      <span>{active ? "Stop" : ready ? "Talk" : "Offline"}</span>
    </button>
  );
}

/** Running timers, readable from the hob. */
export function TimerBand({ timers }: { timers: LvaTimer[] }) {
  const now = useNow(1_000).getTime();
  const running = timers.filter((timer) => !timer.ringing).slice(0, 3);
  return (
    <section className="timers" aria-label="Timers">
      {running.map((timer) => {
        const left = timerSecondsLeft(timer, now);
        const done = timer.totalSeconds ? 1 - left / timer.totalSeconds : 1;
        return (
          <div className="timer" key={timer.id}>
            <span className="timer__label">{timerLabel(timer)}</span>
            <span className="timer__time">{formatCountdown(left)}</span>
            <span
              className="timer__track"
              style={{ "--done": `${Math.min(100, Math.max(0, done * 100))}%` } as CSSProperties}
              aria-hidden="true"
            />
          </div>
        );
      })}
    </section>
  );
}

/** A finished timer takes the whole screen; a tap anywhere silences it. */
export function TimerAlarm({ timer, onStop }: { timer: LvaTimer; onStop: () => void }) {
  return (
    <button type="button" className="alarm" onClick={onStop} aria-live="assertive">
      <span className="alarm__ring" aria-hidden="true" />
      <span className="alarm__title">{timerLabel(timer)}</span>
      <span className="alarm__subtitle">is done</span>
      <span className="alarm__hint">Tap anywhere to stop</span>
    </button>
  );
}
