/** Wikimedia portraits through the bridge's cache, with their credits. */

import { useEffect, useMemo, useState } from "react";
import { discardBody } from "../http.ts";

export type Portrait = {
  image: string;
  title: string;
  artist: string;
  license: string;
  source: string;
};

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
      const raw = (await response.json()) as Record<string, unknown>;
      if (typeof raw.image !== "string" || !raw.image) return null;
      return {
        image: raw.image,
        title: typeof raw.title === "string" ? raw.title : key,
        artist: typeof raw.artist === "string" ? raw.artist : "Wikimedia contributor",
        license: typeof raw.license === "string" ? raw.license : "",
        source: typeof raw.source === "string" ? raw.source : "",
      } satisfies Portrait;
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
