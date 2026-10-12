/**
 * The garden's voices: BirdFrame's record of the day (its painting and its
 * clips) and the one recording playing through the Pi's speaker. The board
 * and the home screen share one of these, so only one bird sings at a time.
 */

import { useCallback, useEffect, useState } from "react";
import { withFrameTime } from "./clock.ts";
import { playClip, stopClip } from "./clips.ts";

export type DayRecord = {
  date: string;
  artwork: string | null;
  narration: string;
  speciesCount: number;
  newSpecies: string[];
  clips: Map<string, string>;
};

export type BirdVoices = {
  day: DayRecord | null;
  /** Common name of the bird whose recording is playing. */
  playing: string | null;
  songLevel: number;
  /** Plays a bird's recording, or stops it when it is already playing. */
  hear: (commonName: string, explicitUrl?: string | null) => void;
  stop: () => void;
};

export function dayKey(at: number): string {
  const date = new Date(at);
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function clipUrlFor(day: DayRecord | null, commonName: string, at: number): string {
  return (
    day?.clips.get(commonName) ??
    `/api/birdframe/clip/${dayKey(at)}/${encodeURIComponent(commonName)}`
  );
}

function useDayRecord(key: string): DayRecord | null {
  const [day, setDay] = useState<DayRecord | null>(null);
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const response = await fetch(withFrameTime("/api/birdframe/day"), { cache: "no-store" });
        if (!response.ok) throw new Error("no day");
        const raw = (await response.json()) as Record<string, unknown>;
        const images = Array.isArray(raw.images) ? raw.images : [];
        const latest = images
          .map((entry) => (entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {}))
          .find((entry) => typeof entry.url === "string");
        const clips = new Map<string, string>();
        for (const entry of Array.isArray(raw.clips) ? raw.clips : []) {
          const clip = entry as Record<string, unknown>;
          if (typeof clip.common_name === "string" && typeof clip.url === "string") {
            clips.set(clip.common_name, clip.url);
          }
        }
        if (cancelled) return;
        setDay({
          date: typeof raw.date === "string" ? raw.date : key,
          artwork: latest ? String(latest.url) : null,
          narration: typeof raw.narration === "string" ? raw.narration : "",
          speciesCount: Array.isArray(raw.species) ? raw.species.length : 0,
          newSpecies: Array.isArray(raw.new_species) ? raw.new_species.map(String) : [],
          clips,
        });
      } catch {
        if (!cancelled) setDay(null);
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), 30 * 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [key]);
  return day;
}

export function useBirdVoices(now: number, muteWake: (seconds: number) => void): BirdVoices {
  const day = useDayRecord(dayKey(now));
  const [playing, setPlaying] = useState<string | null>(null);
  const [songLevel, setSongLevel] = useState(0);

  const stop = useCallback(() => {
    stopClip();
    setPlaying(null);
    setSongLevel(0);
  }, []);

  const hear = useCallback(
    (commonName: string, explicitUrl?: string | null) => {
      if (playing === commonName) {
        stop();
        return;
      }
      const url = explicitUrl
        ? `/api/birdframe/clip?url=${encodeURIComponent(explicitUrl)}`
        : clipUrlFor(day, commonName, now);
      setPlaying(commonName);
      playClip(url, {
        onStart: (duration) => muteWake(Math.min(60, duration + 1.5)),
        onLevel: setSongLevel,
        onEnd: () => {
          setPlaying((current) => (current === commonName ? null : current));
          setSongLevel(0);
          muteWake(1);
        },
      });
    },
    [day, muteWake, now, playing, stop],
  );

  useEffect(() => () => stopClip(), []);
  return { day, playing, songLevel, hear, stop };
}
