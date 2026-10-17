/** Today in the garden: every bird BirdFrame has heard today, newest first, one tap to hear. */

import { memo, type CSSProperties } from "react";
import type { BirdTile } from "../lib/frame/birds";
import type { Portrait } from "../lib/frame/portraits";
import { tierWord } from "../lib/frame/scene";

type TodayBirdsProps = {
  tiles: BirdTile[];
  more: number;
  portraits: Map<string, Portrait | null>;
  playing: string | null;
  /** The newest call, so its tile can bloom as it lands. */
  newest: string | null;
  reachable: boolean;
  lastHeardAt: number | null;
  onHear: (commonName: string) => void;
  onOpenJournal: () => void;
};

const CLOCK = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false });

function clockOf(at: number): string {
  return CLOCK.format(new Date(at));
}

export const TodayBirds = memo(function TodayBirds({
  tiles,
  more,
  portraits,
  playing,
  newest,
  reachable,
  lastHeardAt,
  onHear,
  onOpenJournal,
}: TodayBirdsProps) {
  const status = !reachable
    ? `Unreachable${lastHeardAt ? ` · last heard ${clockOf(lastHeardAt)}` : ""}`
    : tiles.length
      ? `${tiles.length + more} ${tiles.length + more === 1 ? "voice" : "voices"} today`
      : "Listening…";
  return (
    <section className="today-birds" aria-label="Today in the garden">
      <header className="today-birds__header">
        <p className="launcher__eyebrow">Today in the garden</p>
        <span>{status}</span>
      </header>
      {tiles.length ? (
        <ol className="today-birds__grid">
          {tiles.map(({ species, recent, recency }) => {
            const portrait = portraits.get(species.scientificName) ?? null;
            const isPlaying = playing === species.commonName;
            return (
              <li key={species.commonName}>
                <button
                  type="button"
                  className="today-bird"
                  data-recent={recent}
                  data-playing={isPlaying}
                  data-newest={recent && species.commonName === newest}
                  style={{ "--recency": String(recency) } as CSSProperties}
                  aria-pressed={isPlaying}
                  aria-label={`${species.commonName}${isPlaying ? ", playing; tap to stop" : ", tap to hear"}`}
                  onClick={() => onHear(species.commonName)}
                >
                  <span
                    className="today-bird__portrait"
                    style={portrait ? { backgroundImage: `url("${portrait.image}")` } : undefined}
                  >
                    {portrait ? null : <span>{species.commonName.slice(0, 1)}</span>}
                    <span className="today-bird__play" aria-hidden="true">
                      {isPlaying ? "Stop" : "▶"}
                    </span>
                  </span>
                  <span className="today-bird__name">{species.commonName}</span>
                  <span className="today-bird__meta">
                    {species.lastHeard ? clockOf(species.lastHeard) : "today"}
                    {species.tier ? ` · ${tierWord(species.tier)}` : ""}
                  </span>
                  <span className="today-bird__calls" aria-label={`${species.count} calls`}>
                    {"●".repeat(Math.min(species.count, 10))}
                    {species.count > 10 ? ` +${species.count - 10}` : ""}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      ) : null}
      {more > 0 ? (
        <button type="button" className="today-birds__more" onClick={onOpenJournal}>
          +{more} more today · Open journal →
        </button>
      ) : null}
    </section>
  );
});
