/**
 * The blocks the home pages add to the poster's grid: the voice block, the
 * house list in two sizes, Look, the journal, the diary, the rooms and the
 * painting of the day. They share the poster's `.pb` base and palette.
 */

import { memo, type CSSProperties, type PointerEvent } from "react";
import type { AgendaItem } from "../../lib/frame/agenda.ts";
import type { InlineVoiceStatus } from "../../lib/realtimeVoice.ts";
import type { VoiceConversationEntry } from "../../lib/voiceConversation.ts";
import { clockOf, dateOf } from "../frame/blocks.tsx";

function stop(event: PointerEvent, action: () => void): void {
  event.stopPropagation();
  action();
}

/* Voice ------------------------------------------------------------------- */

export type VoiceBlockProps = {
  now: number;
  place: string;
  greeting: string;
  state: InlineVoiceStatus;
  active: boolean;
  prompt: string;
  hint: string;
  conversation: VoiceConversationEntry[];
  inputLevel: number;
  ready: boolean;
  statusLabel: string;
  onToggle: () => void;
  onEnd: () => void;
  gridArea: string;
};

function VoiceTranscriptText({ entry }: { entry: VoiceConversationEntry }) {
  const settledLength =
    entry.streaming && typeof entry.revealFrom === "number"
      ? Math.min(entry.text.length, Math.max(0, entry.revealFrom))
      : entry.text.length;
  const settled = entry.text.slice(0, settledLength);
  const arriving = entry.text.slice(settledLength);
  return (
    <span className="assistant__utterance-copy">
      {settled}
      {arriving ? (
        <span className="assistant__stream-chunk" key={`${entry.text.length}:${arriving}`}>
          {arriving}
        </span>
      ) : null}
    </span>
  );
}

export const VoiceBlock = memo(function VoiceBlock({
  now,
  place,
  greeting,
  state,
  active,
  prompt,
  hint,
  conversation,
  inputLevel,
  ready,
  statusLabel,
  onToggle,
  onEnd,
  gridArea,
}: VoiceBlockProps) {
  const orbStyle = { "--voice-level": String(Math.max(0.04, inputLevel)) } as CSSProperties;
  return (
    <section className="pb pb--house pb--voice pb--still" data-active={active} style={{ gridArea }} aria-label="Voice">
      <header className="pb__head">
        <div>
          <p className="pb__label">{place} · home</p>
          <h1 className="pb__greeting">{greeting}</h1>
        </div>
        <div className="pb__clock">
          <time className="pb__time" dateTime={new Date(now).toISOString()}>
            {clockOf(now)}
          </time>
          <span className="pb__date">{dateOf(now)}</span>
        </div>
      </header>
      <div className="pb__talk">
        <button
          className="assistant__orb-button"
          data-state={state}
          type="button"
          onPointerUp={(event) => stop(event, onToggle)}
          aria-label={active ? "End voice conversation" : "Start voice conversation"}
          style={orbStyle}
        >
          <span className="assistant__ring" />
          <span className="assistant__ring assistant__ring--middle" />
          <span className="assistant__ring assistant__ring--inner" />
          <span className="assistant__orb" />
        </button>
        <div className="pb__words">
          <h2 className="pb__prompt">{prompt}</h2>
          {conversation.length ? (
            <div className="pb__conversation" aria-live="polite" aria-label="Voice conversation">
              {conversation.slice(-3).map((entry) => (
                <p className="assistant__utterance" data-role={entry.role} data-streaming={entry.streaming} key={entry.id}>
                  <span className="assistant__speaker">{entry.role === "user" ? "You" : "Assistant"}</span>
                  <VoiceTranscriptText entry={entry} />
                </p>
              ))}
            </div>
          ) : (
            <p className="pb__hint">{hint}</p>
          )}
          <p className="pb__status">
            <span className="status-dot" data-ready={ready} />
            {statusLabel}
            {active ? (
              <button type="button" className="pb__end" onPointerUp={(event) => stop(event, onEnd)}>
                End conversation
              </button>
            ) : null}
          </p>
        </div>
      </div>
    </section>
  );
});

/* The house list ---------------------------------------------------------- */

export type ListItem = { id: string; text: string };

export type ShoppingBlockProps = {
  count: number;
  items: ListItem[];
  loaded: boolean;
  offline: boolean;
  busy: boolean;
  /** Rows the block spans: one shows a line of items, three a list to tick. */
  rows: 1 | 3;
  onOpen: () => void;
  onAdd: () => void;
  onToggle: (item: ListItem) => void;
  gridArea: string;
};

function countLine(count: number, loaded: boolean): string {
  if (!loaded) return "Loading the list";
  if (count === 0) return "Nothing to buy";
  return count === 1 ? "thing to pick up" : "things to pick up";
}

export const ShoppingBlock = memo(function ShoppingBlock({
  count,
  items,
  loaded,
  offline,
  busy,
  rows,
  onOpen,
  onAdd,
  onToggle,
  gridArea,
}: ShoppingBlockProps) {
  const label = `House list${offline ? " · offline" : ""}`;
  if (rows === 1) {
    return (
      <button type="button" className="pb pb--house pb--shopping" style={{ gridArea }} onPointerUp={(event) => stop(event, onOpen)}>
        <p className="pb__label">{label}</p>
        <p className="pb__count">
          {loaded && count > 0 ? <strong>{count}</strong> : null}
          {countLine(count, loaded)}
        </p>
        <p className="pb__line">{items.slice(0, 5).map((item) => item.text).join(" · ")}</p>
      </button>
    );
  }
  return (
    <div className="pb pb--house pb--shopping pb--still" data-tall="true" style={{ gridArea }}>
      <button type="button" className="pb__open" onPointerUp={(event) => stop(event, onOpen)} aria-label="Open the house list">
        <p className="pb__label">{label}</p>
        <p className="pb__count">
          {loaded && count > 0 ? <strong>{count}</strong> : null}
          {countLine(count, loaded)}
        </p>
      </button>
      <ul className="pb__rows">
        {items.slice(0, 5).map((item) => (
          <li key={item.id}>
            <button type="button" className="pb__row" disabled={busy} onPointerUp={(event) => stop(event, () => onToggle(item))}>
              <span className="pb__check" aria-hidden="true" />
              <span>{item.text}</span>
            </button>
          </li>
        ))}
      </ul>
      <button type="button" className="pb__add" onPointerUp={(event) => stop(event, onAdd)}>
        + Add item
      </button>
    </div>
  );
});

/* Look and the journal ---------------------------------------------------- */

export const LookBlock = memo(function LookBlock({ onTap, gridArea }: { onTap: () => void; gridArea: string }) {
  return (
    <button type="button" className="pb pb--house pb--look" style={{ gridArea }} onPointerUp={(event) => stop(event, onTap)} aria-label="Look through the camera">
      <span className="pb__eye" aria-hidden="true">
        ◉
      </span>
      <span className="pb__label">Look</span>
    </button>
  );
});

export const JournalBlock = memo(function JournalBlock({
  count,
  reachable,
  ready,
  onTap,
  gridArea,
}: {
  count: number;
  reachable: boolean;
  ready: boolean;
  onTap: () => void;
  gridArea: string;
}) {
  const line = !reachable ? "BirdFrame unreachable" : count ? `${count} ${count === 1 ? "voice" : "voices"} today` : "Listening";
  return (
    <button type="button" className="pb pb--house pb--journal" style={{ gridArea }} disabled={!ready} onPointerUp={(event) => stop(event, onTap)}>
      <p className="pb__label">The journal</p>
      <p className="pb__title">{line}</p>
      <span className="pb__go" aria-hidden="true">
        Open →
      </span>
    </button>
  );
});

/* The diary and the rooms -------------------------------------------------- */

export const DiaryBlock = memo(function DiaryBlock({ now, items, gridArea }: { now: number; items: AgendaItem[]; gridArea: string }) {
  return (
    <section className="pb pb--house pb--diary pb--still" style={{ gridArea }} aria-label="Coming up">
      <header className="pb__head">
        <p className="pb__label">Coming up</p>
        <p className="pb__label">{dateOf(now)}</p>
      </header>
      {items.length ? (
        <ol className="pb__rows">
          {items.map((item) => (
            <li key={`${item.at}-${item.summary}`} data-kind={item.kind}>
              <span className="pb__when">{item.when}</span>
              <span className="pb__summary">{item.summary}</span>
            </li>
          ))}
        </ol>
      ) : (
        <p className="pb__empty">Nothing in the shared diary this week</p>
      )}
    </section>
  );
});

export type RoomControl = { entityId: string; name: string; active: boolean };

export const RoomsBlock = memo(function RoomsBlock({
  controls,
  busy,
  onToggle,
  gridArea,
}: {
  controls: RoomControl[];
  busy: string | null;
  onToggle: (entityId: string) => void;
  gridArea: string;
}) {
  return (
    <section className="pb pb--house pb--rooms pb--still" style={{ gridArea }} aria-label="Rooms">
      <header className="pb__head">
        <p className="pb__label">Rooms</p>
        <p className="pb__label pb__label--dim">Home Assistant</p>
      </header>
      {controls.length ? (
        <ul className="pb__rows">
          {controls.slice(0, 6).map((control) => (
            <li key={control.entityId}>
              <button
                type="button"
                className="pb__room"
                data-active={control.active}
                disabled={busy !== null}
                aria-pressed={control.active}
                onPointerUp={(event) => stop(event, () => onToggle(control.entityId))}
              >
                <span className="pb__check" aria-hidden="true" />
                <span className="pb__room-name">{control.name}</span>
                <span className="pb__room-state">{busy === control.entityId ? "…" : control.active ? "On" : "Off"}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="pb__empty">No rooms to switch</p>
      )}
    </section>
  );
});

/* The painting of the day, and a plain note ------------------------------- */

export const PaintingBlock = memo(function PaintingBlock({ image, onTap, gridArea }: { image: string; onTap: () => void; gridArea: string }) {
  return (
    <button
      type="button"
      className="pb pb--bird pb--painting"
      data-tier="medium"
      data-wide="true"
      style={{ gridArea }}
      aria-label="Today’s painting; open the journal"
      onPointerUp={(event) => stop(event, onTap)}
    >
      <span className="pb__photo" style={{ backgroundImage: `url("${image}")` }} aria-hidden="true" />
      <span className="pb__shade" aria-hidden="true" />
      <span className="pb__text">
        <h2 className="pb__name">Today’s painting</h2>
      </span>
    </button>
  );
});

export const NoteBlock = memo(function NoteBlock({
  label,
  title,
  meta,
  onTap,
  gridArea,
}: {
  label: string;
  title: string;
  meta?: string;
  onTap?: () => void;
  gridArea: string;
}) {
  const content = (
    <>
      <p className="pb__label">{label}</p>
      <p className="pb__title">{title}</p>
      {meta ? <p className="pb__meta">{meta}</p> : null}
    </>
  );
  if (!onTap) {
    return (
      <div className="pb pb--house pb--note pb--still" style={{ gridArea }}>
        {content}
      </div>
    );
  }
  return (
    <button type="button" className="pb pb--house pb--note" style={{ gridArea }} onPointerUp={(event) => stop(event, onTap)}>
      {content}
    </button>
  );
});
