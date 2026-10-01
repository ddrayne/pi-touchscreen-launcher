/**
 * Turns BirdFrame's live `/api/now` payload into what the kitchen screen shows:
 * one bird singing now, the few heard just before it, and whether the garden
 * has gone quiet. Only confirmed and probable detections are ever shown, so the
 * screen never teaches a misidentified bird.
 */

export type BirdframeDetection = {
  common_name: string;
  scientific_name: string;
  confidence?: number;
  at?: string;
  timestamp?: string;
};

export type BirdframeSpecies = {
  common_name: string;
  scientific_name: string;
  count?: number;
  tier?: string | null;
  first_heard?: string;
  last_heard?: string;
  clip_url?: string | null;
};

export type BirdframeNow = {
  now?: string;
  latest?:
    | (BirdframeDetection & {
        seconds_ago?: number;
        tier?: string | null;
        clip_url?: string | null;
      })
    | null;
  feed?: BirdframeDetection[];
  window_species?: BirdframeSpecies[];
  today_species_count?: number;
  new_today?: string[];
};

export type Freshness = "now" | "recent" | "earlier";

export type NowSinging = {
  commonName: string;
  scientificName: string;
  secondsAgo: number | null;
  freshness: Freshness;
  label: string;
  tier: "confirmed" | "probable";
  clipPath: string | null;
  photoPath: string;
  firstEver: boolean;
};

export type GardenSummary = {
  hero: NowSinging | null;
  earlier: string[];
  voicesToday: number;
  /** Nothing reliable heard for three hours. */
  quiet: boolean;
};

const RELIABLE = new Set(["confirmed", "probable"]);
const SINGING_NOW_SECONDS = 150;
const QUIET_AFTER_SECONDS = 3 * 60 * 60;

function isReliable(tier: unknown): tier is "confirmed" | "probable" {
  return typeof tier === "string" && RELIABLE.has(tier);
}

function secondsOfDay(value: string | undefined): number | null {
  const match = value?.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) return null;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3] ?? 0);
}

/** Seconds between two local clock times, allowing for midnight. */
function secondsBetween(earlier: string | undefined, later: string | undefined): number | null {
  const start = secondsOfDay(earlier);
  const end = secondsOfDay(later);
  if (start === null || end === null) return null;
  const difference = end - start;
  return difference >= 0 ? difference : difference + 24 * 3600;
}

function clockLabel(value: string | undefined): string | null {
  const match = value?.match(/(\d{1,2}):(\d{2})/);
  return match ? `${match[1].padStart(2, "0")}:${match[2]}` : null;
}

export function describeFreshness(
  secondsAgo: number | null,
  heardAt?: string,
): { freshness: Freshness; label: string } {
  if (secondsAgo !== null && secondsAgo < SINGING_NOW_SECONDS) {
    return { freshness: "now", label: "Singing now" };
  }
  if (secondsAgo !== null && secondsAgo < 3600) {
    const minutes = Math.max(2, Math.round(secondsAgo / 60));
    return { freshness: "recent", label: `Heard ${minutes} minutes ago` };
  }
  const clock = clockLabel(heardAt);
  return { freshness: "earlier", label: clock ? `Last heard at ${clock}` : "Heard earlier today" };
}

/** BirdFrame's `/api/clip/<day>/<name>` becomes the Pi bridge's proxied path. */
export function bridgeClipPath(clipUrl: string | null | undefined): string | null {
  const match = clipUrl?.match(/^\/api\/clip\/(\d{4}-\d{2}-\d{2})\/([^/?#]+)$/);
  return match ? `/api/birdframe/clip/${match[1]}/${match[2]}` : null;
}

export function photoPathFor(scientificName: string): string {
  return `/api/birds/photo?name=${encodeURIComponent(scientificName)}`;
}

export function summariseGarden(payload: BirdframeNow | null | undefined): GardenSummary {
  const windowSpecies = payload?.window_species ?? [];
  const tierByName = new Map(
    windowSpecies.map((species) => [species.scientific_name, species.tier]),
  );
  const clipByName = new Map(
    windowSpecies.map((species) => [species.scientific_name, species.clip_url]),
  );
  const feed = payload?.feed ?? [];
  const latest = payload?.latest ?? null;

  let hero: NowSinging | null = null;
  const latestTier = latest ? latest.tier ?? tierByName.get(latest.scientific_name) : null;
  const candidate =
    latest && isReliable(latestTier)
      ? { detection: latest, tier: latestTier, secondsAgo: latest.seconds_ago ?? null }
      : (() => {
          const detection = feed.find((entry) =>
            isReliable(tierByName.get(entry.scientific_name)),
          );
          if (!detection) return null;
          return {
            detection,
            tier: tierByName.get(detection.scientific_name) as "confirmed" | "probable",
            secondsAgo: secondsBetween(detection.at ?? detection.timestamp, payload?.now),
          };
        })();

  if (candidate) {
    const { detection, tier, secondsAgo } = candidate;
    const { freshness, label } = describeFreshness(
      secondsAgo,
      detection.at ?? detection.timestamp,
    );
    const clipUrl =
      clipByName.get(detection.scientific_name) ??
      (detection === latest ? latest?.clip_url : null);
    hero = {
      commonName: detection.common_name,
      scientificName: detection.scientific_name,
      secondsAgo,
      freshness,
      label,
      tier,
      clipPath: bridgeClipPath(clipUrl),
      photoPath: photoPathFor(detection.scientific_name),
      firstEver: (payload?.new_today ?? []).includes(detection.common_name),
    };
  }

  const earlier: string[] = [];
  for (const entry of feed) {
    if (earlier.length >= 4) break;
    if (entry.scientific_name === hero?.scientificName) continue;
    if (!isReliable(tierByName.get(entry.scientific_name))) continue;
    if (!earlier.includes(entry.common_name)) earlier.push(entry.common_name);
  }

  return {
    hero,
    earlier,
    voicesToday: payload?.today_species_count ?? 0,
    quiet: !hero || (hero.secondsAgo !== null && hero.secondsAgo > QUIET_AFTER_SECONDS),
  };
}
