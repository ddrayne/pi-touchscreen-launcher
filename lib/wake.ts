/**
 * The wake word reaches the page as a push from the bridge, with a slow poll
 * behind it. The poll doubles as the bridge's proof that the page's main
 * thread is still running: when it stops, the bridge's watchdog restarts the
 * kiosk.
 */

import { discardBody, readJson, settle } from "./http.ts";

export type WakeStatus = {
  pending?: boolean;
  sequence?: number;
  muted?: boolean;
};

type EventSourceLike = {
  addEventListener: (type: string, listener: (event: { data: string }) => void) => void;
  close: () => void;
};

export type WatchWakeOptions = {
  onWake: (sequence: number) => void;
  fetch?: typeof fetch;
  EventSource?: (new (url: string) => EventSourceLike) | undefined;
  /** How often to poll `/api/wake` behind the stream. */
  pollMs?: number;
};

export const WAKE_POLL_MS = 15_000;
/** Without a stream the poll must be quick enough to feel like a wake word. */
const WAKE_POLL_FALLBACK_MS = 2_000;

export function watchWake(options: WatchWakeOptions): () => void {
  const fetchFn = options.fetch ?? ((input, init) => fetch(input, init));
  const Source = "EventSource" in options ? options.EventSource : globalThis.EventSource;
  const pollMs = options.pollMs ?? (Source ? WAKE_POLL_MS : WAKE_POLL_FALLBACK_MS);
  let last = 0;
  let stopped = false;

  const accept = (status: WakeStatus) => {
    if (stopped) return;
    const sequence = status.sequence || 0;
    if (!status.pending || sequence <= last) return;
    last = sequence;
    options.onWake(sequence);
    void settle(
      fetchFn("/api/wake", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "ack", sequence }),
      }),
    );
  };

  const poll = async () => {
    try {
      accept(await readJson<WakeStatus>(await fetchFn("/api/wake", { cache: "no-store" }), "wake"));
    } catch {
      // The bridge is restarting or the page is offline; the next poll will tell.
    }
  };

  let source: EventSourceLike | null = null;
  if (Source) {
    source = new Source("/api/wake/events");
    source.addEventListener("wake", (event) => {
      try {
        accept(JSON.parse(event.data) as WakeStatus);
      } catch {
        // A malformed event is ignored; the poll is the backstop.
      }
    });
  }
  void poll();
  const timer = setInterval(() => void poll(), pollMs);

  return () => {
    stopped = true;
    clearInterval(timer);
    source?.close();
  };
}

export { discardBody };
