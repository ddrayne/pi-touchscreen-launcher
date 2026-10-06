/**
 * The frame: a BirdFrame-centric board over a sky that keeps the real time of
 * day. The garden's roll call is the heart of it; the weather ahead and what
 * is coming up at home sit around it. It may dramatise; it may not
 * fabricate. The journal is one tap away.
 */

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { agendaFor, type HubEvent } from "../../lib/frame/agenda.ts";
import { withFrameTime } from "../../lib/frame/clock.ts";
import { playClip, stopClip } from "../../lib/frame/clips.ts";
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

type DayRecord = {
  date: string;
  artwork: string | null;
  narration: string;
  speciesCount: number;
  newSpecies: string[];
  clips: Map<string, string>;
};

type FrameProps = {
  now: number;
  config: FrameConfig;
  stream: BirdframeStream;
  hub: FrameHub | null;
  shoppingCount: number;
  mode: FrameMode;
  muteWake: (seconds: number) => void;
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

function clockOf(at: number): string {
  return new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false }).format(
    new Date(at),
  );
}

function dateOf(at: number): string {
  return new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long" }).format(
    new Date(at),
  );
}

function dayKey(at: number): string {
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

export function Frame({ now, config, stream, hub, shoppingCount, mode, muteWake, onOpenJournal }: FrameProps) {
  const { snapshot, reachable, heartbeat } = stream;
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
  const moreCount = snapshot && !rows[0]?.earlier ? Math.max(0, snapshot.species.length - rows.length) : 0;
  const cast = useMemo(() => castFor(snapshot), [snapshot]);
  const earlierToday = useMemo(() => {
    const shown = new Set(rows.map((row) => row.species.commonName));
    return cast.filter((species) => !shown.has(species.commonName));
  }, [cast, rows]);
  const day = useDayRecord(dayKey(now));

  // The bloom: what, if anything, is having its moment, as a pure function of
  // the snapshot and the clock.
  const bloomNow = useMemo(() => (snapshot ? nextBloom(snapshot, { now }) : null), [snapshot, now]);
  const leaving = bloomNow !== null && bloomIsLeaving(bloomNow, now);
  const bloom = bloomNow && !leaving ? bloomNow : null;

  // Night rest: after last light the day's painting hangs as the closing plate.
  const rest = palette.darkness > 0.85 && Boolean(day?.artwork) && !bloom && mode === "frame";

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

  // Hearing a bird: its own recording through the Pi's speaker.
  const [playing, setPlaying] = useState<string | null>(null);
  const [songLevel, setSongLevel] = useState(0);
  const hear = useCallback(
    (commonName: string, explicitUrl?: string | null) => {
      if (playing === commonName) {
        stopClip();
        setPlaying(null);
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
    [day, muteWake, now, playing],
  );
  useEffect(() => () => stopClip(), []);
  const castTapped = useCallback((species: FrameSpecies) => hear(species.commonName), [hear]);

  const ink = mixRgb(INK_DAY, INK_NIGHT, palette.darkness);
  // Type follows the paper, not the sun: dark ink while the washed sky is
  // light, cream once dusk has taken it.
  const typeInk = mixRgb(TYPE_DAY, TYPE_NIGHT, smoothstep(0.18, 0.3, palette.darkness));
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
    <div className="frame" data-mode={mode} data-night={isNight} data-rest={rest} style={style} aria-hidden={mode !== "frame"}>
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
          <time className="frame-clock__time" dateTime={new Date(now).toISOString()}>
            {clockOf(now)}
          </time>
          <span className="frame-clock__date">{dateOf(now)}</span>
        </div>
        <WeatherStrip now={now} weather={weather} forecast={forecast} night={isNight} />
        {rest && day?.artwork ? (
          <figure className="frame-rest">
            <div className="frame-rest__plate" style={{ backgroundImage: `url("${day.artwork}")` }} />
            <figcaption>
              {day.narration ? <p className="frame-rest__caption">{day.narration}</p> : null}
              <p className="frame-rest__tally">
                {day.speciesCount || snapshot?.todaySpeciesCount || 0} voices today · BirdFrame&apos;s painting of the day
              </p>
            </figcaption>
          </figure>
        ) : (
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
        )}
        <Agenda items={agenda} shoppingCount={shoppingCount} />
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
