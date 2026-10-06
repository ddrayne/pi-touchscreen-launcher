/** Today's cast along the foot of the board: the species heard earlier today. */

import { memo } from "react";
import type { Portrait } from "../../lib/frame/portraits.ts";
import type { FrameSpecies } from "../../lib/frame/scene.ts";

type GalleryProps = {
  cast: FrameSpecies[];
  portraits: Map<string, Portrait | null>;
  activeName: string | null;
  onTap: (species: FrameSpecies) => void;
};

export const Gallery = memo(function Gallery({ cast, portraits, activeName, onTap }: GalleryProps) {
  if (!cast.length) return null;
  const shown = cast.slice(0, 10);
  const more = cast.length - shown.length;
  return (
    <div className="frame-gallery" aria-label="Earlier today">
      <span className="frame-gallery__label">Earlier today</span>
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
            title={species.commonName}
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
