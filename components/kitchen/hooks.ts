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
 * failures. Changing `refreshKey` (for example on waking) fetches again.
 */
export function usePolledJson<T>(
  url: string,
  intervalMs: number,
  refreshKey: string,
): { data: T | null; failed: boolean } {
  const [state, setState] = useState<{ data: T | null; failed: boolean }>({
    data: null,
    failed: false,
  });
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const response = await fetch(url, { cache: "no-store" });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = (await response.json()) as T;
        if (!cancelled) setState({ data, failed: false });
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
    const events = new EventSource("/api/home/events");
    const read = (event: Event) => {
      try {
        return JSON.parse((event as MessageEvent<string>).data) as Record<string, unknown>;
      } catch {
        return null;
      }
    };
    events.addEventListener("snapshot", (event) => {
      const data = read(event);
      if (!data) return;
      setState({
        presence: (data.presence as PresenceSnapshot) ?? null,
        media: (data.media as MediaSnapshot) ?? null,
        connected: true,
      });
    });
    events.addEventListener("presence", (event) => {
      const data = read(event);
      if (data) setState((current) => ({ ...current, presence: data as PresenceSnapshot }));
    });
    events.addEventListener("media", (event) => {
      const data = read(event);
      if (data) setState((current) => ({ ...current, media: data as MediaSnapshot }));
    });
    events.onerror = () => setState((current) => ({ ...current, connected: false }));
    return () => events.close();
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

/** Ask the bridge to power the backlight down while the kitchen is empty. */
export function useDisplaySleep(asleep: boolean): void {
  const last = useRef<boolean | null>(null);
  useEffect(() => {
    if (last.current === asleep) return;
    last.current = asleep;
    void fetch("/api/display", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ awake: !asleep }),
    }).catch(() => undefined);
  }, [asleep]);
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
