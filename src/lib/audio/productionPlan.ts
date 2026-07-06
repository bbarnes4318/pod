// Client-safe ProductionPlan vocabulary: the per-episode cue sheet the
// planner emits and the renderer executes. Persisted on the stitch JobLog
// (output.productionPlan) so every render carries its own explainable,
// reproducible cue sheet. No Node imports here — this module may ship to
// admin UIs, exactly like soundDesignShared.ts.

import type { ProductionStyle, SfxDensity } from "./soundDesignShared";

export const PRODUCTION_PLANNER_VERSION = "1.0.0";

/** Feature flag: planner-driven rendering. Default OFF — the legacy
 *  rotation-based placement path runs unless this is exactly "true". */
export const SOUND_DESIGN_PLANNER_ENV = "SOUND_DESIGN_PLANNER";

export const CUE_TYPES = [
  "intro",
  "outro",
  "stinger",
  "bed_change",
  "reaction",
  "silence",
  "highlight_slot",
] as const;
export type CueType = (typeof CUE_TYPES)[number];

/** Where the cue sits relative to its target line:
 *  - "before": ends just before the line starts (stingers, intro theme)
 *  - "under":  runs underneath from the line onward (music bed)
 *  - "after":  lands on the line's tail / right after it (reactions, outro)
 *  - "gap":    occupies the break after the line (highlight inserts, held silence) */
export type CueTiming = "before" | "under" | "after" | "gap";

export interface ProductionCue {
  type: CueType;
  /** The script line this cue is anchored to. */
  lineIndex: number;
  /** Resolved asset. null for silence cues and env-URL intro/outro clips. */
  assetId: string | null;
  assetName: string | null;
  /** SFX category for reaction cues; null otherwise. */
  category: string | null;
  timing: CueTiming;
  gainDb: number;
  fadeInMs: number;
  fadeOutMs: number;
  /** One line of why the planner made this call — the explainability layer. */
  reason: string;
}

export interface ProductionPlanStats {
  lineCount: number;
  boundaryCount: number;
  stingerCues: number;
  reactionCues: number;
  silenceCues: number;
  distinctAssetsUsed: number;
  /** Times a candidate asset was excluded because a recent episode used it. */
  cooldownSuppressions: number;
}

/** The per-episode cue sheet. Reproducible: same script content + style +
 *  density + cooldown snapshot always yields the same plan (seed is derived
 *  from episodeId+scriptId, never from wall-clock time). */
export interface ProductionPlan {
  version: 1;
  plannerVersion: string;
  episodeId: string;
  scriptId: string;
  style: ProductionStyle;
  sfxDensity: SfxDensity;
  seed: number;
  cues: ProductionCue[];
  stats: ProductionPlanStats;
}

export function isCueType(v: unknown): v is CueType {
  return typeof v === "string" && (CUE_TYPES as readonly string[]).includes(v);
}

/** Tolerant parse of a persisted plan (JobLog JSON round-trip). Returns null
 *  rather than throwing — a malformed stored plan must never sink a page. */
export function parseProductionPlan(raw: unknown): ProductionPlan | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (o.version !== 1 || typeof o.episodeId !== "string" || typeof o.scriptId !== "string") return null;
  if (!Array.isArray(o.cues)) return null;
  const cues: ProductionCue[] = [];
  for (const c of o.cues) {
    if (!c || typeof c !== "object") return null;
    const cue = c as Record<string, unknown>;
    if (!isCueType(cue.type) || !Number.isInteger(cue.lineIndex)) return null;
    cues.push({
      type: cue.type,
      lineIndex: cue.lineIndex as number,
      assetId: typeof cue.assetId === "string" ? cue.assetId : null,
      assetName: typeof cue.assetName === "string" ? cue.assetName : null,
      category: typeof cue.category === "string" ? cue.category : null,
      timing: cue.timing === "before" || cue.timing === "under" || cue.timing === "gap" ? cue.timing : "after",
      gainDb: typeof cue.gainDb === "number" ? cue.gainDb : 0,
      fadeInMs: typeof cue.fadeInMs === "number" ? cue.fadeInMs : 0,
      fadeOutMs: typeof cue.fadeOutMs === "number" ? cue.fadeOutMs : 0,
      reason: typeof cue.reason === "string" ? cue.reason : "",
    });
  }
  return {
    version: 1,
    plannerVersion: typeof o.plannerVersion === "string" ? o.plannerVersion : "unknown",
    episodeId: o.episodeId,
    scriptId: o.scriptId,
    style: (o.style as ProductionStyle) ?? "full",
    sfxDensity: (o.sfxDensity as SfxDensity) ?? "subtle",
    seed: typeof o.seed === "number" ? o.seed : 0,
    cues,
    stats: (o.stats as ProductionPlanStats) ?? {
      lineCount: 0,
      boundaryCount: 0,
      stingerCues: 0,
      reactionCues: 0,
      silenceCues: 0,
      distinctAssetsUsed: 0,
      cooldownSuppressions: 0,
    },
  };
}
