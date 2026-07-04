// CONTENT-DERIVED ACCENTS — the core color principle of the user surface.
//
// No single loud brand color painted everywhere. Instead, every episode and
// topic derives its own accent from its content (title hash, or sport), drawn
// from a curated wheel of eight refined hues. Each accent ships in three
// strengths over the near-white canvas:
//   tint  — very soft wash for card backgrounds / cover gradients
//   soft  — chips, progress tracks
//   solid — play buttons, waveform played-portion, links within that card
// The ONE restrained brand color (#3B5BFF) is reserved for global nav + CTAs.

export interface Accent {
  name: string;
  solid: string;
  soft: string;
  tint: string;
  /** darker text-safe variant for on-tint labels */
  deep: string;
}

// Curated, print-like palette — saturated enough to feel alive, never neon.
const WHEEL: Accent[] = [
  { name: "coral",    solid: "#E86A5E", soft: "#F8D9D5", tint: "#FDF1EF", deep: "#9C3B32" },
  { name: "ocean",    solid: "#3E7BD6", soft: "#D5E2F7", tint: "#F0F5FD", deep: "#26518F" },
  { name: "moss",     solid: "#4E9A6B", soft: "#D7EBDE", tint: "#F0F9F3", deep: "#2F6647" },
  { name: "amber",    solid: "#D98E32", soft: "#F6E3C8", tint: "#FCF5EA", deep: "#8F5A1B" },
  { name: "plum",     solid: "#8B64C4", soft: "#E4DAF4", tint: "#F6F2FC", deep: "#5B3E8A" },
  { name: "teal",     solid: "#2E9E9B", soft: "#D2ECEB", tint: "#EFF9F9", deep: "#1D6968" },
  { name: "rose",     solid: "#D15C8F", soft: "#F4D8E5", tint: "#FBF0F5", deep: "#93395F" },
  { name: "slate",    solid: "#5D7490", soft: "#DCE3EB", tint: "#F3F6F9", deep: "#3C4D62" },
];

// Sports get stable, recognizable hues.
const SPORT_MAP: Record<string, number> = {
  basketball: 0,   // coral
  football: 1,     // ocean
  baseball: 2,     // moss
  "combat sports": 3, // amber
  soccer: 5,       // teal
  hockey: 7,       // slate
};

function hash(str: string): number {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
  return h;
}

/** Accent for an episode — stable per title. */
export function accentFor(seed: string): Accent {
  return WHEEL[hash(seed || "take") % WHEEL.length];
}

/** Accent for a topic — sport-anchored when known, hashed otherwise. */
export function accentForSport(sport: string | null | undefined, fallbackSeed: string): Accent {
  const key = (sport || "").trim().toLowerCase();
  if (key in SPORT_MAP) return WHEEL[SPORT_MAP[key]];
  return accentFor(fallbackSeed);
}

/** Soft cover gradient for items without artwork. */
export function coverGradient(a: Accent): string {
  return `linear-gradient(135deg, ${a.soft} 0%, ${a.tint} 55%, #ffffff 100%)`;
}

export const ALL_ACCENTS = WHEEL;
