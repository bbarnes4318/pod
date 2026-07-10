// Metadata-aware asset selection vocabulary for the production planner.
//
// The planner used to choose assets by kind + cooldown rotation only. This
// module reads the structured metadata the Epidemic crate already carries and
// turns it into a typed selector input so the planner can choose by MUSICAL
// FIT (mood, energy family, intensity, BPM, genre appropriateness) as well.
//
// Where the metadata actually lives (verified against the ingested crate):
//   - energy:<family> and bpm:<n> tags exist ONLY on the 20 beds.
//   - Stingers / intros / outros / SFX carry sparse tags (riser/stinger/
//     transition, musical/intro/theme, sport/crowd); their descriptive and
//     GENRE words (Cartoon, Retro, Epic Build, Eerie, Victory, Fanfare) live in
//     the asset NAME — the Epidemic title, already stored, not a new layer.
// So parsing reads BOTH tags and name. No migration, no invented fields.
//
// Client-safe: no Node imports (shared by the pure planner and admin code).

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export const ENERGY_FAMILIES = [
  "urgent/driving",
  "dark/tense",
  "neutral",
  "upbeat",
  "cinematic",
] as const;
export type EnergyFamily = (typeof ENERGY_FAMILIES)[number];

export interface GenreFlags {
  cartoon: boolean;
  retro: boolean; // retro / 8-bit / chiptune / arcade
  horror: boolean;
  comedic: boolean;
  children: boolean;
  orchestral: boolean;
  arena: boolean; // stadium / crowd / sport
  broadcast: boolean; // logo / ident / news / bumper
  triumphant: boolean; // victory / fanfare / success / achievement
}

export interface AssetMetadataInput {
  name: string;
  kind: string;
  category: string | null;
  tags: string[];
}

export interface AssetMetadata {
  energyFamily: EnergyFamily | null;
  bpm: number | null;
  moodWords: string[];
  hasVocals: boolean;
  genre: GenreFlags;
  /** 1–10, derived; see deriveIntensity(). */
  intensity: number;
  /** Fields we could NOT derive from the asset's own data (audit). */
  missing: string[];
}

// ---------------------------------------------------------------------------
// Word lists (matched case-insensitively against name + tags)
// ---------------------------------------------------------------------------

const HIGH_MOOD = [
  "epic", "intense", "aggressive", "angry", "action", "chase", "chasing", "restless",
  "euphoric", "hype", "build", "charge", "high energy", "driving", "urgent", "power", "heavy",
];
const CALM_MOOD = [
  "calm", "laid back", "ambient", "dreamy", "sentimental", "somber", "hopeful",
  "downtempo", "gentle", "measured", "mellow", "sneaking", "laid-back",
];

const GENRE_WORDS: Record<keyof GenreFlags, string[]> = {
  cartoon: ["cartoon", "goofy", "comical", "toon"],
  retro: ["retro", "8-bit", "8 bit", "chiptune", "arcade"],
  horror: ["horror", "creepy", "eerie", "scary", "supernatural", "crime scene", "fear", "dread"],
  comedic: ["comedy", "comical", "goofy", "joke", "funny", "silly"],
  children: ["children", "kids", "nursery", "toy", "childlike"],
  orchestral: ["orchestra", "orchestral", "horns", "fanfare", "strings", "trumpet", "brass"],
  arena: ["arena", "stadium", "crowd", "sport", "football", "field", "game start"],
  broadcast: ["broadcast", "news", "logo", "ident", "brand", "bumper", "signature"],
  triumphant: ["victory", "fanfare", "success", "achievement", "triumph", "positive", "win", "champion"],
};

// SFX-category / stinger character → base intensity when no energy: tag exists.
const KIND_CHARACTER_INTENSITY: Array<{ re: RegExp; intensity: number }> = [
  { re: /impact|boom|big hit|slam|ultra/i, intensity: 8 },
  { re: /air ?horn|buzzer|alarm/i, intensity: 7 },
  { re: /riser|build|epic|charge/i, intensity: 7 },
  { re: /fanfare|orchestral|horns|trumpet|victory/i, intensity: 6 },
  { re: /crowd|cheer|applause|laugh/i, intensity: 5 },
  { re: /rimshot|snare|drum/i, intensity: 5 },
  { re: /whoosh|swish|swoosh|transition|flyby/i, intensity: 4 },
];

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function haystack(a: AssetMetadataInput): string {
  return (a.name + " " + a.tags.join(" ")).toLowerCase();
}

function normalizeFamily(raw: string): EnergyFamily | null {
  const v = raw.toLowerCase().trim();
  if (v.startsWith("urgent") || v.startsWith("driving")) return "urgent/driving";
  if (v.startsWith("dark") || v.startsWith("tense")) return "dark/tense";
  if (v.startsWith("neutral") || v.startsWith("underscore")) return "neutral";
  if (v.startsWith("upbeat") || v.startsWith("happy")) return "upbeat";
  if (v.startsWith("cinematic") || v.startsWith("epic")) return "cinematic";
  return null;
}

const STRUCTURAL_TAGS = new Set([
  "intro", "outro", "theme", "stinger", "transition", "bed", "sfx", "seed",
  "no vocals", "vocal presence", "instrumental", "loop", "sample", "misc",
]);

export function detectGenre(a: AssetMetadataInput): GenreFlags {
  const h = haystack(a);
  const flags = {} as GenreFlags;
  for (const key of Object.keys(GENRE_WORDS) as (keyof GenreFlags)[]) {
    flags[key] = GENRE_WORDS[key].some((w) => h.includes(w));
  }
  // Sport/crowd category SFX are arena by role even if the word isn't present.
  if (a.category === "crowd" || a.category === "airhorn") flags.arena = true;
  return flags;
}

/** Intensity 1–10. FORMULA (reported in the completion gate):
 *    base   = energyFamily base { urgent/driving:8, cinematic:7, upbeat:6, dark/tense:5, neutral:3 }
 *             or, when no energy family, the kind/character base (impact 8 … whoosh 4)
 *    bpmAdj = bpm≥135:+1.5 | 120–134:+0.75 | 100–119:0 | 86–99:−0.75 | ≤85:−1.5 | null:0
 *    moodAdj= (+1 per HIGH mood word, capped +2) + (−1 per CALM mood word, capped −2)
 *    intensity = clamp(round(base + bpmAdj + moodAdj), 1, 10)
 */
export function deriveIntensity(
  energyFamily: EnergyFamily | null,
  bpm: number | null,
  h: string
): number {
  let base: number;
  if (energyFamily) {
    base = { "urgent/driving": 8, cinematic: 7, upbeat: 6, "dark/tense": 5, neutral: 3 }[energyFamily];
  } else {
    base = 5;
    for (const c of KIND_CHARACTER_INTENSITY) if (c.re.test(h)) { base = c.intensity; break; }
  }
  let bpmAdj = 0;
  if (bpm != null) {
    if (bpm >= 135) bpmAdj = 1.5;
    else if (bpm >= 120) bpmAdj = 0.75;
    else if (bpm >= 100) bpmAdj = 0;
    else if (bpm >= 86) bpmAdj = -0.75;
    else bpmAdj = -1.5;
  }
  const highHits = Math.min(2, HIGH_MOOD.filter((w) => h.includes(w)).length);
  const calmHits = Math.min(2, CALM_MOOD.filter((w) => h.includes(w)).length);
  const moodAdj = highHits - calmHits;
  return Math.max(1, Math.min(10, Math.round(base + bpmAdj + moodAdj)));
}

export function parseAssetMetadata(a: AssetMetadataInput): AssetMetadata {
  const missing: string[] = [];
  let energyFamily: EnergyFamily | null = null;
  let bpm: number | null = null;
  const moodWords: string[] = [];
  let hasVocals = false;

  for (const raw of a.tags) {
    const t = raw.toLowerCase().trim();
    if (t.startsWith("energy:")) energyFamily = normalizeFamily(t.slice("energy:".length));
    else if (t.startsWith("bpm:")) {
      const n = parseInt(t.slice("bpm:".length), 10);
      if (Number.isFinite(n)) bpm = n;
    } else if (t === "vocal presence") hasVocals = true;
    else if (t === "no vocals" || t === "instrumental") hasVocals = false;
    else if (!STRUCTURAL_TAGS.has(t)) moodWords.push(t);
  }

  // Fold real descriptor words out of the ES title into moodWords (the name is
  // where non-bed assets keep their character), skipping generic filler.
  for (const word of a.name.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/)) {
    if (word.length < 3) continue;
    if (STRUCTURAL_TAGS.has(word) || ["musical", "designed", "short", "long", "version", "the"].includes(word)) continue;
    if (!moodWords.includes(word)) moodWords.push(word);
  }

  const h = haystack(a);
  // Non-bed designed assets are instrumental by nature; only beds get vocals.
  if (a.kind !== "bed") hasVocals = false;

  if (energyFamily == null && a.kind === "bed") missing.push("energyFamily");
  if (bpm == null && a.kind === "bed") missing.push("bpm");

  const genre = detectGenre(a);
  const intensity = deriveIntensity(energyFamily, bpm, h);

  return { energyFamily, bpm, moodWords, hasVocals, genre, intensity, missing };
}

// ---------------------------------------------------------------------------
// Hard-rule predicates
// ---------------------------------------------------------------------------

/** A bed with vocal presence fights the hosts — never pick as a bed. */
export function isVocalBed(meta: AssetMetadata): boolean {
  return meta.hasVocals;
}

/** Intro/outro genre gate: bookends must read as broadcast / arena /
 *  triumphant-orchestral, never cartoon / comedic / retro-8bit / horror /
 *  children. Returns { ok, reason }. */
export function themeGenreOk(meta: AssetMetadata): { ok: boolean; reason: string } {
  const g = meta.genre;
  if (g.cartoon) return { ok: false, reason: "cartoon" };
  if (g.comedic) return { ok: false, reason: "comedic" };
  if (g.retro) return { ok: false, reason: "retro/8-bit" };
  if (g.horror) return { ok: false, reason: "horror" };
  if (g.children) return { ok: false, reason: "children's" };
  return { ok: true, reason: g.triumphant ? "triumphant" : g.arena ? "arena" : g.broadcast ? "broadcast" : g.orchestral ? "orchestral" : "neutral" };
}

// ---------------------------------------------------------------------------
// Segment / episode targets (Step 2 consumes the arc; this maps to a target)
// ---------------------------------------------------------------------------

export type DominantTone = "heated" | "amused" | "analytical" | "somber" | "hype";

export interface MomentTarget {
  energyFamily: EnergyFamily;
  /** 1–10. */
  intensity: number;
  tone: DominantTone;
  /** Preferred bpm band for pacing: "fast" | "mid" | "slow". */
  pace: "fast" | "mid" | "slow";
}

/** Tone → target energy family + pace. The taste layer: a heated debate peak
 *  wants urgent/driving, an injury beat wants dark/tense, a punchline upbeat. */
export function targetForTone(tone: DominantTone, intensity: number): MomentTarget {
  switch (tone) {
    case "hype":
    case "heated":
      return { energyFamily: "urgent/driving", intensity, tone, pace: "fast" };
    case "amused":
      return { energyFamily: "upbeat", intensity, tone, pace: "mid" };
    case "somber":
      return { energyFamily: "dark/tense", intensity, tone, pace: "slow" };
    case "analytical":
    default:
      return { energyFamily: "neutral", intensity, tone, pace: intensity >= 6 ? "mid" : "slow" };
  }
}

// ---------------------------------------------------------------------------
// Fit scoring (Step 3). Weights (reported in the completion gate) sum to 1.0:
//   energyFamily 0.35 | intensity 0.25 | mood 0.15 | bpm 0.10 | genre 0.10 | freshness 0.05
// ---------------------------------------------------------------------------

export const FIT_WEIGHTS = {
  energyFamily: 0.35,
  intensity: 0.25,
  mood: 0.15,
  bpm: 0.1,
  genre: 0.1,
  freshness: 0.05,
} as const;

// Energy-family affinity: 1 exact, 0.5 adjacent, 0.3 same-arousal diff-valence,
// 0 opposite. neutral sits mildly close to everything.
const FAMILY_AFFINITY: Record<EnergyFamily, Record<EnergyFamily, number>> = {
  "urgent/driving": { "urgent/driving": 1, cinematic: 0.6, upbeat: 0.5, "dark/tense": 0.3, neutral: 0.4 },
  cinematic: { cinematic: 1, "urgent/driving": 0.6, "dark/tense": 0.6, upbeat: 0.4, neutral: 0.4 },
  "dark/tense": { "dark/tense": 1, cinematic: 0.6, neutral: 0.4, "urgent/driving": 0.3, upbeat: 0 },
  upbeat: { upbeat: 1, "urgent/driving": 0.5, cinematic: 0.4, neutral: 0.4, "dark/tense": 0 },
  neutral: { neutral: 1, upbeat: 0.5, "urgent/driving": 0.4, cinematic: 0.4, "dark/tense": 0.4 },
};

function familyFit(target: EnergyFamily, asset: EnergyFamily | null): number {
  if (asset == null) return 0.45; // unknown family (non-bed) → mild neutral fit
  return FAMILY_AFFINITY[target][asset];
}

function bpmFit(pace: "fast" | "mid" | "slow", bpm: number | null): number {
  if (bpm == null) return 0.5; // no bpm → neutral, never a penalty
  if (pace === "fast") return bpm >= 125 ? 1 : bpm >= 105 ? 0.7 : bpm >= 90 ? 0.4 : 0.15;
  if (pace === "slow") return bpm <= 90 ? 1 : bpm <= 110 ? 0.7 : bpm <= 125 ? 0.4 : 0.15;
  return bpm >= 95 && bpm <= 130 ? 1 : 0.6; // mid
}

const TONE_MOODS: Record<DominantTone, string[]> = {
  heated: ["restless", "action", "aggressive", "intense", "angry", "chase", "epic", "driving", "power", "heavy", "dark"],
  hype: ["euphoric", "epic", "hype", "action", "charge", "high energy", "build", "arena", "crowd"],
  amused: ["happy", "bright", "cheerful", "quirky", "eccentric", "playful", "positive", "laugh"],
  analytical: ["corporate", "clean", "neutral", "laid", "ambient", "measured", "downtempo", "hopeful"],
  somber: ["dark", "suspense", "sentimental", "mysterious", "somber", "tense", "sneaking", "melancholy"],
};

function moodFit(tone: DominantTone, moodWords: string[]): number {
  const wanted = TONE_MOODS[tone];
  if (moodWords.length === 0) return 0.4;
  const hits = moodWords.filter((m) => wanted.some((w) => m.includes(w) || w.includes(m))).length;
  return Math.min(1, 0.3 + hits * 0.35);
}

export interface FitBreakdown {
  fit: number;
  family: number;
  intensity: number;
  mood: number;
  bpm: number;
  genre: number;
  freshness: number;
}

/** Score an asset's musical fit to a moment target. freshness ∈ [0,1]:
 *  1 = never used recently, decaying toward 0 for recent use (cooldown nudge). */
export function scoreFit(meta: AssetMetadata, target: MomentTarget, freshness: number, slot: "bed" | "stinger" | "reaction" | "theme"): FitBreakdown {
  const family = familyFit(target.energyFamily, meta.energyFamily);
  const intensity = 1 - Math.abs(meta.intensity - target.intensity) / 9;
  const mood = moodFit(target.tone, meta.moodWords);
  const bpm = bpmFit(target.pace, meta.bpm);
  // Genre term: penalize a swelling riser on a punchline; reward arena/triumphant on hype.
  let genre = 0.6;
  if (slot === "theme") {
    genre = meta.genre.triumphant || meta.genre.arena || meta.genre.broadcast ? 1 : meta.genre.orchestral ? 0.7 : 0.4;
  } else if (target.tone === "amused" && /riser|build|swell/.test(meta.moodWords.join(" "))) {
    genre = 0.2; // a punchline must not get a swelling riser
  } else if ((target.tone === "heated" || target.tone === "hype") && (meta.genre.arena || /impact|boom|hit/.test(meta.moodWords.join(" ")))) {
    genre = 1;
  }
  const fit =
    FIT_WEIGHTS.energyFamily * family +
    FIT_WEIGHTS.intensity * Math.max(0, intensity) +
    FIT_WEIGHTS.mood * mood +
    FIT_WEIGHTS.bpm * bpm +
    FIT_WEIGHTS.genre * genre +
    FIT_WEIGHTS.freshness * freshness;
  return { fit, family, intensity: Math.max(0, intensity), mood, bpm, genre, freshness };
}
