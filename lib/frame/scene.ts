/**
 * The scene reducer: pure projections of what BirdFrame reports into what
 * the board shows. Nothing here touches the DOM, so every rule is testable
 * and the frame can be scrubbed to any moment.
 *
 * The one law: it may dramatise, it may not fabricate. Every row traces to a
 * species BirdFrame heard; recency is ink; a dot is a call.
 */

export type Tier = "confirmed" | "probable" | "tentative";

export type FrameDetection = {
  id: number;
  commonName: string;
  scientificName: string;
  confidence: number;
  /** Milliseconds since the epoch, local wall clock of the listener. */
  at: number;
  /** When this device first learned of the call; the bloom clock starts here. */
  seenAt: number;
  tier?: Tier;
  snrDb?: number | null;
  clipUrl?: string | null;
};

export type FrameSpecies = {
  commonName: string;
  scientificName: string;
  count: number;
  tier: Tier;
  /** Milliseconds; undefined when the feed did not include this species. */
  lastHeard?: number;
  firstHeard?: number;
};

export type FrameSnapshot = {
  receivedAt: number;
  windowMinutes: number;
  cursor: number;
  latest: FrameDetection | null;
  /** Species heard in the rolling window, as BirdFrame sorts them. */
  species: FrameSpecies[];
  /** The last forty calls, newest first. */
  feed: FrameDetection[];
  /** Every species heard today, newest first when known. */
  today: FrameSpecies[];
  todaySpeciesCount: number;
  /** Common names first ever heard in this garden today. */
  newToday: string[];
  /** Activity buckets across the window, oldest first. */
  activity: number[];
};

export type BloomKind = "arrival" | "first-voice" | "new-to-garden";

export type Bloom = {
  detectionId: number;
  commonName: string;
  scientificName: string;
  at: number;
  kind: BloomKind;
  tier?: Tier;
  confidence: number;
  clipUrl: string | null;
  /** When the bloom slides into the gallery. */
  until: number;
};

export const BLOOM_HOLD_MS = 20_000;
export const FIRST_VOICE_HOLD_MS = 60_000;
export const BLOOM_MAX_AGE_MS = 90_000;
export const REPEAT_CALM_MS = 120_000;
export const QUIET_AFTER_MS = 10 * 60_000;
/** How long the portrait takes to slide into the gallery. */
export const LEAVE_MS = 900;
const MIN_INK = 0.16;

const TIERS: Tier[] = ["confirmed", "probable", "tentative"];

function tierOf(value: unknown): Tier | undefined {
  return typeof value === "string" && (TIERS as string[]).includes(value)
    ? (value as Tier)
    : undefined;
}

function numberOf(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function stringOf(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * BirdFrame reports local wall-clock times without a zone: "HH:MM:SS" for the
 * latest call and "YYYY-MM-DDTHH:MM:SS" in the feed. Both are read as local
 * time on this device, which shares the listener's clock.
 */
export function parseBirdframeTime(value: unknown, receivedAt: number): number {
  const text = stringOf(value);
  if (!text) return receivedAt;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(text)) {
    const parsed = new Date(text).getTime();
    return Number.isFinite(parsed) ? parsed : receivedAt;
  }
  const match = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(text);
  if (!match) return receivedAt;
  const day = new Date(receivedAt);
  day.setHours(Number(match[1]), Number(match[2]), Number(match[3] ?? 0), 0);
  let at = day.getTime();
  // A time later than now belongs to yesterday (the snapshot crossed midnight).
  if (at > receivedAt + 60_000) at -= 86_400_000;
  return at;
}

export function parseDetection(raw: unknown, receivedAt: number): FrameDetection | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const commonName = stringOf(record.common_name);
  if (!commonName) return null;
  const timestamp = record.timestamp ?? record.at;
  return {
    id: numberOf(record.id),
    commonName,
    scientificName: stringOf(record.scientific_name),
    confidence: numberOf(record.confidence),
    at: parseBirdframeTime(timestamp, receivedAt),
    seenAt: receivedAt,
    tier: tierOf(record.tier),
    snrDb: typeof record.snr_db === "number" ? record.snr_db : null,
    clipUrl: typeof record.clip_url === "string" ? record.clip_url : null,
  };
}

function parseSpecies(raw: unknown, receivedAt: number): FrameSpecies | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const commonName = stringOf(record.common_name);
  if (!commonName) return null;
  const lastHeardRaw = record.last_heard ?? record.last_seen ?? record.latest;
  const firstHeardRaw = record.first_heard ?? record.first_seen;
  return {
    commonName,
    scientificName: stringOf(record.scientific_name),
    count: Math.max(0, Math.round(numberOf(record.count, 1))),
    tier: tierOf(record.tier) ?? "tentative",
    lastHeard: lastHeardRaw ? parseBirdframeTime(lastHeardRaw, receivedAt) : undefined,
    firstHeard: firstHeardRaw ? parseBirdframeTime(firstHeardRaw, receivedAt) : undefined,
  };
}

/** Normalises BirdFrame's /api/now (and optionally /api/today) payloads. */
export function parseSnapshot(
  raw: unknown,
  receivedAt: number,
  todayRaw?: unknown,
): FrameSnapshot {
  const record = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const feed = (Array.isArray(record.feed) ? record.feed : [])
    .map((entry) => parseDetection(entry, receivedAt))
    .filter((entry): entry is FrameDetection => entry !== null)
    .sort((left, right) => right.at - left.at || right.id - left.id);
  const lastHeardByName = new Map<string, number>();
  const firstHeardByName = new Map<string, number>();
  for (const detection of feed) {
    const name = detection.commonName;
    lastHeardByName.set(name, Math.max(lastHeardByName.get(name) ?? 0, detection.at));
    firstHeardByName.set(
      name,
      Math.min(firstHeardByName.get(name) ?? Number.POSITIVE_INFINITY, detection.at),
    );
  }
  const enrich = (species: FrameSpecies): FrameSpecies => ({
    ...species,
    lastHeard: species.lastHeard ?? lastHeardByName.get(species.commonName),
    firstHeard: species.firstHeard ?? firstHeardByName.get(species.commonName),
  });
  const species = (Array.isArray(record.window_species) ? record.window_species : [])
    .map((entry) => parseSpecies(entry, receivedAt))
    .filter((entry): entry is FrameSpecies => entry !== null)
    .map(enrich);
  const todayRecord = (todayRaw && typeof todayRaw === "object" ? todayRaw : {}) as Record<
    string,
    unknown
  >;
  const today = (Array.isArray(todayRecord.species) ? todayRecord.species : [])
    .map((entry) => parseSpecies(entry, receivedAt))
    .filter((entry): entry is FrameSpecies => entry !== null)
    .map(enrich)
    .sort((left, right) => (right.lastHeard ?? 0) - (left.lastHeard ?? 0));
  const latest = parseDetection(record.latest, receivedAt);
  return {
    receivedAt,
    windowMinutes: Math.max(5, numberOf(record.window_minutes, 60)),
    cursor: numberOf(record.cursor, latest?.id ?? 0),
    latest,
    species,
    feed,
    today,
    todaySpeciesCount: numberOf(record.today_species_count, today.length),
    newToday: (Array.isArray(record.new_today) ? record.new_today : [])
      .map(stringOf)
      .filter(Boolean),
    activity: (Array.isArray(record.activity) ? record.activity : []).map((bucket) =>
      typeof bucket === "number"
        ? bucket
        : numberOf((bucket as Record<string, unknown> | null)?.count),
    ),
  };
}

/** Folds a long-poll detection into a snapshot without waiting for the next full one. */
export function applyDetection(snapshot: FrameSnapshot, detection: FrameDetection): FrameSnapshot {
  if (snapshot.feed.some((entry) => entry.id === detection.id)) return snapshot;
  const feed = [detection, ...snapshot.feed].slice(0, 60);
  const existing = snapshot.species.find((entry) => entry.commonName === detection.commonName);
  const species = existing
    ? snapshot.species.map((entry) =>
        entry === existing
          ? {
              ...entry,
              count: entry.count + 1,
              lastHeard: Math.max(entry.lastHeard ?? 0, detection.at),
            }
          : entry,
      )
    : [
        {
          commonName: detection.commonName,
          scientificName: detection.scientificName,
          count: 1,
          tier: detection.tier ?? "tentative",
          lastHeard: detection.at,
          firstHeard: detection.at,
        },
        ...snapshot.species,
      ];
  const todayExisting = snapshot.today.find((entry) => entry.commonName === detection.commonName);
  const today = todayExisting
    ? [
        { ...todayExisting, count: todayExisting.count + 1, lastHeard: detection.at },
        ...snapshot.today.filter((entry) => entry !== todayExisting),
      ]
    : [
        {
          commonName: detection.commonName,
          scientificName: detection.scientificName,
          count: 1,
          tier: detection.tier ?? "tentative",
          lastHeard: detection.at,
          firstHeard: detection.at,
        },
        ...snapshot.today,
      ];
  return {
    ...snapshot,
    cursor: Math.max(snapshot.cursor, detection.id),
    latest: detection,
    feed,
    species,
    today,
    todaySpeciesCount: Math.max(snapshot.todaySpeciesCount, today.length),
  };
}

export function hashString(value: string): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619) >>> 0;
  }
  return hash >>> 0;
}

/**
 * Recency as ink. Full at the last call, fading to a faint ghost at the end of
 * the window.
 */
export function inkFor(lastHeard: number, now: number, windowMinutes: number): number {
  const age = Math.max(0, now - lastHeard);
  const windowMs = windowMinutes * 60_000;
  if (age >= windowMs) return 0;
  const t = age / windowMs;
  return MIN_INK + (1 - MIN_INK) * (1 - t) ** 1.6;
}

export type RollRow = {
  species: FrameSpecies;
  /** 1 at the last call, fading across the window; never below 0.3 so a row stays readable. */
  recency: number;
  rank: number;
  /** True when the row comes from earlier today because the last hour is silent. */
  earlier: boolean;
};

/**
 * The roll call: every species in the window, newest first, then today's
 * cast, marked as earlier, until the rows are full, so the board is never a
 * blank.
 */
export function rollCall(snapshot: FrameSnapshot | null, now: number, limit = 7): RollRow[] {
  if (!snapshot) return [];
  const fallbackLastHeard = snapshot.receivedAt - snapshot.windowMinutes * 30_000;
  const inWindow = snapshot.species
    .map((species) => ({ species, lastHeard: species.lastHeard ?? fallbackLastHeard }))
    .filter(({ lastHeard }) => inkFor(lastHeard, now, snapshot.windowMinutes) > 0)
    .sort((left, right) => right.lastHeard - left.lastHeard);
  const recent: RollRow[] = inWindow.slice(0, limit).map(({ species, lastHeard }, rank) => ({
    species: { ...species, lastHeard },
    recency: Math.max(0.3, inkFor(lastHeard, now, snapshot.windowMinutes)),
    rank,
    earlier: false,
  }));
  // A thin hour is topped up from earlier today, so the board stays full of birds.
  const shown = new Set(recent.map((row) => row.species.commonName));
  const earlier = castFor(snapshot)
    .filter((species) => !shown.has(species.commonName))
    .slice(0, limit - recent.length)
    .map((species, index) => ({ species, recency: 0.45, rank: recent.length + index, earlier: true }));
  return [...recent, ...earlier];
}

export type BloomOptions = {
  now: number;
};

function isFirstVoice(detection: FrameDetection, snapshot: FrameSnapshot): boolean {
  const earliest = snapshot.feed.reduce(
    (min, entry) => Math.min(min, entry.at),
    Number.POSITIVE_INFINITY,
  );
  const dayStart = new Date(detection.at);
  dayStart.setHours(0, 0, 0, 0);
  return (
    snapshot.todaySpeciesCount <= 1 &&
    earliest === detection.at &&
    snapshot.feed.length <= 1 &&
    detection.at >= dayStart.getTime()
  );
}

/**
 * What, if anything, is having its moment: a pure function of the snapshot
 * and the clock. The newest call blooms from the moment this device learned
 * of it; a run of repeats from the same species within two minutes keeps the
 * first bloom and only extends it a little, so the portrait never flickers.
 * A call learned of long after it happened (a reconnect) never blooms.
 */
export function nextBloom(snapshot: FrameSnapshot, options: BloomOptions): Bloom | null {
  const { now } = options;
  const newest = snapshot.feed[0] ?? snapshot.latest;
  if (!newest) return null;
  if (newest.seenAt - newest.at > BLOOM_MAX_AGE_MS) return null;
  // Walk back through the run of calls from the same species.
  let start = newest;
  for (let index = 1; index < snapshot.feed.length; index += 1) {
    const earlier = snapshot.feed[index];
    if (earlier.commonName !== newest.commonName) break;
    if (start.at - earlier.at >= REPEAT_CALM_MS) break;
    start = earlier;
  }
  const kind: BloomKind = snapshot.newToday.includes(start.commonName)
    ? "new-to-garden"
    : isFirstVoice(start, snapshot)
      ? "first-voice"
      : "arrival";
  const hold = kind === "arrival" ? BLOOM_HOLD_MS : FIRST_VOICE_HOLD_MS;
  const until = Math.max(start.seenAt + hold, newest.seenAt + 6_000);
  if (now >= until + LEAVE_MS) return null;
  return {
    detectionId: newest.id,
    commonName: start.commonName,
    scientificName: start.scientificName || newest.scientificName,
    at: start.at,
    kind,
    tier: start.tier ?? newest.tier,
    confidence: start.confidence,
    clipUrl: newest.clipUrl ?? start.clipUrl ?? null,
    until,
  };
}

/** The bloom is on its way down to the gallery. */
export function bloomIsLeaving(bloom: Bloom, now: number): boolean {
  return now >= bloom.until;
}

/** Milliseconds since the last call, or null when nothing has been heard. */
export function quietFor(snapshot: FrameSnapshot | null, now: number): number | null {
  if (!snapshot) return null;
  const last = snapshot.feed[0]?.at ?? snapshot.latest?.at;
  if (!last) return null;
  return Math.max(0, now - last);
}

/** Today's cast for the gallery strip, newest first, without duplicates. */
export function castFor(snapshot: FrameSnapshot | null): FrameSpecies[] {
  if (!snapshot) return [];
  const seen = new Set<string>();
  const cast: FrameSpecies[] = [];
  const candidates = snapshot.today.length
    ? snapshot.today
    : [...snapshot.species].sort(
        (left, right) => (right.lastHeard ?? 0) - (left.lastHeard ?? 0),
      );
  for (const species of candidates) {
    if (seen.has(species.commonName)) continue;
    seen.add(species.commonName);
    cast.push(species);
  }
  // A bird heard this hour, or the very latest call, belongs to today even
  // when the day's list has not caught up with it yet.
  for (const species of snapshot.species) {
    if (seen.has(species.commonName)) continue;
    seen.add(species.commonName);
    cast.push(species);
  }
  const latest = snapshot.latest;
  if (latest && !seen.has(latest.commonName)) {
    cast.unshift({
      commonName: latest.commonName,
      scientificName: latest.scientificName,
      count: 1,
      tier: latest.tier ?? "tentative",
      lastHeard: latest.at,
    });
  }
  return cast;
}

export function tierWord(tier: Tier | undefined): string {
  if (tier === "confirmed") return "confirmed";
  if (tier === "probable") return "probable";
  if (tier === "tentative") return "a tentative match";
  return "";
}
