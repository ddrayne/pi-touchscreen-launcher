/**
 * The frame's clock. Normally the wall clock; with `?at=2026-06-21T04:12`
 * (or `?at=04:12`) the whole painting runs from that moment, and `?speed=60`
 * runs it sixty times faster, so dawn can be designed at noon.
 */

import { useEffect, useState } from "react";

let parsed = false;
let anchorReal = 0;
let anchorFrame = 0;
let speed = 1;
let scrubbed = false;

function parseAt(value: string): number | null {
  const text = value.trim();
  if (!text) return null;
  const clock = /^(\d{1,2}):(\d{2})$/.exec(text);
  if (clock) {
    const date = new Date();
    date.setHours(Number(clock[1]), Number(clock[2]), 0, 0);
    return date.getTime();
  }
  const stamp = new Date(text).getTime();
  return Number.isFinite(stamp) ? stamp : null;
}

function ensureParsed(): void {
  if (parsed) return;
  parsed = true;
  anchorReal = Date.now();
  anchorFrame = anchorReal;
  if (typeof window === "undefined") return;
  const params = new URLSearchParams(window.location.search);
  const at = parseAt(params.get("at") || "");
  if (at !== null) {
    anchorFrame = at;
    scrubbed = true;
  }
  const requestedSpeed = Number.parseFloat(params.get("speed") || "1");
  if (Number.isFinite(requestedSpeed) && requestedSpeed > 0) speed = requestedSpeed;
}

export function frameNow(): number {
  ensureParsed();
  return anchorFrame + (Date.now() - anchorReal) * speed;
}

export function frameIsScrubbed(): boolean {
  ensureParsed();
  return scrubbed;
}

/** Query string fragment that tells a mock bridge which moment to serve. */
export function frameTimeQuery(): string {
  ensureParsed();
  if (!scrubbed) return "";
  return `at=${encodeURIComponent(new Date(frameNow()).toISOString())}`;
}

export function withFrameTime(path: string): string {
  const query = frameTimeQuery();
  if (!query) return path;
  return `${path}${path.includes("?") ? "&" : "?"}${query}`;
}

export function useFrameClock(intervalMs = 1000): number {
  const [now, setNow] = useState(() => (typeof window === "undefined" ? Date.now() : frameNow()));
  useEffect(() => {
    const timer = window.setInterval(() => setNow(frameNow()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}
