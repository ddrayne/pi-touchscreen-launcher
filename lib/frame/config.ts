/** Where the window is and which way it faces. Served by the bridge from the installer's environment. */

import { readJson } from "../http.ts";

export type FrameConfig = {
  latitude: number;
  longitude: number;
  /** Compass direction the window faces, degrees. */
  facing: number;
  place: string;
};

export const DEFAULT_FRAME_CONFIG: FrameConfig = {
  latitude: 55.95,
  longitude: -3.19,
  facing: 180,
  place: "Edinburgh",
};

function finite(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export async function loadFrameConfig(): Promise<FrameConfig> {
  try {
    const raw = await readJson<Record<string, unknown>>(
      await fetch("/api/config", { cache: "no-store" }),
      "config unavailable",
    );
    return {
      latitude: finite(raw.latitude, DEFAULT_FRAME_CONFIG.latitude),
      longitude: finite(raw.longitude, DEFAULT_FRAME_CONFIG.longitude),
      facing: finite(raw.facing, DEFAULT_FRAME_CONFIG.facing),
      place:
        typeof raw.place === "string" && raw.place.trim()
          ? raw.place.trim()
          : DEFAULT_FRAME_CONFIG.place,
    };
  } catch {
    return DEFAULT_FRAME_CONFIG;
  }
}
