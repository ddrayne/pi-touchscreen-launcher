/**
 * Species to archetype: how a bird of this kind looks, where it may sit, and
 * how it moves. BirdNET common names arrive in its own spelling ("Eurasian
 * Blackbird", "Common Wood-Pigeon"), so matching is by exact name first and
 * then by family keywords.
 */

export type AnchorKind =
  | "treetop"
  | "canopy"
  | "trunk"
  | "hedge"
  | "lawn"
  | "ridge"
  | "chimney"
  | "wire"
  | "fence";

export type FlightStyle =
  | "scythe"
  | "glide"
  | "row"
  | "flap"
  | "circle"
  | "bounce"
  | "flit"
  | "dart"
  | "undulate"
  | "cross";

export type IdleStyle = "still" | "hop" | "flit" | "bob" | "turn";

export type SilhouetteId =
  | "aerial"
  | "gull"
  | "corvid"
  | "pigeon"
  | "raptor"
  | "thrush"
  | "tit"
  | "finch"
  | "wren"
  | "robin"
  | "sparrow"
  | "woodpecker"
  | "heron"
  | "duck"
  | "owl"
  | "passerine";

export type ArchetypeId =
  | "aerial"
  | "gull"
  | "corvid"
  | "pigeon"
  | "raptor"
  | "thrush"
  | "tit"
  | "finch"
  | "warbler"
  | "skulker"
  | "robin"
  | "gang"
  | "woodpecker"
  | "flyover"
  | "wader"
  | "night"
  | "default";

export type Archetype = {
  id: ArchetypeId;
  label: string;
  silhouette: SilhouetteId;
  /** Body length relative to a blackbird. */
  scale: number;
  /** Where a perching bird may settle. Empty for birds that never land here. */
  anchors: AnchorKind[];
  flight: FlightStyle;
  idle: IdleStyle;
  /** Vertical band of the sky used in flight, fractions of the painting height. */
  band: [number, number];
  /** Flight speed relative to a thrush. */
  speed: number;
  nightOnly?: boolean;
  /** A raptor overhead freezes everything else for a few seconds. */
  freezesOthers?: boolean;
};

const ARCHETYPES: Record<ArchetypeId, Archetype> = {
  aerial: {
    id: "aerial",
    label: "aerial screamer",
    silhouette: "aerial",
    scale: 0.75,
    anchors: [],
    flight: "scythe",
    idle: "still",
    band: [0.04, 0.22],
    speed: 2.6,
  },
  gull: {
    id: "gull",
    label: "gull",
    silhouette: "gull",
    scale: 1.9,
    anchors: ["ridge", "chimney"],
    flight: "glide",
    idle: "still",
    band: [0.08, 0.3],
    speed: 1.1,
  },
  corvid: {
    id: "corvid",
    label: "corvid",
    silhouette: "corvid",
    scale: 1.7,
    anchors: ["ridge", "chimney", "treetop", "lawn"],
    flight: "row",
    idle: "turn",
    band: [0.14, 0.38],
    speed: 1,
  },
  pigeon: {
    id: "pigeon",
    label: "pigeon",
    silhouette: "pigeon",
    scale: 1.35,
    anchors: ["ridge", "wire", "chimney", "lawn", "fence"],
    flight: "flap",
    idle: "bob",
    band: [0.22, 0.42],
    speed: 1.4,
  },
  raptor: {
    id: "raptor",
    label: "raptor",
    silhouette: "raptor",
    scale: 1.6,
    anchors: [],
    flight: "circle",
    idle: "still",
    band: [0.06, 0.26],
    speed: 0.7,
    freezesOthers: true,
  },
  thrush: {
    id: "thrush",
    label: "thrush",
    silhouette: "thrush",
    scale: 1,
    anchors: ["lawn", "treetop", "hedge", "ridge", "fence"],
    flight: "flap",
    idle: "hop",
    band: [0.3, 0.5],
    speed: 1,
  },
  tit: {
    id: "tit",
    label: "tit",
    silhouette: "tit",
    scale: 0.55,
    anchors: ["canopy", "hedge", "wire", "fence"],
    flight: "flit",
    idle: "flit",
    band: [0.34, 0.56],
    speed: 1.6,
  },
  finch: {
    id: "finch",
    label: "finch",
    silhouette: "finch",
    scale: 0.6,
    anchors: ["canopy", "wire", "treetop", "hedge"],
    flight: "bounce",
    idle: "bob",
    band: [0.3, 0.5],
    speed: 1.4,
  },
  warbler: {
    id: "warbler",
    label: "warbler",
    silhouette: "passerine",
    scale: 0.5,
    anchors: ["canopy", "hedge"],
    flight: "flit",
    idle: "flit",
    band: [0.36, 0.56],
    speed: 1.5,
  },
  skulker: {
    id: "skulker",
    label: "skulker",
    silhouette: "wren",
    scale: 0.45,
    anchors: ["hedge", "lawn", "trunk"],
    flight: "dart",
    idle: "hop",
    band: [0.6, 0.78],
    speed: 1.8,
  },
  robin: {
    id: "robin",
    label: "robin",
    silhouette: "robin",
    scale: 0.6,
    anchors: ["hedge", "lawn", "canopy", "wire", "fence"],
    flight: "flit",
    idle: "bob",
    band: [0.4, 0.6],
    speed: 1.3,
  },
  gang: {
    id: "gang",
    label: "gang",
    silhouette: "sparrow",
    scale: 0.65,
    anchors: ["hedge", "wire", "ridge", "lawn", "fence"],
    flight: "bounce",
    idle: "hop",
    band: [0.3, 0.5],
    speed: 1.4,
  },
  woodpecker: {
    id: "woodpecker",
    label: "woodpecker",
    silhouette: "woodpecker",
    scale: 1,
    anchors: ["trunk", "treetop"],
    flight: "undulate",
    idle: "still",
    band: [0.3, 0.5],
    speed: 1.2,
  },
  flyover: {
    id: "flyover",
    label: "fly-over",
    silhouette: "duck",
    scale: 1.8,
    anchors: [],
    flight: "cross",
    idle: "still",
    band: [0.1, 0.3],
    speed: 1.2,
  },
  wader: {
    id: "wader",
    label: "wader",
    silhouette: "heron",
    scale: 2.4,
    anchors: [],
    flight: "cross",
    idle: "still",
    band: [0.12, 0.3],
    speed: 0.8,
  },
  night: {
    id: "night",
    label: "night",
    silhouette: "owl",
    scale: 1.5,
    anchors: ["treetop", "canopy", "ridge"],
    flight: "glide",
    idle: "turn",
    band: [0.2, 0.4],
    speed: 0.9,
    nightOnly: true,
  },
  default: {
    id: "default",
    label: "bird",
    silhouette: "passerine",
    scale: 0.7,
    anchors: ["canopy", "hedge", "wire", "lawn", "fence"],
    flight: "flap",
    idle: "bob",
    band: [0.3, 0.5],
    speed: 1.2,
  },
};

const EXACT: Record<string, ArchetypeId> = {
  "european robin": "robin",
  "eurasian wren": "skulker",
  wren: "skulker",
  dunnock: "skulker",
  "eurasian treecreeper": "skulker",
  "house sparrow": "gang",
  "eurasian tree sparrow": "gang",
  "common starling": "gang",
  "european starling": "gang",
  "eurasian nuthatch": "woodpecker",
  goldcrest: "warbler",
  firecrest: "warbler",
  "tawny owl": "night",
  "barn owl": "night",
  "long-eared owl": "night",
  "grey heron": "wader",
  "gray heron": "wader",
  "eurasian oystercatcher": "wader",
  "eurasian curlew": "wader",
  "common pheasant": "flyover",
};

const KEYWORDS: Array<[RegExp, ArchetypeId]> = [
  [/\b(swift|swallow|martin)\b/, "aerial"],
  [/\bgull\b|\bkittiwake\b|\btern\b/, "gull"],
  [/\b(crow|rook|jackdaw|magpie|jay|raven|chough)\b/, "corvid"],
  [/\b(pigeon|dove)\b/, "pigeon"],
  [/(hawk|buzzard|kestrel|kite|falcon|osprey|harrier|eagle|hobby|merlin|peregrine)\b/, "raptor"],
  [/\b(thrush|blackbird|redwing|fieldfare|ouzel)\b/, "thrush"],
  [/\btit\b/, "tit"],
  [/(finch|siskin|redpoll|linnet|brambling|crossbill|twite)\b/, "finch"],
  [/\b(warbler|chiffchaff|blackcap|whitethroat)\b/, "warbler"],
  [/\b(redstart|stonechat|wheatear|flycatcher|nightingale)\b/, "robin"],
  [/\b(sparrow|starling)\b/, "gang"],
  [/\b(woodpecker|wryneck)\b/, "woodpecker"],
  [/\b(heron|egret|curlew|oystercatcher|lapwing|sandpiper|redshank|godwit|snipe|plover|bittern)\b/, "wader"],
  [/\b(goose|duck|mallard|swan|teal|wigeon|cormorant|shag|grebe|coot|moorhen)\b/, "flyover"],
  [/\b(owl|nightjar)\b/, "night"],
  [/\b(wagtail|pipit|skylark|bunting|yellowhammer|dipper)\b/, "default"],
];

function normalizeName(name: string): string {
  return name
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function archetypeIdFor(commonName: string): ArchetypeId {
  const name = normalizeName(commonName);
  if (!name) return "default";
  const exact = EXACT[name];
  if (exact) return exact;
  for (const [pattern, id] of KEYWORDS) {
    if (pattern.test(name)) return id;
  }
  return "default";
}

export function archetypeFor(commonName: string): Archetype {
  return ARCHETYPES[archetypeIdFor(commonName)];
}

export function archetype(id: ArchetypeId): Archetype {
  return ARCHETYPES[id];
}

export const ARCHETYPE_IDS = Object.keys(ARCHETYPES) as ArchetypeId[];

/** Bodies are not counts: one call is one bird, forty calls is six. */
export function bodiesFor(calls: number): number {
  if (!Number.isFinite(calls) || calls < 1) return 0;
  return 1 + Math.floor(Math.log2(calls));
}

export const MAX_BODIES = 24;
