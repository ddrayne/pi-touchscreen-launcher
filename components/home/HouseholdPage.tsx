/**
 * The Household page on the poster's grid: the diary and the rooms across
 * the top five rows, the house list beside the garden (or, after dark, the
 * day's painting) and the journal, then the weather and the week.
 */

import { memo } from "react";
import type { AgendaItem } from "../../lib/frame/agenda.ts";
import type { GroundPalette } from "../../lib/frame/palette.ts";
import type { Portrait } from "../../lib/frame/portraits.ts";
import type { BirdBlock as BirdBlockModel } from "../../lib/frame/poster.ts";
import type { ForecastDay, HubWeather } from "../../lib/frame/weather.ts";
import { colourOf } from "../frame/BirdField.tsx";
import { BirdBlock, ClockBlock, ForecastBlock, StatusBlock, WeatherBlock } from "../frame/blocks.tsx";
import { DiaryBlock, JournalBlock, LookBlock, NoteBlock, PaintingBlock, RoomsBlock, ShoppingBlock, type RoomControl } from "./homeBlocks.tsx";
import { HOME_COOL_MS, type ShoppingProps } from "./VoicePage.tsx";
import "./home.css";

const GARDEN_AREA = { col: 3, row: 0, cols: 3, rows: 3 };
const GARDEN_ROW_OFFSET = 5;
const GARDEN_GRID_AREA = "6 / 4 / span 3 / span 3";

export type GardenProps = {
  /** The latest bird's block from today's field, if it is on the field. */
  block: BirdBlockModel | null;
  portrait: Portrait | null;
  /** What to say when there is no block: the latest name, or that the garden is quiet. */
  title: string;
  meta: string;
  /** The day's painting, shown after dark instead of the bird. */
  painting: string | null;
  night: boolean;
};

export type HouseholdPageProps = {
  now: number;
  minuteTick: number;
  place: string;
  daylight: string;
  agenda: AgendaItem[];
  controls: RoomControl[];
  hubBusy: string | null;
  onToggleControl: (entityId: string) => void;
  shopping: ShoppingProps;
  garden: GardenProps;
  ground: GroundPalette;
  playing: string | null;
  onHear: (commonName: string) => void;
  weather: HubWeather | null;
  forecast: ForecastDay[];
  todayCount: number;
  reachable: boolean;
  journalReady: boolean;
  onOpenJournal: () => void;
  onOpenCamera: () => void;
};

export const HouseholdPage = memo(function HouseholdPage({
  now,
  minuteTick,
  place,
  daylight,
  agenda,
  controls,
  hubBusy,
  onToggleControl,
  shopping,
  garden,
  ground,
  playing,
  onHear,
  weather,
  forecast,
  todayCount,
  reachable,
  journalReady,
  onOpenJournal,
  onOpenCamera,
}: HouseholdPageProps) {
  let gardenBlock: React.ReactNode;
  if (garden.night && garden.painting) {
    gardenBlock = <PaintingBlock image={garden.painting} onTap={onOpenJournal} gridArea={GARDEN_GRID_AREA} />;
  } else if (garden.block) {
    const colour = colourOf(garden.block.age, garden.portrait, ground, HOME_COOL_MS);
    gardenBlock = (
      <BirdBlock
        block={{ ...garden.block, area: GARDEN_AREA }}
        portrait={garden.portrait}
        tint={colour.tint}
        type={colour.type}
        saturation={colour.saturation}
        dim={ground.dim}
        rowOffset={GARDEN_ROW_OFFSET}
        playing={playing === garden.block.key}
        arrival={0}
        born={false}
        onTap={onHear}
      />
    );
  } else {
    gardenBlock = <NoteBlock label="Garden right now" title={garden.title} meta={garden.meta} onTap={onOpenJournal} gridArea={GARDEN_GRID_AREA} />;
  }

  return (
    <div className="poster poster--home">
      <ClockBlock now={now} gridArea="1 / 1 / span 2 / span 3" onTap={() => undefined} />
      <WeatherBlock weather={weather} night={garden.night} gridArea="1 / 4 / span 2 / span 2" onTap={() => undefined} />
      <StatusBlock
        place={place}
        daylight={daylight}
        count={reachable ? todayCount : null}
        countLabel={reachable ? "voices today" : "unreachable"}
        gridArea="1 / 6 / span 2 / span 1"
      />
      <DiaryBlock now={now} items={agenda} gridArea="3 / 1 / span 3 / span 4" />
      <RoomsBlock controls={controls} busy={hubBusy} onToggle={onToggleControl} gridArea="3 / 5 / span 3 / span 2" />
      <ShoppingBlock {...shopping} rows={3} gridArea="6 / 1 / span 3 / span 3" />
      {gardenBlock}
      <ForecastBlock now={minuteTick} forecast={forecast} gridArea="9 / 1 / span 1 / span 6" onTap={() => undefined} />
      <JournalBlock count={todayCount} reachable={reachable} ready={journalReady} onTap={onOpenJournal} gridArea="10 / 1 / span 1 / span 4" />
      <LookBlock onTap={onOpenCamera} gridArea="10 / 5 / span 1 / span 2" />
    </div>
  );
});
