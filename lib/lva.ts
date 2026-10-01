/**
 * Linux Voice Assistant (LVA) peripheral API.
 *
 * LVA runs on the Pi as the Home Assistant voice satellite. It exposes a local,
 * unauthenticated WebSocket for displays and LEDs; the kitchen screen connects
 * to it to show timers, the voice pipeline's state, and what was said.
 * https://github.com/OHF-Voice/linux-voice-assistant/blob/main/docs/peripheral_api.md
 */

export type VoicePhase =
  | "idle"
  | "wake"
  | "listening"
  | "thinking"
  | "speaking"
  | "error";

export type LvaTimer = {
  id: string;
  name: string;
  totalSeconds: number;
  secondsLeft: number;
  /** Epoch milliseconds when `secondsLeft` was reported. */
  reportedAt: number;
  ringing: boolean;
};

export type LvaState = {
  connected: boolean;
  homeAssistantConnected: boolean;
  phase: VoicePhase;
  heard: string | null;
  reply: string | null;
  error: string | null;
  muted: boolean;
  /** Epoch milliseconds of the latest voice pipeline event. */
  activityAt: number;
  timers: LvaTimer[];
};

export type LvaMessage = {
  event?: unknown;
  data?: unknown;
};

export const initialLvaState: LvaState = {
  connected: false,
  homeAssistantConnected: false,
  phase: "idle",
  heard: null,
  reply: null,
  error: null,
  muted: false,
  activityAt: 0,
  timers: [],
};

type Record_ = Record<string, unknown>;

function asRecord(value: unknown): Record_ {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record_)
    : {};
}

function cleanText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/\s+/g, " ").trim();
  return text ? text.slice(0, 400) : null;
}

function wholeSeconds(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.round(value))
    : null;
}

function readTimer(data: Record_, now: number, ringing: boolean): LvaTimer | null {
  const id = typeof data.id === "string" && data.id ? data.id : null;
  const secondsLeft = wholeSeconds(data.seconds_left);
  if (!id || secondsLeft === null) return null;
  const totalSeconds = wholeSeconds(data.total_seconds) ?? secondsLeft;
  return {
    id,
    name: cleanText(data.name) ?? "",
    totalSeconds: Math.max(totalSeconds, secondsLeft),
    secondsLeft,
    reportedAt: now,
    ringing,
  };
}

/** LVA's own limit (`--timer-max-ring-seconds`): it stops ringing silently after this. */
export const TIMER_RING_LIMIT_MS = 15 * 60_000;
/** A pipeline that has gone this long without an event has stalled. */
const VOICE_STALL_MS = 2 * 60_000;

function withoutRinging(timers: LvaTimer[]): LvaTimer[] {
  return timers.some((timer) => timer.ringing) ? timers.filter((timer) => !timer.ringing) : timers;
}

function upsertTimer(timers: LvaTimer[], timer: LvaTimer): LvaTimer[] {
  const others = timers.filter((entry) => entry.id !== timer.id);
  return [...others, timer].sort(
    (left, right) =>
      Number(right.ringing) - Number(left.ringing) ||
      left.secondsLeft - right.secondsLeft,
  );
}

/**
 * Apply one peripheral API event. Unknown events leave the state unchanged.
 *
 * LVA never reports that a ringing timer was silenced by voice: the wake word
 * stops it (`wake_word_detected`), and "stop" or the stop command end with a
 * bare `idle` outside any conversation. An `idle` that ends a conversation is
 * left alone, because a timer that went off mid-reply is still ringing.
 */
export function reduceLva(state: LvaState, message: LvaMessage, now: number): LvaState {
  const event = typeof message.event === "string" ? message.event : "";
  const data = asRecord(message.data);
  switch (event) {
    case "snapshot":
      return {
        ...state,
        muted: data.muted === true,
        homeAssistantConnected: data.ha_connected !== false,
        heard: cleanText(data.last_stt_text) ?? state.heard,
        reply: cleanText(data.last_tts_text) ?? state.reply,
      };
    case "wake_word_detected":
      return {
        ...state,
        phase: "wake",
        heard: null,
        reply: null,
        error: null,
        activityAt: now,
        timers: withoutRinging(state.timers),
      };
    case "listening":
      return { ...state, phase: "listening", error: null, activityAt: now };
    case "stt_text":
      return { ...state, heard: cleanText(data.text), activityAt: now };
    case "thinking":
      return { ...state, phase: "thinking", activityAt: now };
    case "tts_text":
      return { ...state, reply: cleanText(data.text), activityAt: now };
    case "tts_speaking":
      return { ...state, phase: "speaking", activityAt: now };
    case "tts_finished":
      // Always followed at once by `idle`, or `listening` for a follow-up.
      return state;
    case "idle":
      if (state.phase === "idle") {
        const timers = withoutRinging(state.timers);
        return timers === state.timers ? state : { ...state, timers };
      }
      // Errors stay up for the caption linger; the next turn clears them.
      return { ...state, phase: "idle", activityAt: now };
    case "pipeline_error":
      return {
        ...state,
        phase: "error",
        error: cleanText(data.reason) ?? "pipeline-error",
        activityAt: now,
      };
    case "disconnected":
      return { ...state, homeAssistantConnected: false };
    case "zeroconf":
      return { ...state, homeAssistantConnected: data.status === "connected" };
    case "muted":
      return { ...state, muted: data.muted === true };
    case "timer_ticking":
    case "timer_ringing": {
      const timer = readTimer(data, now, event === "timer_ringing");
      return timer ? { ...state, timers: upsertTimer(state.timers, timer) } : state;
    }
    case "timer_updated": {
      const timer = readTimer(data, now, false);
      if (!timer) return state;
      // A cancelled timer arrives as an update with no time left.
      if (timer.secondsLeft <= 0) {
        return { ...state, timers: state.timers.filter((entry) => entry.id !== timer.id) };
      }
      return { ...state, timers: upsertTimer(state.timers, timer) };
    }
    default:
      return state;
  }
}

export function reduceLvaConnection(state: LvaState, connected: boolean): LvaState {
  if (state.connected === connected) return state;
  return connected
    ? { ...state, connected: true }
    : { ...state, connected: false, homeAssistantConnected: false, phase: "idle" };
}

/** Drop a timer locally once the user has dismissed it. */
export function dismissTimer(state: LvaState, id: string): LvaState {
  return { ...state, timers: state.timers.filter((timer) => timer.id !== id) };
}

/**
 * Timers still worth showing. LVA stops a ringing timer by itself after
 * fifteen minutes without telling anyone, so the screen lets it go then too,
 * and also lets go of a countdown whose end it never heard about.
 */
export function liveTimers(timers: LvaTimer[], now: number): LvaTimer[] {
  const live = timers.filter((timer) => {
    const endsAt = timer.reportedAt + (timer.ringing ? 0 : timer.secondsLeft * 1000);
    return now - endsAt < TIMER_RING_LIMIT_MS;
  });
  return live.length === timers.length ? timers : live;
}

/** True while a conversation is under way, unless it has stalled. */
export function voiceBusy(state: LvaState, now: number): boolean {
  return state.phase !== "idle" && now - state.activityAt < VOICE_STALL_MS;
}

export function timerSecondsLeft(timer: LvaTimer, now: number): number {
  if (timer.ringing) return 0;
  const elapsed = Math.max(0, (now - timer.reportedAt) / 1000);
  return Math.max(0, Math.ceil(timer.secondsLeft - elapsed));
}

export function formatCountdown(totalSeconds: number): string {
  const seconds = Math.max(0, Math.ceil(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = String(seconds % 60).padStart(2, "0");
  return hours
    ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}`
    : `${minutes}:${rest}`;
}

/** "Pasta", or "10 minute timer" when the timer was set without a name. */
export function timerLabel(timer: LvaTimer): string {
  if (timer.name) return timer.name.charAt(0).toUpperCase() + timer.name.slice(1);
  const minutes = Math.round(timer.totalSeconds / 60);
  if (timer.totalSeconds < 60) return `${timer.totalSeconds} second timer`;
  if (minutes < 60) return `${minutes} minute timer`;
  const hours = Math.round((timer.totalSeconds / 3600) * 10) / 10;
  return `${hours} hour timer`;
}

export type LvaClient = {
  send: (command: string, data?: Record_) => boolean;
  close: () => void;
};

/**
 * Connect to LVA's peripheral socket and keep reconnecting with backoff.
 * LVA may start after the kiosk, restart, or be absent in a desktop preview.
 */
export function connectLva(
  url: string,
  handlers: {
    onMessage: (message: LvaMessage) => void;
    onConnection: (connected: boolean) => void;
  },
): LvaClient {
  let socket: WebSocket | null = null;
  let closed = false;
  let retryDelay = 1_000;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  const open = () => {
    if (closed || typeof WebSocket === "undefined") return;
    try {
      socket = new WebSocket(url);
    } catch {
      scheduleRetry();
      return;
    }
    const current = socket;
    current.onopen = () => {
      retryDelay = 1_000;
      handlers.onConnection(true);
    };
    current.onmessage = (event) => {
      try {
        handlers.onMessage(JSON.parse(String(event.data)) as LvaMessage);
      } catch {
        // Ignore malformed frames; the next event resynchronises.
      }
    };
    current.onclose = () => {
      if (socket === current) socket = null;
      handlers.onConnection(false);
      scheduleRetry();
    };
    current.onerror = () => current.close();
  };

  const scheduleRetry = () => {
    if (closed || retryTimer) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      open();
    }, retryDelay);
    retryDelay = Math.min(retryDelay * 2, 15_000);
  };

  open();
  return {
    send(command, data) {
      if (!socket || socket.readyState !== WebSocket.OPEN) return false;
      socket.send(JSON.stringify(data ? { command, data } : { command }));
      return true;
    },
    close() {
      closed = true;
      if (retryTimer) clearTimeout(retryTimer);
      socket?.close();
    },
  };
}
