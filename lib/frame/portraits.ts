/** Wikimedia portraits through the bridge's cache, with their credits. */

import { useEffect, useMemo, useState } from "react";
import { discardBody } from "../http.ts";

export type Portrait = {
  image: string;
  title: string;
  artist: string;
  license: string;
  source: string;
  /** The photo's dominant colour, for the block it sits in; null before the bridge has computed it. */
  tint: [number, number, number] | null;
  /** Where the bird is, as fractions of the frame; null when unknown. */
  focal: { x: number; y: number } | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function channel(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 255) return null;
  return Math.round(value);
}

export function parseTint(raw: unknown): Portrait["tint"] {
  if (!Array.isArray(raw) || raw.length !== 3) return null;
  const [r, g, b] = raw.map(channel);
  if (r === null || g === null || b === null) return null;
  return [r, g, b];
}

function fraction(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) return null;
  return value;
}

export function parseFocal(raw: unknown): Portrait["focal"] {
  if (!isRecord(raw)) return null;
  const x = fraction(raw.x);
  const y = fraction(raw.y);
  if (x === null || y === null) return null;
  return { x, y };
}

/** One bridge portrait record; null when it carries no image. */
export function parsePortrait(raw: unknown, fallbackTitle = ""): Portrait | null {
  if (!isRecord(raw) || typeof raw.image !== "string" || !raw.image) return null;
  return {
    image: raw.image,
    title: typeof raw.title === "string" ? raw.title : fallbackTitle,
    artist: typeof raw.artist === "string" ? raw.artist : "Wikimedia contributor",
    license: typeof raw.license === "string" ? raw.license : "",
    source: typeof raw.source === "string" ? raw.source : "",
    tint: parseTint(raw.tint),
    focal: parseFocal(raw.focal),
  };
}

const cache = new Map<string, Portrait | null>();
const pending = new Map<string, Promise<Portrait | null>>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

export function portraitFor(scientificName: string): Portrait | null | undefined {
  return cache.get(scientificName);
}

export function loadPortrait(scientificName: string): Promise<Portrait | null> {
  const key = scientificName.trim();
  if (!key) return Promise.resolve(null);
  if (cache.has(key)) return Promise.resolve(cache.get(key) ?? null);
  const existing = pending.get(key);
  if (existing) return existing;
  const request = fetch(`/api/birdframe/portrait/${encodeURIComponent(key)}`, {
    cache: "force-cache",
  })
    .then(async (response) => {
      if (!response.ok) {
        await discardBody(response);
        return null;
      }
      return parsePortrait(await response.json(), key);
    })
    .catch(() => null)
    .then((portrait) => {
      cache.set(key, portrait);
      pending.delete(key);
      notify();
      return portrait;
    });
  pending.set(key, request);
  return request;
}

/** Portraits for a set of species, re-rendering as each arrives. */
export function usePortraits(scientificNames: string[]): Map<string, Portrait | null> {
  const [version, setVersion] = useState(0);
  const key = scientificNames.join("|");
  useEffect(() => {
    const listener = () => setVersion((value) => value + 1);
    listeners.add(listener);
    for (const name of key.split("|")) if (name) void loadPortrait(name);
    return () => {
      listeners.delete(listener);
    };
  }, [key]);
  // One Map per change, so memoised rows and tiles skip the clock's ticks.
  // `version` is the module cache's change counter, which React cannot see.
  return useMemo(() => {
    const result = new Map<string, Portrait | null>();
    for (const name of key.split("|")) {
      const portrait = cache.get(name);
      if (name && portrait !== undefined) result.set(name, portrait);
    }
    return result;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, version]);
}
