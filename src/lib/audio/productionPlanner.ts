// Episode-aware production planning: generates a ProductionPlan (cue sheet)
// from the script's own per-line signal BEFORE anything is rendered.
//
// This replaces the legacy global-knob placement (fixed tone→SFX mapping +
// deterministic stinger rotation) with weighted selection over the whole
// asset library, shaped by:
//   - the episode's emotional arc (smoothed energy curve, peak detection)
//   - segment structure (cold opens, topic turns vs in-topic beats)
//   - delivery metadata (interruptions, pauses, speaker turns)
//   - a cross-episode cooldown snapshot (anti-repetition — the same stinger
//     or bed cannot recur within the cooldown window, and every asset has a
//     per-episode max-use budget)
//
// Silence is a first-class cue: when the planner considers a strong beat and
// deliberately holds back (cue fatigue, a low-energy stretch that should
// breathe), it emits an explicit "silence" cue with the reason — so the cue
// sheet documents restraint, not just placements.
//
// Pure and deterministic: same inputs (script content, style, density,
// asset catalog, cooldown snapshot) → byte-identical plan. The PRNG seed is
// derived from episodeId+scriptId, never wall-clock time.

import type { ProductionStyle, SfxDensity } from "./soundDesignShared";
import {
  PRODUCTION_PLANNER_VERSION,
  ProductionCue,
  ProductionPlan,
  SOUND_DESIGN_PLANNER_ENV,
} from "./productionPlan";

// ---------------------------------------------------------------------------
// Feature flag
// ---------------------------------------------------------------------------

/** Planner-driven rendering is opt-in: exactly "true" enables it. Anything
 *  else (unset, "1", "yes") keeps the legacy renderer — prod stays put. */
export function isSoundDesignPlannerEnabled(
  env: Record<string, string | undefined> = process.env
): boolean {
  return (env[SOUND_DESIGN_PLANNER_ENV] || "").trim() === "true";
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export interface PlannerLine {
  lineIndex: number;
  segmentIndex: number;
  /** Script segment type: "cold_open" | "intro" | "topic" | "transition" | ... */
  segmentType: string;
  /** Break OPENED by this line (same semantics as the stitcher computes). */
  breakKind: "none" | "segment" | "topic";
  speakerName?: string;
  tone?: string;
  energy?: string;
  pauseBefore?: string;
  isInterruption?: boolean;
  /** Character count of the spoken text — drives duration estimates. */
  textLength: number;
}

export interface PlannerAsset {
  id: string;
  name: string;
  kind: string; // "theme_intro" | "theme_outro" | "stinger" | "bed" | "sfx"
  category: string | null;
  durationMs?: number;
}

/** Cross-episode usage history, most recent episode first. */
export interface CooldownSnapshot {
  episodes: Array<{ episodeId: string; assetIds: string[] }>;
}

export const EMPTY_COOLDOWN: CooldownSnapshot = { episodes: [] };

export interface PlannerConfig {
  /** Stinger/bed assets used within the last N episodes are OFF the table. */
  cooldownEpisodes: number;
  /** Reaction SFX cooldown is soft (weight penalty), over this window. */
  sfxCooldownEpisodes: number;
  maxStingerUsesPerEpisode: number;
  maxSfxUsesPerEpisode: number;
}

export const DEFAULT_PLANNER_CONFIG: PlannerConfig = {
  cooldownEpisodes: 2,
  sfxCooldownEpisodes: 1,
  maxStingerUsesPerEpisode: 1,
  maxSfxUsesPerEpisode: 2,
};

/** Config with env overrides (SOUND_DESIGN_COOLDOWN_EPISODES etc.). */
export function resolvePlannerConfig(
  env: Record<string, string | undefined> = process.env
): PlannerConfig {
  const num = (name: string, fallback: number) => {
    const v = Number(env[name]);
    return Number.isFinite(v) && v >= 0 ? v : fallback;
  };
  return {
    cooldownEpisodes: num("SOUND_DESIGN_COOLDOWN_EPISODES", DEFAULT_PLANNER_CONFIG.cooldownEpisodes),
    sfxCooldownEpisodes: num("SOUND_DESIGN_SFX_COOLDOWN_EPISODES", DEFAULT_PLANNER_CONFIG.sfxCooldownEpisodes),
    maxStingerUsesPerEpisode: num("SOUND_DESIGN_MAX_STINGER_USES", DEFAULT_PLANNER_CONFIG.maxStingerUsesPerEpisode),
    maxSfxUsesPerEpisode: num("SOUND_DESIGN_MAX_SFX_USES", DEFAULT_PLANNER_CONFIG.maxSfxUsesPerEpisode),
  };
}

export interface PlannerInput {
  episodeId: string;
  scriptId: string;
  style: ProductionStyle;
  sfxDensity: SfxDensity;
  lines: PlannerLine[];
  assets: PlannerAsset[];
  cooldown?: CooldownSnapshot;
  config?: PlannerConfig;
  /** Theme selection mirrors the stitcher's config + include gates. */
  includeIntro?: boolean;
  includeOutro?: boolean;
  introAssetId?: string | null;
  outroAssetId?: string | null;
  /** env-URL fallback clips (no asset row) — plan records them as assetId null. */
  envIntroFallback?: boolean;
  envOutroFallback?: boolean;
  /** Operator-placed rights-cleared highlights (pass-through). */
  highlights?: Array<{ lineIndex: number; assetId: string }>;
}

// ---------------------------------------------------------------------------
// Deterministic building blocks
// ---------------------------------------------------------------------------

// Same mulberry32 the timeline planner and legacy SFX planner use.
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a over a string → 32-bit planner seed. */
export function plannerSeed(episodeId: string, scriptId: string): number {
  const s = `${episodeId}:${scriptId}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

interface Weighted<T> {
  item: T;
  weight: number;
}

function weightedPick<T>(rand: () => number, candidates: Array<Weighted<T>>): T | null {
  const usable = candidates.filter((c) => c.weight > 0);
  const total = usable.reduce((a, c) => a + c.weight, 0);
  if (total <= 0) return null;
  let roll = rand() * total;
  for (const c of usable) {
    roll -= c.weight;
    if (roll <= 0) return c.item;
  }
  return usable[usable.length - 1].item;
}

/** Rough per-line speech duration from text length — used ONLY for spacing
 *  decisions inside the plan; the renderer resolves real clip times. */
export function estimateLineDurationMs(textLength: number): number {
  return Math.min(14_000, Math.max(1_200, 250 + textLength * 55));
}

// ---------------------------------------------------------------------------
// Script signal extraction
// ---------------------------------------------------------------------------

const TONE_ENERGY_BOOST: Record<string, number> = {
  heated: 0.6,
  excited: 0.6,
  incredulous: 0.4,
  amused: 0.3,
  sarcastic: 0.2,
  dismissive: 0.2,
  analytical: -0.3,
  measured: -0.4,
  somber: -0.6,
};

function rawEnergyScore(line: PlannerLine): number {
  const base = line.energy === "high" ? 1.75 : line.energy === "low" ? 0.35 : 1.0;
  const boost = TONE_ENERGY_BOOST[(line.tone || "").toLowerCase()] ?? 0;
  return Math.max(0, base + boost);
}

export interface EpisodeArc {
  raw: number[];
  smoothed: number[];
  mean: number;
  /** Index into `lines` of local maxima that rise above the episode mean. */
  peaks: Set<number>;
}

/** Smooth the per-line energy into an arc and mark its peaks — the beats the
 *  whole episode builds toward, where a cue earns its place. */
export function computeEpisodeArc(lines: PlannerLine[]): EpisodeArc {
  const raw = lines.map(rawEnergyScore);
  const kernel = [1, 2, 3, 2, 1];
  const smoothed = raw.map((_, i) => {
    let sum = 0;
    let wsum = 0;
    for (let k = -2; k <= 2; k++) {
      const j = i + k;
      if (j < 0 || j >= raw.length) continue;
      const w = kernel[k + 2];
      sum += raw[j] * w;
      wsum += w;
    }
    return wsum > 0 ? sum / wsum : 0;
  });
  const mean = smoothed.length ? smoothed.reduce((a, b) => a + b, 0) / smoothed.length : 0;
  const peaks = new Set<number>();
  for (let i = 0; i < smoothed.length; i++) {
    const isLocalMax =
      (i === 0 || smoothed[i] >= smoothed[i - 1]) &&
      (i === smoothed.length - 1 || smoothed[i] >= smoothed[i + 1]);
    if (isLocalMax && smoothed[i] > mean * 1.1) peaks.add(i);
  }
  return { raw, smoothed, mean, peaks };
}

/** Raw script-content line shape (Script.content JSON). */
export interface RawScriptLine {
  lineIndex: number;
  speakerName?: string;
  text?: string;
  tone?: string;
  energy?: string;
  pauseBefore?: string;
  isInterruption?: boolean;
}

/** Flatten script content segments into planner lines (same break semantics
 *  as the stitcher: the line that OPENS a new segment carries the break, and
 *  the NEW segment's type decides topic vs segment). */
export function plannerLinesFromScriptContent(
  segments: Array<{ type?: string; lines?: RawScriptLine[] }>
): PlannerLine[] {
  const out: PlannerLine[] = [];
  for (let s = 0; s < segments.length; s++) {
    const seg = segments[s];
    const segLines = Array.isArray(seg.lines) ? seg.lines : [];
    for (let l = 0; l < segLines.length; l++) {
      const line = segLines[l];
      const opensSegment = l === 0 && out.length > 0;
      out.push({
        lineIndex: line.lineIndex,
        segmentIndex: s,
        segmentType: seg.type || "topic",
        breakKind: opensSegment ? (seg.type === "topic" ? "topic" : "segment") : "none",
        speakerName: line.speakerName,
        tone: line.tone,
        energy: line.energy,
        pauseBefore: line.pauseBefore,
        isInterruption: line.isInterruption === true,
        textLength: typeof line.text === "string" ? line.text.length : 0,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Reaction beat vocabulary (weighted, not one-to-one)
// ---------------------------------------------------------------------------

interface BeatProfile {
  /** Candidate categories with preference weights — the planner picks among
   *  ALL of them (cooldown- and usage-shaped), not first-available. */
  categories: Array<{ category: string; weight: number; hypeOnly?: boolean; minDensity?: SfxDensity }>;
  score: number;
  reason: string;
}

function beatForLine(line: PlannerLine): BeatProfile | null {
  const t = (line.tone || "").toLowerCase();
  const high = line.energy === "high";
  if (t === "amused") {
    return {
      categories: [
        { category: "laugh", weight: 1.0 },
        { category: "rimshot", weight: 0.6 },
      ],
      score: high ? 1.6 : 1.2,
      reason: "amused beat",
    };
  }
  if (t === "sarcastic" && high) {
    return {
      categories: [
        { category: "rimshot", weight: 1.0 },
        { category: "laugh", weight: 0.4 },
      ],
      score: 1.4,
      reason: "sarcastic jab",
    };
  }
  if ((t === "heated" || t === "excited") && high) {
    return {
      categories: [
        { category: "crowd", weight: 1.0 },
        { category: "impact", weight: 0.75 },
        { category: "airhorn", weight: 0.9, hypeOnly: true },
      ],
      score: 1.9,
      reason: `${t} peak`,
    };
  }
  if (t === "incredulous" && high) {
    return {
      categories: [
        { category: "crowd", weight: 0.9 },
        { category: "impact", weight: 0.7 },
      ],
      score: 1.6,
      reason: "disbelief beat",
    };
  }
  if (t === "dismissive" && high) {
    return {
      categories: [
        { category: "buzzer", weight: 1.0, minDensity: "medium" },
        { category: "rimshot", weight: 0.65 },
      ],
      score: 1.4,
      reason: "dismissal",
    };
  }
  return null;
}

interface DensityShape {
  minSpacingMs: number;
  /** Multiplier on the silence option — restraint knob. */
  silenceBias: number;
  gainDb: number;
  allowHype: boolean;
}

const DENSITY_SHAPES: Record<SfxDensity, DensityShape> = {
  subtle: { minSpacingMs: 45_000, silenceBias: 1.5, gainDb: -15, allowHype: false },
  medium: { minSpacingMs: 25_000, silenceBias: 1.0, gainDb: -13, allowHype: false },
  hype: { minSpacingMs: 12_000, silenceBias: 0.5, gainDb: -11, allowHype: true },
};

const DENSITY_RANK: Record<SfxDensity, number> = { subtle: 0, medium: 1, hype: 2 };

// ---------------------------------------------------------------------------
// The planner
// ---------------------------------------------------------------------------

/** Sentinel picked by weightedPick when the planner chooses restraint. */
const SILENCE = { silence: true } as const;

export function generateProductionPlan(input: PlannerInput): ProductionPlan {
  const config = input.config ?? DEFAULT_PLANNER_CONFIG;
  const cooldown = input.cooldown ?? EMPTY_COOLDOWN;
  const density = DENSITY_SHAPES[input.sfxDensity];
  const seed = plannerSeed(input.episodeId, input.scriptId);
  const rand = mulberry32(seed);
  const cues: ProductionCue[] = [];
  let cooldownSuppressions = 0;

  const lines = input.lines;
  const arc = computeEpisodeArc(lines);

  // Estimated line start/end times — spacing decisions only.
  const estStart: number[] = [];
  const estEnd: number[] = [];
  {
    let cursor = 0;
    for (let i = 0; i < lines.length; i++) {
      const gap = i === 0 ? 0 : lines[i].breakKind !== "none" ? 1500 : 400;
      const dur = estimateLineDurationMs(lines[i].textLength);
      estStart.push(cursor + gap);
      estEnd.push(cursor + gap + dur);
      cursor = estEnd[i];
    }
  }

  /** How many episodes ago an asset last ran; Infinity = never seen. */
  const episodesAgo = (assetId: string): number => {
    for (let i = 0; i < cooldown.episodes.length; i++) {
      if (cooldown.episodes[i].assetIds.includes(assetId)) return i + 1;
    }
    return Infinity;
  };

  const usesThisEpisode = new Map<string, number>();
  const bumpUse = (assetId: string) =>
    usesThisEpisode.set(assetId, (usesThisEpisode.get(assetId) ?? 0) + 1);

  const stingers = input.assets.filter((a) => a.kind === "stinger");
  const beds = input.assets.filter((a) => a.kind === "bed");
  const sfxByCategory = new Map<string, PlannerAsset[]>();
  for (const a of input.assets) {
    if (a.kind !== "sfx" || !a.category) continue;
    const pool = sfxByCategory.get(a.category) || [];
    pool.push(a);
    sfxByCategory.set(a.category, pool);
  }

  const firstLineIndex = lines.length > 0 ? lines[0].lineIndex : 0;
  const lastLineIndex = lines.length > 0 ? lines[lines.length - 1].lineIndex : 0;
  const hasColdOpen = lines.length > 0 && lines[0].segmentType === "cold_open";

  // --- Intro / outro themes (config-driven; the plan records the choice) ---
  if (input.includeIntro) {
    const asset = input.introAssetId ? input.assets.find((a) => a.id === input.introAssetId) : null;
    if (asset || input.envIntroFallback) {
      cues.push({
        type: "intro",
        lineIndex: firstLineIndex,
        assetId: asset?.id ?? null,
        assetName: asset?.name ?? "env intro clip",
        category: null,
        timing: "before",
        gainDb: -2,
        fadeInMs: 20,
        fadeOutMs: 900,
        reason: hasColdOpen ? "show open (after cold open script beat)" : "show open",
      });
    }
  }
  if (input.includeOutro) {
    const asset = input.outroAssetId ? input.assets.find((a) => a.id === input.outroAssetId) : null;
    if (asset || input.envOutroFallback) {
      cues.push({
        type: "outro",
        lineIndex: lastLineIndex,
        assetId: asset?.id ?? null,
        assetName: asset?.name ?? "env outro clip",
        category: null,
        timing: "after",
        gainDb: -2,
        fadeInMs: 900,
        fadeOutMs: 400,
        reason: "show close",
      });
    }
  }

  // Least-recently-used freshness weight: never-heard assets outrank ones
  // heard N episodes ago, which outrank anything just past the window. This
  // is what makes cooldown SUBSTITUTE (rotate the pool) instead of starve.
  const lruWeight = (assetId: string): number => {
    const ago = episodesAgo(assetId);
    return ago === Infinity ? 1.5 : 0.4 + 0.12 * Math.min(ago, 8);
  };

  // --- Music bed (full style): cooldown-aware choice, or a deliberate no ---
  if (input.style === "full" && lines.length > 0) {
    const freshBeds = beds.filter((b) => episodesAgo(b.id) > config.cooldownEpisodes);
    cooldownSuppressions += beds.length - freshBeds.length;
    if (freshBeds.length === 0) {
      // TRUE pool exhaustion: every bed in the library genuinely ran within
      // the window. Only then may cooldown silence the bed slot.
      if (beds.length > 0) {
        cues.push({
          type: "silence",
          lineIndex: firstLineIndex,
          assetId: null,
          assetName: null,
          category: null,
          timing: "under",
          gainDb: 0,
          fadeInMs: 0,
          fadeOutMs: 0,
          reason: `bed pool exhausted — all ${beds.length} bed(s) ran within the last ${config.cooldownEpisodes} episodes`,
        });
      }
    } else {
      // Two-stage decision: WHETHER to bed the episode is pool-size
      // independent (a 5-bed library must not make beds 5× likelier); WHICH
      // bed is a least-recently-used pick over the fresh pool.
      const lowEnergyEpisode = arc.mean < 0.85;
      const wantsBed = weightedPick<"bed" | typeof SILENCE>(rand, [
        { item: "bed", weight: lowEnergyEpisode ? 1.0 : 1.4 },
        // A measured, low-energy episode may deliberately skip the bed —
        // music wallpaper under a sober conversation is exactly what we avoid.
        { item: SILENCE, weight: lowEnergyEpisode ? 0.55 : 0.1 },
      ]);
      const picked =
        wantsBed === "bed"
          ? weightedPick(
              rand,
              freshBeds.map((b) => ({ item: b, weight: lruWeight(b.id) }))
            )
          : SILENCE;
      if (picked && picked !== SILENCE) {
        const bed = picked as PlannerAsset;
        bumpUse(bed.id);
        cues.push({
          type: "bed_change",
          lineIndex: firstLineIndex,
          assetId: bed.id,
          assetName: bed.name,
          category: null,
          timing: "under",
          gainDb: 0, // bed level is governed by the duck mix, not per-clip gain
          fadeInMs: 1500,
          fadeOutMs: 2500,
          reason: lowEnergyEpisode
            ? `bed '${bed.name}' kept despite a measured episode`
            : `bed '${bed.name}' under the episode (arc mean ${arc.mean.toFixed(2)})`,
        });
      } else if (picked === SILENCE) {
        cues.push({
          type: "silence",
          lineIndex: firstLineIndex,
          assetId: null,
          assetName: null,
          category: null,
          timing: "under",
          gainDb: 0,
          fadeInMs: 0,
          fadeOutMs: 0,
          reason: "no bed — measured episode, let the room tone carry it",
        });
      }
    }
  }

  // --- Boundary cues: weighted stinger-or-silence at every break ---
  const boundaries = lines
    .map((l, i) => ({ line: l, idx: i }))
    .filter(({ line }) =>
      input.style === "light" ? line.breakKind === "topic" : line.breakKind !== "none"
    )
    .filter(() => input.style !== "clean");

  // Mean smoothed energy per segment — "what are we transitioning INTO?"
  const segmentEnergy = new Map<number, number>();
  for (let i = 0; i < lines.length; i++) {
    const s = lines[i].segmentIndex;
    const acc = segmentEnergy.get(s);
    segmentEnergy.set(s, acc === undefined ? arc.smoothed[i] : (acc + arc.smoothed[i]) / 2);
  }

  let prevBoundaryGotStinger = false;
  for (const { line } of boundaries) {
    const segEnergy = segmentEnergy.get(line.segmentIndex) ?? 1;
    const eligible = stingers.filter(
      (s) => (usesThisEpisode.get(s.id) ?? 0) < config.maxStingerUsesPerEpisode
    );
    // Cooldown steers, it does not starve: within-window assets are excluded
    // only because the LRU pick below substitutes an unused-or-older one.
    const fresh = eligible.filter((s) => episodesAgo(s.id) > config.cooldownEpisodes);
    cooldownSuppressions += eligible.length - fresh.length;

    // Restraint silences (pacing, arc) are deliberate production choices and
    // always stay on the table. Forced silences exist only for the genuine
    // dead-ends, each with its own explicit reason.
    let silenceWeight = 0.4;
    let silenceReason = "boundary held silent — natural pause carries the turn";
    if (prevBoundaryGotStinger) {
      silenceWeight += 0.45;
      silenceReason = "boundary held silent — back-to-back stingers would wear thin";
    }
    if (segEnergy < 0.9) {
      silenceWeight += 0.35;
      silenceReason = "low-energy segment ahead — let it breathe";
    }
    if (stingers.length === 0) {
      silenceWeight = 1;
      silenceReason = "no stinger assets available";
    } else if (eligible.length === 0) {
      silenceWeight = 1;
      silenceReason = "stinger budget spent — every stinger already used this episode";
    } else if (fresh.length === 0) {
      silenceWeight = 1;
      silenceReason = `stinger pool exhausted — all ${eligible.length} eligible stinger(s) ran within the last ${config.cooldownEpisodes} episodes`;
    }

    // Two-stage decision: WHETHER this boundary gets a stinger is pool-size
    // independent (deep libraries must not fire more often than shallow
    // ones); WHICH stinger is a least-recently-used pick over fresh assets.
    const slotWeight =
      fresh.length === 0
        ? 0
        : 2.5 *
          (line.breakKind === "topic" ? 1.0 : 0.65) *
          (0.6 + 0.4 * Math.min(segEnergy / 1.2, 1.5));
    const wantsStinger = weightedPick<"stinger" | typeof SILENCE>(rand, [
      { item: "stinger", weight: slotWeight },
      { item: SILENCE, weight: silenceWeight },
    ]);
    const picked =
      wantsStinger === "stinger"
        ? weightedPick(
            rand,
            fresh.map((s) => ({ item: s, weight: lruWeight(s.id) }))
          )
        : SILENCE;
    if (picked && picked !== SILENCE) {
      const asset = picked as PlannerAsset;
      bumpUse(asset.id);
      prevBoundaryGotStinger = true;
      cues.push({
        type: "stinger",
        lineIndex: line.lineIndex,
        assetId: asset.id,
        assetName: asset.name,
        category: null,
        timing: "before",
        gainDb: -8,
        fadeInMs: 15,
        fadeOutMs: 90,
        reason: `${line.breakKind} turn into ${
          segEnergy >= 1.1 ? "a high-energy" : segEnergy < 0.9 ? "a measured" : "the next"
        } segment`,
      });
    } else {
      prevBoundaryGotStinger = false;
      cues.push({
        type: "silence",
        lineIndex: line.lineIndex,
        assetId: null,
        assetName: null,
        category: null,
        timing: "gap",
        gainDb: 0,
        fadeInMs: 0,
        fadeOutMs: 0,
        reason: silenceReason,
      });
    }
  }

  // --- Reaction cues on emotional beats (full style only) ---
  if (input.style === "full") {
    let lastReactionEndMs = -Infinity;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Never on the episode's opening line — unless the script opens cold,
      // where a button on the cold-open punchline is the whole point.
      if (i === 0 && !hasColdOpen) continue;

      const beat = beatForLine(line);
      if (!beat) continue;

      const sinceLast = estEnd[i] - lastReactionEndMs;
      if (sinceLast < density.minSpacingMs) continue;

      const isPeak = arc.peaks.has(i);
      const followedByInterruption = i + 1 < lines.length && lines[i + 1].isInterruption === true;

      // Stage-2 candidates: every pickable asset per usable category. The
      // soft cooldown keeps recently-used reactions possible (pools can be
      // one-deep) but heavily down-weighted; only HARD exclusions
      // (stinger/bed) count as cooldownSuppressions.
      const assetCandidates: Array<Weighted<{ asset: PlannerAsset; category: string }>> = [];
      let fireWeight = 0; // pool-size independent: sums CATEGORY weights, not assets
      for (const cat of beat.categories) {
        if (cat.hypeOnly && !density.allowHype) continue;
        if (cat.minDensity && DENSITY_RANK[input.sfxDensity] < DENSITY_RANK[cat.minDensity]) continue;
        const pool = (sfxByCategory.get(cat.category) || []).filter(
          (a) => (usesThisEpisode.get(a.id) ?? 0) < config.maxSfxUsesPerEpisode
        );
        if (pool.length === 0) continue;
        fireWeight += cat.weight * (isPeak ? 1.5 : 1) * (followedByInterruption ? 1.2 : 1);
        for (const asset of pool) {
          const ago = episodesAgo(asset.id);
          const coolPenalty = ago <= config.sfxCooldownEpisodes ? 0.25 : 1;
          assetCandidates.push({
            item: { asset, category: cat.category },
            weight:
              cat.weight * coolPenalty * (1 / (1 + (usesThisEpisode.get(asset.id) ?? 0))),
          });
        }
      }

      // Local cue load over the trailing ~60 estimated seconds.
      const windowStart = estEnd[i] - 60_000;
      const recentLoad = cues.filter(
        (c) =>
          (c.type === "reaction" || c.type === "stinger") &&
          estStartOfCue(c) >= windowStart
      ).length;
      const silenceWeight =
        assetCandidates.length === 0
          ? 1
          : density.silenceBias * (0.45 + 0.35 * recentLoad) * (isPeak ? 0.55 : 1);

      const wantsReaction = weightedPick<"reaction" | typeof SILENCE>(rand, [
        { item: "reaction", weight: assetCandidates.length === 0 ? 0 : fireWeight },
        { item: SILENCE, weight: silenceWeight },
      ]);
      const picked = wantsReaction === "reaction" ? weightedPick(rand, assetCandidates) : SILENCE;
      if (picked && picked !== SILENCE) {
        const { asset, category } = picked as { asset: PlannerAsset; category: string };
        bumpUse(asset.id);
        lastReactionEndMs = estEnd[i];
        cues.push({
          type: "reaction",
          lineIndex: line.lineIndex,
          assetId: asset.id,
          assetName: asset.name,
          category,
          timing: "after",
          gainDb: density.gainDb,
          fadeInMs: 25,
          fadeOutMs: 150,
          reason:
            beat.reason +
            (isPeak ? " at an arc peak" : "") +
            (followedByInterruption ? ", rides into an interruption" : ""),
        });
      } else if (beat.score >= 1.6) {
        // A strong beat deliberately held silent is worth documenting.
        lastReactionEndMs = estEnd[i]; // restraint also resets pacing
        cues.push({
          type: "silence",
          lineIndex: line.lineIndex,
          assetId: null,
          assetName: null,
          category: null,
          timing: "after",
          gainDb: 0,
          fadeInMs: 0,
          fadeOutMs: 0,
          reason: `strong ${beat.reason} held back — ${
            recentLoad > 0 ? "recent cues need air" : "restraint beats wallpaper"
          }`,
        });
      }
    }
  }

  // Estimated start of an already-placed cue (for load windows).
  function estStartOfCue(c: ProductionCue): number {
    const i = lines.findIndex((l) => l.lineIndex === c.lineIndex);
    return i === -1 ? -Infinity : estStart[i];
  }

  // --- Operator-placed highlight slots (rights-gated upstream) ---
  for (const hl of input.highlights ?? []) {
    cues.push({
      type: "highlight_slot",
      lineIndex: hl.lineIndex,
      assetId: hl.assetId,
      assetName: null,
      category: null,
      timing: "gap",
      gainDb: -2,
      fadeInMs: 120,
      fadeOutMs: 250,
      reason: "operator-placed cleared game highlight",
    });
  }

  // Stable order: by line, then a fixed type order for same-line cues.
  const typeOrder: Record<string, number> = {
    intro: 0,
    bed_change: 1,
    stinger: 2,
    silence: 3,
    reaction: 4,
    highlight_slot: 5,
    outro: 6,
  };
  cues.sort((a, b) => a.lineIndex - b.lineIndex || typeOrder[a.type] - typeOrder[b.type]);

  const assetIdsUsed = new Set(
    cues.filter((c) => c.assetId && c.type !== "highlight_slot").map((c) => c.assetId as string)
  );

  return {
    version: 1,
    plannerVersion: PRODUCTION_PLANNER_VERSION,
    episodeId: input.episodeId,
    scriptId: input.scriptId,
    style: input.style,
    sfxDensity: input.sfxDensity,
    seed,
    cues,
    stats: {
      lineCount: lines.length,
      boundaryCount: boundaries.length,
      stingerCues: cues.filter((c) => c.type === "stinger").length,
      reactionCues: cues.filter((c) => c.type === "reaction").length,
      silenceCues: cues.filter((c) => c.type === "silence").length,
      distinctAssetsUsed: assetIdsUsed.size,
      cooldownSuppressions,
    },
  };
}

/** Asset IDs a rendered plan consumed — what the cooldown store records.
 *  Intro/outro themes are the show's fixed identity and are exempt. */
export function planAssetUsage(
  plan: ProductionPlan
): Array<{ assetId: string; assetName: string | null; cueType: string }> {
  return plan.cues
    .filter(
      (c) =>
        c.assetId !== null &&
        (c.type === "stinger" || c.type === "bed_change" || c.type === "reaction")
    )
    .map((c) => ({ assetId: c.assetId as string, assetName: c.assetName, cueType: c.type }));
}
