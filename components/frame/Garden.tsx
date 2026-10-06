/**
 * The garden line, drawn from the owner's photographs of the real view:
 * the lawn with the bird bath and the rotary dryer, the clipped hedge with
 * its rounded end, the wooden fence, two big trees, and beyond them the
 * four-storey tenement with its ranks of chimney pots. Ink on paper; the
 * colours come from CSS variables so the same drawing serves day and night.
 */

import { memo, type CSSProperties, type ReactElement } from "react";
import { FRAME_HEIGHT, FRAME_WIDTH, GARDEN_HEIGHT } from "../../lib/frame/garden.ts";

type GardenProps = {
  /** 0 bare .. 1 full canopy. */
  leaf: number;
  /** 0 .. 1, how many tenement windows glow. 0 by day. */
  lamps: number;
  /** Wind 0..1 drives the sway animation speed through a CSS variable. */
  wind: number;
  /** Deterministic choice of which windows are lit. */
  seed: number;
};

const CHIMNEYS = [110, 300, 490, 680];
const DORMERS = [190, 400, 600];
const WINDOW_COLUMNS = Array.from({ length: 9 }, (_, index) => 72 + index * 72);
const WINDOW_ROWS = [176, 216, 256, 296];

function canopy(blobs: Array<[number, number, number]>, className: string): ReactElement {
  return (
    <g className={className}>
      {blobs.map(([cx, cy, r], index) => (
        <circle cx={cx} cy={cy} r={r} key={index} />
      ))}
    </g>
  );
}

function lit(seed: number, column: number, row: number, lamps: number): boolean {
  const hash = ((seed * 31 + column * 7 + row * 13) * 2_654_435_761) >>> 0;
  return (hash % 1000) / 1000 < lamps * 0.5;
}

export const Garden = memo(function Garden({ leaf, lamps, wind, seed }: GardenProps) {
  const swayStyle = { "--frame-wind": String(wind) } as CSSProperties;
  return (
    <svg
      className="frame-garden"
      viewBox={`0 0 ${FRAME_WIDTH} ${FRAME_HEIGHT}`}
      preserveAspectRatio="xMidYMax slice"
      aria-hidden="true"
      style={swayStyle}
    >
      <g transform={`translate(0 ${FRAME_HEIGHT - GARDEN_HEIGHT})`}>
      {/* The tenement beyond: far ink, flat, no detail smaller than a pot. */}
      <g className="frame-garden__far">
        <polygon points="30,160 60,112 710,112 740,160" />
        <rect x="30" y="158" width="710" height="200" />
        {CHIMNEYS.map((x) => (
          <g key={x}>
            <rect x={x - 22} y={62} width={44} height={60} />
            {[-16, -6, 4, 14].map((offset) => (
              <rect x={x + offset - 1} y={44} width={8} height={20} rx={1.5} key={offset} />
            ))}
          </g>
        ))}
        {DORMERS.map((x) => (
          <polygon key={x} points={`${x - 26},150 ${x - 26},124 ${x},110 ${x + 26},124 ${x + 26},150`} />
        ))}
      </g>
      <g className="frame-garden__windows">
        {WINDOW_ROWS.map((y) =>
          WINDOW_COLUMNS.map((x) => (
            <rect
              key={`${x}-${y}`}
              x={x}
              y={y}
              width={20}
              height={28}
              data-lit={lit(seed, x, y, lamps) ? "true" : undefined}
            />
          )),
        )}
      </g>

      {/* The smaller tree on the left: bare branches, then leaves by season. */}
      <g className="frame-garden__tree frame-garden__tree--west">
        <polygon points="138,620 146,400 158,400 168,620" />
        <g className="frame-garden__branches">
          <line x1="152" y1="410" x2="90" y2="300" />
          <line x1="152" y1="410" x2="210" y2="290" />
          <line x1="152" y1="400" x2="150" y2="230" />
          <line x1="120" y1="350" x2="60" y2="330" />
          <line x1="190" y1="330" x2="250" y2="320" />
          <line x1="150" y1="260" x2="110" y2="170" />
          <line x1="150" y1="250" x2="200" y2="160" />
        </g>
        <g className="frame-garden__leaves" style={{ opacity: leaf }}>
          {canopy(
            [
              [150, 215, 118],
              [66, 300, 80],
              [240, 298, 92],
              [152, 128, 72],
              [100, 372, 58],
              [214, 388, 54],
            ],
            "frame-garden__canopy",
          )}
        </g>
      </g>

      {/* The hedge with its rounded end, and the fence beyond the gap. */}
      <g className="frame-garden__fence">
        <line x1="800" y1="566" x2="1200" y2="566" />
        <line x1="800" y1="616" x2="1200" y2="616" />
        {Array.from({ length: 17 }, (_, index) => 806 + index * 24).map((x) => (
          <rect key={x} x={x} y={540} width={12} height={104} rx={2} />
        ))}
      </g>
      <path
        className="frame-garden__hedge"
        d="M 0 536 C 90 526, 150 530, 240 532 S 420 528, 520 534 S 700 528, 760 536 C 790 540, 800 580, 790 640 L 0 640 Z"
      />

      {/* The lawn, the bird bath and the rotary dryer. */}
      <rect className="frame-garden__lawn" x="0" y="632" width="1200" height="268" />
      <g className="frame-garden__dryer">
        <line x1="600" y1="700" x2="600" y2="340" />
        <line x1="600" y1="340" x2="520" y2="382" />
        <line x1="600" y1="340" x2="680" y2="382" />
        <line x1="600" y1="340" x2="556" y2="370" />
        <line x1="600" y1="340" x2="644" y2="370" />
        <line x1="520" y1="382" x2="680" y2="382" />
        <line x1="548" y1="366" x2="652" y2="366" />
        <line x1="520" y1="382" x2="556" y2="370" />
        <line x1="680" y1="382" x2="644" y2="370" />
      </g>
      <g className="frame-garden__bath">
        <ellipse cx="140" cy="736" rx="32" ry="7" />
        <polygon points="128,734 133,662 147,662 152,734" />
        <path d="M 92 652 Q 140 684 188 652 Z" />
        <ellipse cx="140" cy="651" rx="48" ry="7" />
      </g>

      {/* The big tree on the right, in front of the fence. */}
      <g className="frame-garden__tree frame-garden__tree--east">
        <polygon points="982,728 992,420 1016,420 1032,728" />
        <g className="frame-garden__branches frame-garden__branches--thick">
          <line x1="1004" y1="440" x2="900" y2="290" />
          <line x1="1004" y1="430" x2="1090" y2="270" />
          <line x1="1004" y1="430" x2="1000" y2="200" />
          <line x1="940" y1="350" x2="860" y2="310" />
          <line x1="1070" y1="330" x2="1150" y2="320" />
          <line x1="1000" y1="240" x2="930" y2="130" />
          <line x1="1000" y1="230" x2="1080" y2="120" />
          <line x1="1002" y1="210" x2="1004" y2="60" />
          <line x1="1040" y1="180" x2="1120" y2="170" />
          <line x1="960" y1="170" x2="870" y2="150" />
        </g>
        <g className="frame-garden__leaves" style={{ opacity: leaf }}>
          {canopy(
            [
              [1000, 160, 150],
              [880, 232, 110],
              [1122, 232, 104],
              [938, 332, 94],
              [1086, 334, 100],
              [1002, 76, 92],
              [828, 322, 68],
              [1166, 338, 60],
              [1000, 410, 70],
            ],
            "frame-garden__canopy",
          )}
        </g>
      </g>

      {/* Ferns in the near corner and the rose bush by the fence. */}
      <g className="frame-garden__ferns">
        <path d="M 60 900 C 50 840, 30 810, 14 770 C 40 800, 60 850, 72 900 Z" />
        <path d="M 96 900 C 92 846, 84 800, 96 756 C 110 800, 112 850, 106 900 Z" />
        <path d="M 130 900 C 136 850, 160 806, 192 782 C 170 820, 152 860, 142 900 Z" />
        <path d="M 168 900 C 176 862, 206 834, 236 820 C 210 846, 190 876, 180 900 Z" />
        <path d="M 30 900 C 24 870, 10 850, -4 836 C 12 860, 20 880, 22 900 Z" />
      </g>
      <g className="frame-garden__roses">
        <ellipse cx="1168" cy="862" rx="78" ry="58" />
        <circle className="frame-garden__bloom" cx="1128" cy="834" r="8" />
        <circle className="frame-garden__bloom" cx="1176" cy="818" r="7" />
        <circle className="frame-garden__bloom" cx="1206" cy="850" r="8" />
        <circle className="frame-garden__bloom" cx="1150" cy="872" r="6" />
        <circle className="frame-garden__bloom" cx="1190" cy="884" r="7" />
      </g>
      </g>
    </svg>
  );
});
