"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import {
  InlineRealtimeVoice,
  type InlineVoiceStatus,
  type InlineVoiceTranscript,
} from "../lib/realtimeVoice";

type WindowSpecies = {
  common_name: string;
  count: number;
  tier?: string;
};

type BirdframeNow = {
  latest?: {
    common_name?: string;
    confidence?: number;
    at?: string;
    seconds_ago?: number;
  };
  today_species_count?: number;
  window_minutes?: number;
  window_species?: WindowSpecies[];
};

type ApplianceStatus = {
  gatewayReady?: boolean;
  voiceReady?: boolean;
  birdframeReady?: boolean;
  birdframeRunning?: boolean;
  wakeReady?: boolean;
};

type WakeStatus = {
  pending?: boolean;
  sequence?: number;
  muted?: boolean;
};

type ConversationEntry = {
  id: number;
  role: "user" | "assistant";
  text: string;
  streaming: boolean;
};

const fallbackBirds: BirdframeNow = {
  latest: {
    common_name: "The garden is listening",
    confidence: 0,
    at: "",
  },
  today_species_count: 0,
  window_minutes: 60,
  window_species: [],
};

function timeAgo(seconds: number | undefined): string {
  if (typeof seconds !== "number" || seconds < 0) return "waiting for a call";
  if (seconds < 60) return "heard just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes === 1) return "heard a minute ago";
  if (minutes < 60) return `heard ${minutes} minutes ago`;
  const hours = Math.floor(minutes / 60);
  return `heard ${hours} ${hours === 1 ? "hour" : "hours"} ago`;
}

function formatClock(now: Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(now);
}

function formatDate(now: Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(now);
}

function updateConversation(
  entries: ConversationEntry[],
  update: InlineVoiceTranscript,
): ConversationEntry[] {
  const text = update.text;
  if (!text.trim()) return entries;
  const next = [...entries];
  const last = next.at(-1);
  if (last?.role === update.role && last.streaming) {
    const merged = update.final
      ? text.startsWith(last.text)
        ? text
        : last.text.toLowerCase().startsWith(text.toLowerCase().slice(0, 12))
          ? text
          : `${last.text}${text}`
      : `${last.text}${text}`;
    next[next.length - 1] = { ...last, text: merged, streaming: !update.final };
  } else {
    if (last?.streaming) next[next.length - 1] = { ...last, streaming: false };
    next.push({
      id: Date.now() + Math.floor(Math.random() * 1000),
      role: update.role,
      text: text.trimStart(),
      streaming: !update.final,
    });
  }
  return next.slice(-6);
}

export function Launcher() {
  const [now, setNow] = useState(() => new Date());
  const [status, setStatus] = useState<ApplianceStatus>({});
  const [birds, setBirds] = useState<BirdframeNow>(fallbackBirds);
  const [voiceState, setVoiceState] = useState<InlineVoiceStatus>("idle");
  const [voiceDetail, setVoiceDetail] = useState<string | null>(null);
  const [inputLevel, setInputLevel] = useState(0);
  const [conversation, setConversation] = useState<ConversationEntry[]>([]);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [cameraFrame, setCameraFrame] = useState(() => Date.now());
  const lastWakeSequence = useRef(0);
  const voiceSession = useRef<InlineRealtimeVoice | null>(null);
  const voiceActive = voiceState !== "idle";

  const muteWake = useCallback((seconds: number) => {
    void fetch("/api/wake", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "mute", seconds }),
    }).catch(() => undefined);
  }, []);

  const refresh = useCallback(async () => {
    const [statusResult, birdResult] = await Promise.allSettled([
      fetch("/api/status", { cache: "no-store" }).then((response) => {
        if (!response.ok) throw new Error("status unavailable");
        return response.json() as Promise<ApplianceStatus>;
      }),
      fetch("/api/birdframe", { cache: "no-store" }).then((response) => {
        if (!response.ok) throw new Error("BirdFrame unavailable");
        return response.json() as Promise<BirdframeNow>;
      }),
    ]);

    if (statusResult.status === "fulfilled") setStatus(statusResult.value);
    if (birdResult.status === "fulfilled") setBirds(birdResult.value);
  }, []);

  useEffect(() => {
    const initial = window.setTimeout(() => void refresh(), 0);
    const clock = window.setInterval(() => setNow(new Date()), 15_000);
    const poll = window.setInterval(() => void refresh(), 20_000);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(clock);
      window.clearInterval(poll);
    };
  }, [refresh]);

  const stopVoice = useCallback(() => {
    const current = voiceSession.current;
    voiceSession.current = null;
    current?.stop();
    muteWake(4);
    setVoiceState("idle");
    setVoiceDetail(null);
    setInputLevel(0);
  }, [muteWake]);

  const startVoice = useCallback(async () => {
    if (voiceSession.current) return;
    muteWake(30);
    setConversation([]);
    setVoiceState("connecting");
    setVoiceDetail("Connecting to OpenClaw");
    const session = new InlineRealtimeVoice({
      onStatus: (nextState, detail) => {
        if (voiceSession.current !== session) return;
        setVoiceState(nextState);
        setVoiceDetail(detail || null);
      },
      onInputLevel: (level) => {
        if (voiceSession.current === session) setInputLevel(level);
      },
      onTranscript: (entry) => {
        if (voiceSession.current === session) {
          setConversation((current) => updateConversation(current, entry));
        }
      },
      onIdleTimeout: () => {
        if (voiceSession.current === session) stopVoice();
      },
    });
    voiceSession.current = session;
    try {
      await session.start();
    } catch (error) {
      if (voiceSession.current !== session) return;
      voiceSession.current = null;
      session.stop();
      muteWake(4);
      setVoiceState("error");
      setVoiceDetail(error instanceof Error ? error.message : String(error));
      setInputLevel(0);
    }
  }, [muteWake, stopVoice]);

  const toggleVoice = useCallback(() => {
    if (voiceSession.current) stopVoice();
    else void startVoice();
  }, [startVoice, stopVoice]);

  useEffect(() => {
    const watchWake = window.setInterval(() => {
      void fetch("/api/wake", { cache: "no-store" })
        .then((response) => response.json() as Promise<WakeStatus>)
        .then((wake) => {
          const sequence = wake.sequence || 0;
          if (
            wake.pending &&
            sequence > lastWakeSequence.current
          ) {
            lastWakeSequence.current = sequence;
            void startVoice();
            void fetch("/api/wake", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ action: "ack", sequence }),
            });
          }
        })
        .catch(() => undefined);
    }, 900);
    return () => window.clearInterval(watchWake);
  }, [startVoice]);

  useEffect(() => {
    if (!voiceActive) return;
    const keepMuted = window.setInterval(() => muteWake(30), 10_000);
    return () => window.clearInterval(keepMuted);
  }, [muteWake, voiceActive]);

  useEffect(() => () => voiceSession.current?.stop(), []);

  const closeCamera = useCallback(() => {
    setCameraOpen(false);
    setCameraError(null);
  }, []);

  const openCamera = useCallback(() => {
    stopVoice();
    setCameraOpen(true);
    setCameraError(null);
    setCameraFrame(Date.now());
  }, [stopVoice]);

  useEffect(() => {
    if (!cameraOpen) return;
    const refreshCamera = window.setInterval(
      () => setCameraFrame(Date.now()),
      2_000,
    );
    return () => window.clearInterval(refreshCamera);
  }, [cameraOpen]);

  const openBirdframe = useCallback(async () => {
    stopVoice();
    try {
      await fetch("/api/window", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target: "birdframe" }),
      });
    } catch {
      // The live card remains useful in a desktop preview without the Pi bridge.
    }
  }, [stopVoice]);

  const species = birds.window_species?.slice(0, 4) ?? [];
  const latestName = birds.latest?.common_name || "The garden is listening";
  const gatewayReady = status.gatewayReady === true;
  const voiceReady = status.voiceReady === true;
  const birdframeReady = status.birdframeReady !== false;
  const assistantPrompt =
    voiceState === "connecting"
      ? "Waking up…"
      : voiceState === "listening"
        ? "I’m listening."
        : voiceState === "thinking"
          ? "Let me look into that."
          : voiceState === "speaking"
            ? "Here’s what I found."
            : voiceState === "error"
              ? "I couldn’t start the conversation."
              : "What would you like to know?";
  const orbStyle = {
    "--voice-level": String(Math.max(0.04, inputLevel)),
  } as CSSProperties;

  return (
    <main className="launcher">
      <div className="launcher__frame">
        <header className="launcher__masthead">
          <div>
            <p className="launcher__eyebrow">Touchscreen · home</p>
            <h1 className="launcher__place">A quiet intelligence</h1>
          </div>
          <div className="launcher__clock" aria-label={now.toLocaleString()}>
            <time className="launcher__time">{formatClock(now)}</time>
            <span className="launcher__date">{formatDate(now)}</span>
          </div>
        </header>

        <section
          className="assistant"
          data-active={voiceActive}
          aria-labelledby="assistant-prompt"
        >
          <button
            className="assistant__orb-button"
            data-state={voiceState}
            type="button"
            onClick={toggleVoice}
            aria-label={voiceActive ? "End voice conversation" : "Start voice conversation"}
            style={orbStyle}
          >
            <span className="assistant__ring" />
            <span className="assistant__ring assistant__ring--middle" />
            <span className="assistant__ring assistant__ring--inner" />
            <span className="assistant__orb" />
          </button>
          <h2 className="assistant__prompt" id="assistant-prompt">
            {assistantPrompt}
          </h2>
          {conversation.length ? (
            <div
              className="assistant__conversation"
              aria-live="polite"
              aria-label="Voice conversation"
            >
              {conversation.slice(-4).map((entry) => (
                <p
                  className="assistant__utterance"
                  data-role={entry.role}
                  data-streaming={entry.streaming}
                  key={entry.id}
                >
                  <span>{entry.role === "user" ? "You" : "Assistant"}</span>
                  {entry.text}
                </p>
              ))}
            </div>
          ) : (
            <p className="assistant__hint">
              {voiceState === "error"
                ? voiceDetail ||
                  "End this conversation, then touch the light again to retry."
                : status.wakeReady
                  ? "Say “Computer” or touch the listening light to talk."
                  : "Touch the listening light to talk."}
            </p>
          )}
          {voiceActive ? (
            <button type="button" className="assistant__end" onClick={stopVoice}>
              End conversation
            </button>
          ) : null}
          <div className="assistant__status">
            <span className="status-dot" data-ready={gatewayReady && voiceReady} />
            {voiceActive
              ? voiceDetail || "Voice is live"
              : gatewayReady && voiceReady
                ? "OpenClaw voice is ready"
                : "Connecting to OpenClaw"}
          </div>
        </section>

        <section className="launcher__lower" aria-label="Home applications">
          <button
            type="button"
            className="bird-card"
            onClick={openBirdframe}
            disabled={!birdframeReady}
          >
            <span className="bird-card__open">Open journal →</span>
            <p className="bird-card__eyebrow">Live from BirdFrame</p>
            <h2 className="bird-card__title">{latestName}</h2>
            <p className="bird-card__meta">
              {timeAgo(birds.latest?.seconds_ago)}
              {birds.today_species_count
                ? ` · ${birds.today_species_count} voices today`
                : ""}
            </p>
            <div className="bird-card__voices">
              {species.length > 0 ? (
                species.map((entry) => (
                  <span className="bird-card__voice" key={entry.common_name}>
                    {entry.common_name} · {entry.count}
                  </span>
                ))
              ) : (
                <span className="bird-card__voice">
                  Listening across the last {birds.window_minutes || 60} minutes
                </span>
              )}
            </div>
          </button>

          <div className="launcher__actions">
            <button
              type="button"
              className="launcher__action"
              onClick={toggleVoice}
            >
              <span className="launcher__action-icon">◎</span>
              <span className="launcher__action-label">Talk</span>
            </button>
            <button
              type="button"
              className="launcher__action"
              onClick={openCamera}
            >
              <span className="launcher__action-icon">◉</span>
              <span className="launcher__action-label">Look</span>
            </button>
          </div>
        </section>
      </div>

      {cameraOpen ? (
        <section className="camera-sheet" aria-label="Camera preview">
          <header className="camera-sheet__bar">
            <button
              type="button"
              className="camera-sheet__close"
              onClick={closeCamera}
            >
              ← Home
            </button>
            <p className="camera-sheet__eyebrow">Camera · private preview</p>
            <span aria-hidden="true">●</span>
          </header>
          <div className="camera-sheet__view">
            {/* The native camera endpoint is intentionally a changing JPEG URL. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={`/api/camera.jpg?frame=${cameraFrame}`}
              alt="Live view from the Raspberry Pi camera"
              onLoad={() => setCameraError(null)}
              onError={() =>
                setCameraError("The camera could not be opened. Trying again…")
              }
            />
            {cameraError ? (
              <p className="camera-sheet__message">{cameraError}</p>
            ) : null}
            <span className="camera-sheet__privacy">
              Native camera preview · stays on this Pi
            </span>
          </div>
        </section>
      ) : null}
    </main>
  );
}
