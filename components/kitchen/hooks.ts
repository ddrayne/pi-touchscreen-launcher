"use client";

import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import {
  connectLva,
  dismissTimer,
  initialLvaState,
  reduceLva,
  reduceLvaConnection,
  type LvaClient,
  type LvaMessage,
  type LvaState,
} from "../../lib/lva";
import type { PresenceSnapshot } from "../../lib/presence";

export type MediaSnapshot = {
  entityId: string;
  state: string;
  title: string | null;
  artist: string | null;
  album: string | null;
  source: string | null;
  volume: number | null;
  muted: boolean;
  artVersion: string | null;
};

export function useNow(intervalMs: number): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/** True from `at` until `windowMs` later; false when `at` is zero. */
export function useRecent(at: number, windowMs: number): boolean {
  const [expired, setExpired] = useState(0);
  useEffect(() => {
    if (!at) return;
    const timer = window.setTimeout(
      () => setExpired(at),
      Math.max(0, at + windowMs - Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [at, windowMs]);
  return at > 0 && expired !== at;
}

/**
 * Fetch JSON now and on an interval, keeping the last good value through
 * failures; `updatedAt` says how old it is. Changing `refreshKey` (for
 * example on waking) fetches again.
 */
export function usePolledJson<T>(
  url: string,
  intervalMs: number,
  refreshKey: string,
): { data: T | null; failed: boolean; updatedAt: number } {
  const [state, setState] = useState<{ data: T | null; failed: boolean; updatedAt: number }>({
    data: null,
    failed: false,
    updatedAt: 0,
  });
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const response = await fetch(url, { cache: "no-store" });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = (await response.json()) as T;
        if (!cancelled) setState({ data, failed: false, updatedAt: Date.now() });
      } catch {
        if (!cancelled) setState((current) => ({ ...current, failed: true }));
      }
    };
    const first = window.setTimeout(load, 0);
    const timer = window.setInterval(load, intervalMs);
    return () => {
      cancelled = true;
      window.clearTimeout(first);
      window.clearInterval(timer);
    };
  }, [url, intervalMs, refreshKey]);
  return state;
}

/** Kitchen presence and the kitchen speaker, pushed by the broker as they change. */
export function useHomeEvents(): {
  presence: PresenceSnapshot | null;
  media: MediaSnapshot | null;
  connected: boolean;
} {
  const [state, setState] = useState<{
    presence: PresenceSnapshot | null;
    media: MediaSnapshot | null;
    connected: boolean;
  }>({ presence: null, media: null, connected: false });

  useEffect(() => {
    let events: EventSource | null = null;
    let retry: number | undefined;
    let delay = 2_000;
    const read = (event: Event) => {
      try {
        return JSON.parse((event as MessageEvent<string>).data) as Record<string, unknown>;
      } catch {
        return null;
      }
    };
    const connect = () => {
      const source = new EventSource("/api/home/events");
      events = source;
      source.addEventListener("snapshot", (event) => {
        const data = read(event);
        if (!data) return;
        delay = 2_000;
        setState({
          presence: (data.presence as PresenceSnapshot) ?? null,
          media: (data.media as MediaSnapshot) ?? null,
          connected: true,
        });
      });
      source.addEventListener("presence", (event) => {
        const data = read(event);
        if (data) {
          setState((current) => ({ ...current, presence: data as PresenceSnapshot, connected: true }));
        }
      });
      source.addEventListener("media", (event) => {
        const data = read(event);
        if (data) setState((current) => ({ ...current, media: data as MediaSnapshot }));
      });
      // The broker can't reach Home Assistant, so nothing it knew is current.
      source.addEventListener("unavailable", () => {
        setState({ presence: null, media: null, connected: false });
      });
      source.onerror = () => {
        setState((current) => ({ ...current, connected: false }));
        // The browser retries a dropped stream by itself, but an error
        // response (the broker unreachable) closes an EventSource for good.
        if (source.readyState === EventSource.CLOSED) {
          retry = window.setTimeout(connect, delay);
          delay = Math.min(delay * 2, 30_000);
        }
      };
    };
    connect();
    return () => {
      window.clearTimeout(retry);
      events?.close();
    };
  }, []);

  return state;
}

type LvaAction =
  | { type: "message"; message: LvaMessage; now: number }
  | { type: "connection"; connected: boolean }
  | { type: "dismiss"; id: string };

function lvaReducer(state: LvaState, action: LvaAction): LvaState {
  switch (action.type) {
    case "message":
      return reduceLva(state, action.message, action.now);
    case "connection":
      return reduceLvaConnection(state, action.connected);
    case "dismiss":
      return dismissTimer(state, action.id);
  }
}

/** The Pi's Home Assistant voice satellite: timers, captions and push-to-talk. */
export function useLva(url: string): {
  state: LvaState;
  send: (command: string) => boolean;
  dismiss: (id: string) => void;
} {
  const [state, dispatch] = useReducer(lvaReducer, initialLvaState);
  const client = useRef<LvaClient | null>(null);

  useEffect(() => {
    const connection = connectLva(url, {
      onMessage: (message) => dispatch({ type: "message", message, now: Date.now() }),
      onConnection: (connected) => dispatch({ type: "connection", connected }),
    });
    client.current = connection;
    return () => {
      connection.close();
      client.current = null;
    };
  }, [url]);

  const send = useCallback((command: string) => client.current?.send(command) ?? false, []);
  const dismiss = useCallback((id: string) => dispatch({ type: "dismiss", id }), []);
  return { state, send, dismiss };
}

/**
 * Ask the bridge to power the backlight down while the kitchen is empty, and
 * keep asking until it confirms: a dark panel the screen believes is awake
 * would never wake again. A change of `nudge` (a touch) retries at once.
 */
export function useDisplaySleep(asleep: boolean, nudge: number): void {
  const confirmed = useRef<boolean | null>(null);
  useEffect(() => {
    if (confirmed.current === asleep) return;
    let cancelled = false;
    let retry: number | undefined;
    const attempt = async (delay: number) => {
      try {
        const response = await fetch("/api/display", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ awake: !asleep }),
        });
        const result = (await response.json().catch(() => ({}))) as {
          ok?: boolean;
          supported?: boolean;
        };
        if (cancelled) return;
        // No backlight to control is an answer too: retrying can't change it.
        if (response.ok && (result.ok === true || result.supported === false)) {
          confirmed.current = asleep;
          return;
        }
      } catch {
        if (cancelled) return;
      }
      retry = window.setTimeout(() => void attempt(Math.min(delay * 2, 30_000)), delay);
    };
    void attempt(2_000);
    return () => {
      cancelled = true;
      window.clearTimeout(retry);
    };
  }, [asleep, nudge]);
}

/** Plays BirdFrame's recordings, one at a time. */
export function useClipPlayer(): {
  playing: string | null;
  play: (src: string) => void;
  stop: () => void;
} {
  const audio = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);

  const stop = useCallback(() => {
    audio.current?.pause();
    audio.current = null;
    setPlaying(null);
  }, []);

  const play = useCallback((src: string) => {
    audio.current?.pause();
    const element = new Audio(src);
    audio.current = element;
    setPlaying(src);
    const finish = () => {
      if (audio.current !== element) return;
      audio.current = null;
      setPlaying(null);
    };
    element.addEventListener("ended", finish);
    element.addEventListener("error", finish);
    void element.play().catch(finish);
  }, []);

  useEffect(() => {
    const player = audio;
    return () => player.current?.pause();
  }, []);

  return { playing, play, stop };
}
