/**
 * The live connection to BirdFrame through the Pi bridge: server-sent events
 * when the bridge offers them, a twenty-second poll when it does not.
 */

import { useEffect, useState } from "react";
import { frameNow, withFrameTime } from "./clock.ts";
import { discardBody, readJson as readJsonBody } from "../http.ts";
import {
  applyDetection,
  parseDetection,
  parseSnapshot,
  type FrameSnapshot,
} from "./scene.ts";

export type BirdframeStream = {
  snapshot: FrameSnapshot | null;
  /** BirdFrame answered recently. */
  reachable: boolean;
  /** When the bridge last confirmed it was listening, frame time. */
  heartbeat: number;
  connection: "connecting" | "stream" | "poll" | "offline";
};

const POLL_MS = 20_000;

function readJson(text: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function useBirdframeStream(): BirdframeStream {
  const [state, setState] = useState<BirdframeStream>({
    snapshot: null,
    reachable: false,
    heartbeat: 0,
    connection: "connecting",
  });

  useEffect(() => {
    let closed = false;
    let pollTimer = 0;
    let source: EventSource | null = null;

    const acceptSnapshot = (now: unknown, today: unknown, reachable: boolean) => {
      if (closed) return;
      const receivedAt = frameNow();
      setState((current) => ({
        ...current,
        snapshot: now ? parseSnapshot(now, receivedAt, today) : current.snapshot,
        reachable,
        heartbeat: receivedAt,
      }));
    };

    const poll = async () => {
      try {
        const [now, today] = await Promise.all([
          fetch(withFrameTime("/api/birdframe"), { cache: "no-store" }).then((response) =>
            readJsonBody<unknown>(response, "BirdFrame unavailable"),
          ),
          fetch(withFrameTime("/api/birdframe/today"), { cache: "no-store" })
            .then(async (response) => {
              if (response.ok) return (await response.json()) as unknown;
              await discardBody(response);
              return undefined;
            })
            .catch(() => undefined),
        ]);
        acceptSnapshot(now, today, true);
      } catch {
        if (!closed) setState((current) => ({ ...current, reachable: false }));
      }
    };

    const startPolling = () => {
      if (pollTimer || closed) return;
      setState((current) => ({ ...current, connection: "poll" }));
      void poll();
      pollTimer = window.setInterval(() => void poll(), POLL_MS);
    };

    const stopPolling = () => {
      if (!pollTimer) return;
      window.clearInterval(pollTimer);
      pollTimer = 0;
    };

    if (typeof EventSource === "undefined") {
      startPolling();
    } else {
      source = new EventSource(withFrameTime("/api/birdframe/events"));
      source.addEventListener("open", () => {
        stopPolling();
        setState((current) => ({ ...current, connection: "stream" }));
      });
      source.addEventListener("snapshot", (event) => {
        const data = readJson((event as MessageEvent<string>).data);
        if (!data) return;
        acceptSnapshot(data.now, data.today, data.reachable !== false);
      });
      source.addEventListener("detection", (event) => {
        const data = readJson((event as MessageEvent<string>).data);
        const detection = data ? parseDetection(data, frameNow()) : null;
        if (!detection) return;
        setState((current) => ({
          ...current,
          snapshot: current.snapshot ? applyDetection(current.snapshot, detection) : current.snapshot,
          reachable: true,
          heartbeat: frameNow(),
        }));
      });
      source.addEventListener("heartbeat", (event) => {
        const data = readJson((event as MessageEvent<string>).data) ?? {};
        setState((current) => ({
          ...current,
          reachable: data.reachable !== false,
          heartbeat: frameNow(),
        }));
      });
      source.addEventListener("error", () => {
        // EventSource reconnects by itself; keep the painting fed meanwhile.
        if (source?.readyState === EventSource.CLOSED) startPolling();
        else setState((current) => ({ ...current, connection: "connecting" }));
      });
      // An old bridge without the stream answers 404; fall back after a moment.
      window.setTimeout(() => {
        if (!closed && source?.readyState !== EventSource.OPEN) startPolling();
      }, 4_000);
    }

    return () => {
      closed = true;
      stopPolling();
      source?.close();
    };
  }, []);

  return state;
}
