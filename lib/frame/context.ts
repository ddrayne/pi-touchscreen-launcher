/**
 * What the screen knows, in a paragraph, for the voice session. Sent once
 * when a conversation opens, so the assistant can answer "what was that
 * bird?" from the same data the painting shows.
 */

import type { FrameConfig } from "./config.ts";
import type { FrameSnapshot } from "./scene.ts";
import type { HubWeather } from "./weather.ts";

function clockOf(at: number): string {
  return new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false }).format(
    new Date(at),
  );
}

export function gardenContext(
  now: number,
  config: FrameConfig,
  snapshot: FrameSnapshot | null,
  weather: HubWeather | null | undefined,
): string {
  const when = new Intl.DateTimeFormat("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(now));
  const lines = [
    `Context from the kitchen touchscreen, which shows a live painting of the garden heard by BirdFrame at the ${config.place} window. It is ${when}.`,
  ];
  if (!snapshot) {
    lines.push("BirdFrame is not reachable at the moment, so nothing recent is known about the garden.");
  } else {
    const latest = snapshot.latest;
    if (latest) {
      lines.push(
        `The most recent bird was a ${latest.commonName} at ${clockOf(latest.at)}${
          latest.tier ? ` (${latest.tier}, ${Math.round(latest.confidence * 100)}% confidence)` : ""
        }.`,
      );
    }
    if (snapshot.species.length) {
      const roster = snapshot.species
        .slice(0, 12)
        .map(
          (species) =>
            `${species.commonName} (${species.count} ${species.count === 1 ? "call" : "calls"}, ${species.tier}${
              species.lastHeard ? `, last ${clockOf(species.lastHeard)}` : ""
            })`,
        )
        .join("; ");
      lines.push(`Heard in the last ${snapshot.windowMinutes} minutes: ${roster}.`);
    } else {
      lines.push(`Nothing has been heard in the last ${snapshot.windowMinutes} minutes.`);
    }
    lines.push(`${snapshot.todaySpeciesCount} species have been heard today.`);
    if (snapshot.newToday.length) {
      lines.push(`New to this garden today, never recorded here before: ${snapshot.newToday.join(", ")}.`);
    }
  }
  if (weather?.condition) {
    const parts = [weather.condition.replace(/-/g, " ")];
    if (typeof weather.temperature === "number") parts.push(`${weather.temperature}°C`);
    if (typeof weather.windSpeed === "number") parts.push(`wind ${weather.windSpeed} ${weather.windSpeedUnit || "km/h"}`);
    lines.push(`Weather at home: ${parts.join(", ")}.`);
  }
  lines.push(
    "Answer questions about the garden from this context directly and briefly; only consult the agent for anything else.",
  );
  return lines.join(" ");
}
