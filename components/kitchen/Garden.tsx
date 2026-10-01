"use client";

import { Fragment, useState } from "react";
import type { GardenSummary } from "../../lib/birds";
import { PlayIcon, StopIcon } from "./icons";

/**
 * The bird singing in the garden now: its picture, its name, and the actual
 * recording BirdFrame kept from today. Sound comes first; the picture is the
 * face for it.
 */
export function GardenHero({
  summary,
  offline,
  playing,
  onPlay,
  onStop,
}: {
  summary: GardenSummary;
  offline: boolean;
  playing: string | null;
  onPlay: (src: string) => void;
  onStop: () => void;
}) {
  const [missingPhoto, setMissingPhoto] = useState<string | null>(null);
  const hero = summary.hero;

  if (!hero) {
    return (
      <section className="garden garden--empty" aria-labelledby="garden-name">
        <div className="garden__picture" aria-hidden="true">
          <span className="garden__initial">~</span>
        </div>
        <div className="garden__text">
          <p className="garden__eyebrow">The garden</p>
          <h1 className="garden__name" id="garden-name">
            {offline ? "Can't reach BirdFrame" : "Listening to the garden"}
          </h1>
          <p className="garden__label">
            {offline
              ? "The garden will be back when the Mac is."
              : "Nothing reliable heard in the last few hours."}
          </p>
        </div>
      </section>
    );
  }

  const clipPath = hero.clipPath;
  const isPlaying = clipPath !== null && playing === clipPath;
  const showPhoto = missingPhoto !== hero.photoPath;
  const eyebrow = summary.quiet ? "The garden is quiet" : "In the garden";
  // "Eurasian Wren" files under W: the last word is the bird.
  const initial = hero.commonName.trim().split(/\s+/).pop()?.charAt(0) ?? "";

  return (
    <section
      className="garden"
      data-freshness={hero.freshness}
      aria-labelledby="garden-name"
    >
      <div className="garden__picture">
        {showPhoto ? (
          // The photo comes from the Pi's own cache, so next/image is not involved.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={hero.photoPath}
            alt=""
            onError={() => setMissingPhoto(hero.photoPath)}
          />
        ) : (
          <span className="garden__initial" aria-hidden="true">
            {initial}
          </span>
        )}
        {hero.firstEver ? (
          <span className="garden__badge">First time in the garden</span>
        ) : null}
      </div>
      <div className="garden__text">
        <p className="garden__eyebrow">
          {hero.freshness === "now" ? (
            <span className="garden__live" aria-hidden="true" />
          ) : null}
          {eyebrow}
        </p>
        <h1 className="garden__name" id="garden-name">
          {hero.commonName}
        </h1>
        <p className="garden__label">
          {hero.label}
          {hero.tier === "probable" ? <span className="garden__tier">Probable</span> : null}
        </p>
      </div>
      <div className="garden__actions">
        {clipPath ? (
          <button
            type="button"
            className="garden__hear"
            aria-pressed={isPlaying}
            onClick={() => (isPlaying ? onStop() : onPlay(clipPath))}
          >
            {isPlaying ? <StopIcon /> : <PlayIcon />}
            {isPlaying ? "Stop" : "Hear it"}
          </button>
        ) : null}
        {summary.earlier.length ? (
          <p className="garden__earlier">
            <strong>Earlier</strong>{" "}
            {summary.earlier.slice(0, 3).map((name, index) => (
              <Fragment key={name}>
                {index ? "\u00a0· " : null}
                <span>{name}</span>
              </Fragment>
            ))}
          </p>
        ) : null}
      </div>
    </section>
  );
}
