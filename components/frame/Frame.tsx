/**
 * The frame: a BirdFrame-centric board over a sky that keeps the real time of
 * day. The garden's roll call is the heart of it; the weather ahead and what
 * is coming up at home sit around it. It may dramatise; it may not
 * fabricate. The journal is one tap away.
 */

import { useCallback, useMemo, type CSSProperties } from "react";
import { agendaFor, type HubEvent } from "../../lib/frame/agenda.ts";
import { showPaintingPlate } from "../../lib/frame/birds.ts";
import type { FrameConfig } from "../../lib/frame/config.ts";
import { usePortraits } from "../../lib/frame/portraits.ts";
import {
  bloomIsLeaving,
  castFor,
  nextBloom,
  QUIET_AFTER_MS,
  quietFor,
  rollCall,
  type FrameSpecies,
} from "../../lib/frame/scene.ts";
import {
  daylightLabel,
  mixRgb,
  moonIllumination,
  moonPosition,
  rgbCss,
  skyPalette,
  smoothstep,
  sunIsRising,
  sunPosition,
  sunTimes,
  type Rgb,
} from "../../lib/frame/solar.ts";
import type { BirdframeStream } from "../../lib/frame/stream.ts";
import type { BirdVoices } from "../../lib/frame/voices.ts";
import { parseForecast, weatherMood, type HubWeather } from "../../lib/frame/weather.ts";
import { Agenda, RollCall, WeatherStrip } from "./Board.tsx";
import { Gallery } from "./Gallery.tsx";
import { Sky } from "./Sky.tsx";
import "./frame.css";

export type FrameMode = "frame" | "home" | "conversation";

/** What the household hub gives the board; the launcher's hub type is a superset. */
export type FrameHub = {
  weather: HubWeather | null;
  forecast?: unknown;
  events?: HubEvent[];
};

type FrameProps = {
  now: number;
  config: FrameConfig;
  stream: BirdframeStream;
  hub: FrameHub | null;
  shoppingCount: number;
  mode: FrameMode;
  voices: BirdVoices;
  onOpenJournal: () => void;
};

const PAPER_DAY: Rgb = [242, 239, 229];
const PAPER_NIGHT: Rgb = [26, 30, 50];
const GROUND_DAY: Rgb = [236, 233, 222];
const GROUND_NIGHT: Rgb = [22, 26, 44];
const CLOUD_DAY: Rgb = [251, 248, 239];
const CLOUD_NIGHT: Rgb = [46, 52, 84];
const INK_DAY: Rgb = [22, 42, 36];
const INK_NIGHT: Rgb = [9, 11, 24];
const TYPE_DAY: Rgb = [22, 42, 36];
const TYPE_NIGHT: Rgb = [236, 228, 206];
const GOLD: Rgb = [201, 133, 54];
const PULSE_MS = 3_000;
const ROLL_ROWS = 6;

/**
 * Type follows the paper, not the sun: dark ink while the washed sky is
 * light, cream once dusk has taken it. Home uses it too, over the same sky.
 */
export function typeInkFor(darkness: number): Rgb {
  return mixRgb(TYPE_DAY, TYPE_NIGHT, smoothstep(0.18, 0.3, darkness));
}

const CLOCK = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false });
const DATE = new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long" });

function clockOf(at: number): string {
  return CLOCK.format(new Date(at));
}

function dateOf(at: number): string {
  return DATE.format(new Date(at));
}

export function Frame({ now, config, stream, hub, shoppingCount, mode, voices, onOpenJournal }: FrameProps) {
  const { snapshot, reachable, heartbeat } = stream;
  // Hearing a bird: its own recording through the Pi's speaker, shared with home.
  const { day, playing, songLevel, hear } = voices;
  const paletteTick = Math.floor(now / 5_000) * 5_000;
  const rowsTick = Math.floor(now / 15_000) * 15_000;
  const weather = hub?.weather ?? null;

  const sun = useMemo(
    () => sunPosition(paletteTick, config.latitude, config.longitude),
    [paletteTick, config.latitude, config.longitude],
  );
  const moon = useMemo(
    () => moonPosition(paletteTick, config.latitude, config.longitude),
    [paletteTick, config.latitude, config.longitude],
  );
  const illumination = useMemo(() => moonIllumination(paletteTick), [paletteTick]);
  const rising = useMemo(
    () => sunIsRising(paletteTick, config.latitude, config.longitude),
    [paletteTick, config.latitude, config.longitude],
  );
  const palette = useMemo(() => skyPalette(sun.elevation, rising), [sun.elevation, rising]);
  const times = useMemo(
    () => sunTimes(paletteTick, config.latitude, config.longitude),
    [paletteTick, config.latitude, config.longitude],
  );
  const mood = useMemo(() => weatherMood(weather, config.facing), [weather, config.facing]);
  const forecast = useMemo(() => parseForecast(hub?.forecast), [hub?.forecast]);
  const agenda = useMemo(() => agendaFor(hub?.events, rowsTick), [hub?.events, rowsTick]);
  const isNight = sun.elevation < -6;

  const rows = useMemo(() => rollCall(snapshot, rowsTick, ROLL_ROWS), [snapshot, rowsTick]);
  const hourRows = rows.filter((row) => !row.earlier).length;
  const moreCount = snapshot && hourRows === rows.length ? Math.max(0, snapshot.species.length - rows.length) : 0;
  const cast = useMemo(() => castFor(snapshot), [snapshot]);
  const earlierToday = useMemo(() => {
    const shown = new Set(rows.map((row) => row.species.commonName));
    return cast.filter((species) => !shown.has(species.commonName));
  }, [cast, rows]);

  // The bloom: what, if anything, is having its moment, as a pure function of
  // the snapshot and the clock.
  const bloomNow = useMemo(() => (snapshot ? nextBloom(snapshot, { now }) : null), [snapshot, now]);
  const leaving = bloomNow !== null && bloomIsLeaving(bloomNow, now);
  const bloom = bloomNow && !leaving ? bloomNow : null;

  // After last light the day's painting hangs as a plate beside the agenda;
  // the roll call stays the heart of the board.
  const plate = showPaintingPlate(palette.darkness, day?.artwork) ? day?.artwork ?? null : null;

  // The listening pulse: a ring every time the bridge hears from BirdFrame.
  const pulsing = reachable && heartbeat > 0 && now - heartbeat < PULSE_MS;

  const portraitNames = useMemo(() => {
    const names = new Set<string>();
    for (const row of rows) if (row.species.scientificName) names.add(row.species.scientificName);
    for (const species of earlierToday.slice(0, 10)) if (species.scientificName) names.add(species.scientificName);
    if (bloomNow?.scientificName) names.add(bloomNow.scientificName);
    return [...names];
  }, [rows, earlierToday, bloomNow]);
  const portraits = usePortraits(portraitNames);

  const castTapped = useCallback((species: FrameSpecies) => hear(species.commonName), [hear]);

  const ink = mixRgb(INK_DAY, INK_NIGHT, palette.darkness);
  const typeInk = typeInkFor(palette.darkness);
  const paper = mixRgb(PAPER_DAY, PAPER_NIGHT, palette.darkness);
  const ground = mixRgb(GROUND_DAY, GROUND_NIGHT, palette.darkness);
  const cloud = mixRgb(CLOUD_DAY, CLOUD_NIGHT, palette.darkness);
  const style = {
    "--frame-zenith": rgbCss(palette.zenith),
    "--frame-mid": rgbCss(palette.mid),
    "--frame-horizon": rgbCss(palette.horizon),
    "--frame-glow": rgbCss(palette.glow),
    "--frame-lawn": rgbCss(ground),
    "--frame-cloud": rgbCss(cloud),
    "--frame-ink-rgb": ink.join(" "),
    "--frame-type-rgb": typeInk.join(" "),
    "--frame-paper-rgb": paper.join(" "),
    "--frame-gold-rgb": GOLD.join(" "),
    "--frame-darkness": String(palette.darkness),
  } as CSSProperties;

  const daylight = daylightLabel(now, times);
  const latest = snapshot?.latest ?? null;
  const quietMs = quietFor(snapshot, now);
  const status = !reachable
    ? `BirdFrame unreachable${latest ? ` · last heard ${clockOf(latest.at)}` : ""}`
    : !snapshot
      ? "Waiting for BirdFrame"
      : quietMs !== null && quietMs > QUIET_AFTER_MS
        ? `Quiet for ${Math.round(quietMs / 60_000)} min · ${snapshot.todaySpeciesCount} ${snapshot.todaySpeciesCount === 1 ? "voice" : "voices"} today`
        : `${snapshot.species.length} ${snapshot.species.length === 1 ? "voice" : "voices"} in the last hour · ${snapshot.todaySpeciesCount} today`;

  return (
    <div className="frame" data-mode={mode} data-night={isNight} data-plate={plate !== null} style={style} aria-hidden={mode !== "frame"}>
      <div className="frame__painting">
        <Sky palette={palette} sun={sun} moon={moon} illumination={illumination} mood={mood} facing={config.facing} />
        <div className="frame-wash" />
        {pulsing ? <div className="frame-pulse" key={heartbeat} /> : null}
        {!reachable && snapshot ? <div className="frame-unreachable" /> : null}
        <div className="frame-grain" />
      </div>
      <div className="frame__veil" />
      <div className="frame__chrome">
        <div className="frame-place">
          <p className="frame-place__eyebrow">The {config.place} window</p>
          {daylight ? <p className="frame-place__daylight">{daylight}</p> : null}
          <p className="frame-place__status">{status}</p>
        </div>
        <div className="frame-clock">
          <time className="frame-clock__time" dateTime={new Date(rowsTick).toISOString()}>
            {clockOf(now)}
          </time>
          <span className="frame-clock__date">{dateOf(now)}</span>
        </div>
        <WeatherStrip now={rowsTick} weather={weather} forecast={forecast} night={isNight} />
        <RollCall
          rows={rows}
          bloom={bloom}
          leaving={leaving}
          portraits={portraits}
          playing={playing}
          songLevel={songLevel}
          daylight={daylight}
          moreCount={moreCount}
          onTap={hear}
        />
        <Agenda items={agenda} shoppingCount={shoppingCount} />
        {plate ? (
          <button
            type="button"
            className="frame-plate"
            aria-label="BirdFrame's painting of the day; open the journal"
            onPointerUp={(event) => {
              event.stopPropagation();
              onOpenJournal();
            }}
          >
            <span className="frame-plate__image" style={{ backgroundImage: `url("${plate}")` }} />
            <span className="frame-plate__caption">Painting of the day</span>
          </button>
        ) : null}
        <Gallery cast={earlierToday} portraits={portraits} activeName={playing} onTap={castTapped} />
        <div className="frame-foot">
          <span>An impression of the last hour · one dot is one call</span>
          <button type="button" onPointerUp={(event) => { event.stopPropagation(); onOpenJournal(); }}>
            The journal is one tap away →
          </button>
        </div>
      </div>
    </div>
  );
}
