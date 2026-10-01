/**
 * When the kitchen screen should go dark. The kitchen motion sensor in Home
 * Assistant tells the broker when someone is in the room; without that signal
 * the screen stays on, because a dark screen that won't wake is worse than a
 * lit one.
 */

export type PresenceSnapshot = {
  /** False until Home Assistant has reported the kitchen sensors. */
  known: boolean;
  occupied: boolean;
  /** ISO time of the latest change to any kitchen presence sensor. */
  changedAt: string | null;
  illuminance?: number | null;
};

export type SleepInput = {
  now: number;
  presence: PresenceSnapshot | null;
  /** Epoch milliseconds of the last touch on the screen. */
  lastTouchAt: number;
  timersActive: boolean;
  voiceActive: boolean;
  sleepAfterMs: number;
};

export function shouldSleep(input: SleepInput): boolean {
  const { now, presence, lastTouchAt, timersActive, voiceActive, sleepAfterMs } = input;
  if (!presence?.known || presence.occupied) return false;
  if (timersActive || voiceActive) return false;
  const changedAt = presence.changedAt ? Date.parse(presence.changedAt) : Number.NaN;
  const lastActive = Math.max(Number.isFinite(changedAt) ? changedAt : 0, lastTouchAt);
  return now - lastActive > sleepAfterMs;
}

/** Evening and night use the dim, warm palette. */
export function isNight(date: Date): boolean {
  const hour = date.getHours();
  return hour >= 21 || hour < 6;
}
