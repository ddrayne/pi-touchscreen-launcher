/**
 * The Voice page: the same 6 x 10 poster as the idle frame. The voice block
 * takes the top three rows, today's birds the six beneath, sized by the
 * day's counts, and the house list, Look and the journal the last row.
 */

import { memo, useRef } from "react";
import type { GroundPalette } from "../../lib/frame/palette.ts";
import type { Portrait } from "../../lib/frame/portraits.ts";
import type { PosterField } from "../../lib/frame/poster.ts";
import { BirdField, useFlip } from "../frame/BirdField.tsx";
import { JournalBlock, LookBlock, ShoppingBlock, VoiceBlock, type ListItem, type VoiceBlockProps } from "./homeBlocks.tsx";
import "./home.css";

/** Today's birds sit under three rows of voice. */
export const TODAY_ROW_OFFSET = 3;
/** The home pages cool slowly: a bird heard this morning is still itself at tea time. */
export const HOME_COOL_MS = 6 * 60 * 60_000;

export type ShoppingProps = {
  count: number;
  items: ListItem[];
  loaded: boolean;
  offline: boolean;
  busy: boolean;
  onOpen: () => void;
  onAdd: () => void;
  onToggle: (item: ListItem) => void;
};

export type VoicePageProps = {
  now: number;
  minuteTick: number;
  voice: Omit<VoiceBlockProps, "now" | "gridArea">;
  field: PosterField;
  bornKeys: ReadonlySet<string>;
  arrivals: ReadonlyMap<string, number>;
  portraits: Map<string, Portrait | null>;
  ground: GroundPalette;
  playing: string | null;
  onHear: (commonName: string) => void;
  shopping: ShoppingProps;
  todayCount: number;
  reachable: boolean;
  journalReady: boolean;
  onOpenJournal: () => void;
  onOpenCamera: () => void;
};

export const VoicePage = memo(function VoicePage({
  now,
  minuteTick,
  voice,
  field,
  bornKeys,
  arrivals,
  portraits,
  ground,
  playing,
  onHear,
  shopping,
  todayCount,
  reachable,
  journalReady,
  onOpenJournal,
  onOpenCamera,
}: VoicePageProps) {
  const root = useRef<HTMLDivElement | null>(null);
  useFlip(root, field);
  return (
    <div className="poster poster--home" ref={root}>
      <VoiceBlock {...voice} now={now} gridArea="1 / 1 / span 3 / span 6" />
      <BirdField
        field={field}
        minuteTick={minuteTick}
        bornKeys={bornKeys}
        arrivals={arrivals}
        portraits={portraits}
        ground={ground}
        rowOffset={TODAY_ROW_OFFSET}
        coolMs={HOME_COOL_MS}
        playing={playing}
        onHear={onHear}
        onMore={onOpenJournal}
      />
      <ShoppingBlock {...shopping} rows={1} gridArea="10 / 1 / span 1 / span 3" />
      <LookBlock onTap={onOpenCamera} gridArea="10 / 4 / span 1 / span 1" />
      <JournalBlock count={todayCount} reachable={reachable} ready={journalReady} onTap={onOpenJournal} gridArea="10 / 5 / span 1 / span 2" />
    </div>
  );
});
