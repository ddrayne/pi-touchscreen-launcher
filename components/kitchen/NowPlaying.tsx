import type { MediaSnapshot } from "./hooks";
import { NextIcon, PauseIcon, PlayIcon, SpeakerIcon } from "./icons";

export function mediaVisible(media: MediaSnapshot | null): media is MediaSnapshot {
  return Boolean(
    media &&
      (media.state === "playing" || media.state === "paused") &&
      (media.title || media.artist || media.source),
  );
}

/** What the kitchen speaker is playing, with the two controls people reach for. */
export function NowPlaying({
  media,
  onControl,
}: {
  media: MediaSnapshot;
  onControl: (action: "play_pause" | "next") => void;
}) {
  const playing = media.state === "playing";
  const title = media.title ?? media.source ?? "Kitchen speaker";
  const detail = [media.artist, media.title ? media.source : null]
    .filter(Boolean)
    .join(" · ");
  return (
    <section className="playing" data-state={media.state} aria-label="Kitchen speaker">
      {media.artVersion ? (
        // Album art is proxied through the Pi bridge and the Mac broker.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          className="playing__art"
          src={`/api/media/art?v=${encodeURIComponent(media.artVersion)}`}
          alt=""
        />
      ) : (
        <span className="playing__art playing__art--empty" aria-hidden="true">
          <SpeakerIcon />
        </span>
      )}
      <div className="playing__text">
        <strong>{title}</strong>
        {detail ? <span>{detail}</span> : null}
      </div>
      <button
        type="button"
        className="playing__button"
        onClick={() => onControl("play_pause")}
        aria-label={playing ? "Pause" : "Play"}
      >
        {playing ? <PauseIcon /> : <PlayIcon />}
      </button>
      <button
        type="button"
        className="playing__button"
        onClick={() => onControl("next")}
        aria-label="Next track"
      >
        <NextIcon />
      </button>
    </section>
  );
}
