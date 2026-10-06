/**
 * The moment a call lands: the species name in display serif and the
 * Wikimedia portrait rising in the sky, then the gallery strip of today's
 * cast along the foot of the frame.
 */

import { memo, type CSSProperties } from "react";
import type { Bloom as BloomState, FrameSpecies, Tier } from "../../lib/frame/scene.ts";
import type { Portrait } from "../../lib/frame/portraits.ts";

function clockOf(at: number): string {
  return new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" }).format(new Date(at));
}

function tierLabel(tier: Tier | undefined, confidence: number): string {
  const percent = `${Math.round(confidence * 100)}%`;
  if (tier === "confirmed") return `confirmed · ${percent}`;
  if (tier === "probable") return `probable · ${percent}`;
  if (tier === "tentative") return `tentative · ${percent}`;
  return percent;
}

type BloomProps = {
  bloom: BloomState;
  portrait: Portrait | null | undefined;
  leaving: boolean;
  /** Quiet mode: a slow cycle through today's cast rather than a fresh call. */
  quiet: boolean;
  daylight: string;
  songLevel: number;
  playing: boolean;
  onTap: () => void;
};

export const Bloom = memo(function Bloom({ bloom, portrait, leaving, quiet, daylight, songLevel, playing, onTap }: BloomProps) {
  const kicker =
    bloom.kind === "new-to-garden"
      ? "New to this garden"
      : bloom.kind === "first-voice"
        ? `First voice${daylight ? ` · ${daylight}` : ""}`
        : "";
  return (
    <div
      className="frame-bloom"
      data-kind={bloom.kind}
      data-leaving={leaving}
      data-quiet={quiet}
      data-portrait={Boolean(portrait)}
      data-playing={playing}
      style={{ "--song-level": String(songLevel) } as CSSProperties}
      onPointerUp={(event) => {
        event.stopPropagation();
        onTap();
      }}
    >
      <div className="frame-bloom__ribbon" />
      <div className="frame-bloom__ribbon frame-bloom__ribbon--late" />
      {portrait ? (
        <div className="frame-bloom__portrait" style={{ backgroundImage: `url("${portrait.image}")` }} />
      ) : (
        <div className="frame-bloom__portrait frame-bloom__portrait--empty" />
      )}
      <div className="frame-bloom__text">
        {kicker ? <p className="frame-bloom__kicker">{kicker}</p> : null}
        <h2 className="frame-bloom__name">{bloom.commonName}</h2>
        <p className="frame-bloom__caption">
          {quiet
            ? `last heard ${clockOf(bloom.at)}${bloom.tier ? ` · ${bloom.tier}` : ""}`
            : `${clockOf(bloom.at)} · ${tierLabel(bloom.tier, bloom.confidence)}`}
          {bloom.clipUrl ? " · touch to hear" : ""}
        </p>
        {portrait ? (
          <p className="frame-bloom__credit">
            {portrait.artist}
            {portrait.license ? ` · ${portrait.license}` : ""} · Wikimedia Commons
          </p>
        ) : null}
      </div>
    </div>
  );
});

type GalleryProps = {
  cast: FrameSpecies[];
  portraits: Map<string, Portrait | null>;
  activeName: string | null;
  onTap: (species: FrameSpecies) => void;
};

export const Gallery = memo(function Gallery({ cast, portraits, activeName, onTap }: GalleryProps) {
  if (!cast.length) return null;
  const shown = cast.slice(0, 8);
  const more = cast.length - shown.length;
  return (
    <div className="frame-gallery" aria-label="Today's cast">
      {shown.map((species) => {
        const portrait = portraits.get(species.scientificName);
        return (
          <button
            type="button"
            key={species.commonName}
            className="frame-gallery__portrait"
            data-tier={species.tier}
            data-active={species.commonName === activeName}
            style={portrait ? { backgroundImage: `url("${portrait.image}")` } : undefined}
            aria-label={`${species.commonName}, ${species.count} ${species.count === 1 ? "call" : "calls"}`}
            onPointerUp={(event) => {
              event.stopPropagation();
              onTap(species);
            }}
          >
            {!portrait ? <span>{species.commonName.slice(0, 1)}</span> : null}
          </button>
        );
      })}
      {more > 0 ? <span className="frame-gallery__more">+{more}</span> : null}
    </div>
  );
});
