/**
 * The household agenda: what is coming up, from the calendars the broker is
 * allowed to read. Bin days matter in a kitchen, so they are marked.
 */

export type HubEvent = {
  calendar: string;
  summary: string;
  start: string;
  end: string;
  allDay: boolean;
};

export type AgendaItem = {
  summary: string;
  /** "Today", "Tomorrow", "Wed", or "14 Oct", with the time for timed events. */
  when: string;
  at: number;
  allDay: boolean;
  kind: "bins" | "event";
};

const BIN_WORDS = /\b(bin|bins|recycling|refuse|rubbish|garden waste|food waste|glass collection)\b/i;

function startOfDay(at: number): number {
  const date = new Date(at);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function parseStart(value: string, allDay: boolean): number {
  if (allDay || /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [year, month, day] = value.slice(0, 10).split("-").map(Number);
    return new Date(year, month - 1, day).getTime();
  }
  return new Date(value).getTime();
}

function parseEnd(value: string, allDay: boolean, start: number): number {
  if (!value) return allDay ? start + 86_400_000 : start + 60 * 60_000;
  const end = parseStart(value, allDay);
  return Number.isFinite(end) ? end : start;
}

export function agendaLabel(at: number, allDay: boolean, now: number): string {
  const difference = Math.round((startOfDay(at) - startOfDay(now)) / 86_400_000);
  let day: string;
  if (difference === 0) day = "Today";
  else if (difference === 1) day = "Tomorrow";
  else if (difference > 1 && difference < 7) {
    day = new Intl.DateTimeFormat("en-GB", { weekday: "long" }).format(new Date(at));
  } else {
    day = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" }).format(new Date(at));
  }
  if (allDay) return day;
  const time = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false }).format(
    new Date(at),
  );
  return `${day} ${time}`;
}

export function agendaFor(events: HubEvent[] | null | undefined, now: number, limit = 4): AgendaItem[] {
  if (!events?.length) return [];
  const items: AgendaItem[] = [];
  for (const event of events) {
    if (!event?.summary || !event.start) continue;
    const at = parseStart(event.start, event.allDay);
    if (!Number.isFinite(at)) continue;
    const end = parseEnd(event.end, event.allDay, at);
    if (end <= now) continue;
    items.push({
      summary: event.summary.trim(),
      when: agendaLabel(at, event.allDay, now),
      at,
      allDay: event.allDay,
      kind: BIN_WORDS.test(event.summary) ? "bins" : "event",
    });
  }
  items.sort((left, right) => left.at - right.at);
  return items.slice(0, limit);
}
