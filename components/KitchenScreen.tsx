"use client";

import { useCallback, useMemo, useState } from "react";
import { summariseGarden, type BirdframeNow } from "../lib/birds";
import { liveTimers, voiceBusy } from "../lib/lva";
import { isNight, shouldSleep } from "../lib/presence";
import { upcomingHours, type WeatherSnapshot } from "../lib/weather";
import { GardenHero } from "./kitchen/Garden";
import { Masthead, RainStrip } from "./kitchen/Glance";
import {
  useClipPlayer,
  useDisplaySleep,
  useHomeEvents,
  useLva,
  useNow,
  usePolledJson,
  useRecent,
} from "./kitchen/hooks";
import { NowPlaying, mediaVisible } from "./kitchen/NowPlaying";
import { TalkButton, TimerAlarm, TimerBand, VoicePanel } from "./kitchen/Voice";

/** Linux Voice Assistant's peripheral socket; it only listens on the Pi itself. */
const LVA_URL = "ws://127.0.0.1:6055";
const SLEEP_AFTER_MS = 5 * 60_000;
const CAPTION_LINGER_MS = 8_000;
/** From this many running timers, the garden steps back to a single row. */
const CROWDED_TIMERS = 3;

/**
 * The kitchen screen: the garden's birds as the face of the screen, with the
 * clock, rain, timers, the kitchen speaker and voice captions around it. It
 * goes dark a few minutes after the kitchen empties and wakes when anyone
 * walks in, speaks, or touches it.
 */
export function KitchenScreen() {
  const voice = useLva(LVA_URL);
  const home = useHomeEvents();
  const clip = useClipPlayer();
  const now = useNow(15_000);
  const [lastTouchAt, setLastTouchAt] = useState(0);

  const { heard, reply, error, activityAt } = voice.state;
  const timers = liveTimers(voice.state.timers, now.getTime());
  const voiceActive = voiceBusy(voice.state, now.getTime());
  const captionsRecent = useRecent(activityAt, CAPTION_LINGER_MS);
  const showVoice = voiceActive || (captionsRecent && Boolean(heard || reply || error));

  const asleep = shouldSleep({
    now: now.getTime(),
    presence: home.connected ? home.presence : null,
    lastTouchAt,
    timersActive: timers.length > 0,
    voiceActive,
    sleepAfterMs: SLEEP_AFTER_MS,
  });
  useDisplaySleep(asleep, lastTouchAt);

  const refreshKey = asleep ? "asleep" : "awake";
  const garden = usePolledJson<BirdframeNow>("/api/birdframe", 20_000, refreshKey);
  const weather = usePolledJson<WeatherSnapshot>("/api/weather", 10 * 60_000, refreshKey);
  // Aged by BirdFrame's silence, so an unreachable garden doesn't sing forever.
  const summary = useMemo(
    () =>
      summariseGarden(
        garden.data,
        garden.updatedAt ? (now.getTime() - garden.updatedAt) / 1000 : 0,
      ),
    [garden.data, garden.updatedAt, now],
  );
  const hours = useMemo(
    () => upcomingHours(weather.data?.hours ?? [], now),
    [now, weather.data],
  );

  const ringing = timers.find((timer) => timer.ringing) ?? null;
  const runningTimers = timers.filter((timer) => !timer.ringing).length;
  const { send, dismiss } = voice;
  const stopRinging = useCallback(() => {
    if (!ringing) return;
    send("stop_timer_ringing");
    dismiss(ringing.id);
  }, [dismiss, ringing, send]);

  const controlMedia = useCallback((action: "play_pause" | "next") => {
    void fetch("/api/media/control", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    }).catch(() => undefined);
  }, []);

  const media = home.media;

  return (
    <main
      className="screen"
      data-night={isNight(now)}
      data-asleep={asleep}
      data-voice={showVoice}
      data-crowded={runningTimers >= CROWDED_TIMERS}
      aria-label="Kitchen screen"
      onPointerDown={() => setLastTouchAt(Date.now())}
      suppressHydrationWarning
    >
      <Masthead now={now} weather={weather.data} />
      {runningTimers ? <TimerBand timers={timers} /> : null}
      <GardenHero
        summary={summary}
        offline={garden.failed && !garden.data}
        playing={clip.playing}
        onPlay={clip.play}
        onStop={clip.stop}
      />
      {hours.length ? <RainStrip hours={hours} /> : null}
      <footer className="dock">
        {mediaVisible(media) ? (
          <NowPlaying media={media} onControl={controlMedia} />
        ) : (
          <p className="dock__note">
            {summary.voicesToday
              ? `${summary.voicesToday} ${summary.voicesToday === 1 ? "kind" : "kinds"} of bird heard today`
              : "BirdFrame is listening"}
          </p>
        )}
        <TalkButton
          voice={voice.state}
          busy={voiceActive}
          onTalk={() => send("start_listening")}
          onStop={() => send("stop_pipeline")}
        />
      </footer>
      {showVoice ? <VoicePanel voice={voice.state} /> : null}
      {ringing ? <TimerAlarm timer={ringing} onStop={stopRinging} /> : null}
      <div className="sleep" aria-hidden="true" />
    </main>
  );
}
