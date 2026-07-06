// ProductionPlan execution: turns a planned cue sheet into TimelineClips on
// an already-planned dialogue timeline. The renderer stops inventing
// placements — every music/SFX clip it mixes traces back to a cue with a
// reason. Pure: no DB, no ffmpeg; shared by the production stitcher and the
// local variety harness so both render a plan the exact same way.
//
// Timing conventions match the legacy renderer so a plan cue sounds
// identical to the placement it replaced:
//   stinger  ("before"): ends 150ms before its line starts
//   reaction ("after"):  lands 350ms before its line's tail ends
//   intro    ("before"): starts at 0; dialogue begins under its fade tail
//   outro    ("after"):  starts half a crossfade before the dialogue ends
//   bed      ("under"):  selected here, mixed by mixBedUnderForeground()

import type { PlannedLine, TimelineClip } from "./assembly";
import type { LoadedAsset } from "./soundDesign";
import { shiftTimelineForInsert } from "./soundDesign";
import type { ProductionCue, ProductionPlan } from "./productionPlan";

export interface ResolvedTheme {
  filePath: string;
  durationMs: number;
}

/** Resolve the plan's intro cue into a timeline clip + where dialogue starts.
 *  Must run BEFORE the dialogue timeline is planned (it sets the offset). */
export function resolveIntroFromPlan(opts: {
  plan: ProductionPlan;
  assetsById: Map<string, LoadedAsset>;
  /** Standardized env-URL intro clip, for cues with assetId null. */
  envIntro?: ResolvedTheme | null;
  musicCrossfadeMs: number;
  warnings: string[];
}): { introClip: TimelineClip | null; dialogueStartMs: number } {
  const cue = opts.plan.cues.find((c) => c.type === "intro");
  if (!cue) return { introClip: null, dialogueStartMs: 0 };
  const theme: ResolvedTheme | null = cue.assetId
    ? (opts.assetsById.get(cue.assetId) ?? null)
    : (opts.envIntro ?? null);
  if (!theme) {
    opts.warnings.push(`Plan intro cue skipped: asset '${cue.assetName ?? cue.assetId}' unavailable.`);
    return { introClip: null, dialogueStartMs: 0 };
  }
  return {
    introClip: {
      filePath: theme.filePath,
      startMs: 0,
      durationMs: theme.durationMs,
      kind: "music",
      pan: 0,
      fadeInMs: cue.fadeInMs,
      fadeOutMs: opts.musicCrossfadeMs,
      gainDb: cue.gainDb,
    },
    dialogueStartMs: Math.max(0, theme.durationMs - opts.musicCrossfadeMs),
  };
}

/** Durations of the stinger assets the plan actually cues — the stitcher
 *  widens break gaps to fit the longest one, exactly like the legacy path. */
export function plannedStingerDurations(
  plan: ProductionPlan,
  assetsById: Map<string, LoadedAsset>
): number[] {
  const out: number[] = [];
  for (const cue of plan.cues) {
    if (cue.type !== "stinger" || !cue.assetId) continue;
    const asset = assetsById.get(cue.assetId);
    if (asset) out.push(asset.durationMs);
  }
  return out;
}

export interface PlanTimelineResult {
  highlightClips: TimelineClip[];
  stingerClips: TimelineClip[];
  reactionClips: TimelineClip[];
  outroClip: TimelineClip | null;
  /** Bed chosen by the plan's bed_change cue; null = no bed this episode. */
  bedAsset: LoadedAsset | null;
  reactionSummary: Array<{ lineIndex: number; asset: string; reason: string; atMs: number }>;
  highlightSummary: Array<{ lineIndex: number; asset: string }>;
  stingerSummary: Array<{ lineIndex: number; asset: string; reason: string; atMs: number }>;
  /** Silence cues pass through for the job log — restraint is part of the mix. */
  silenceSummary: Array<{ lineIndex: number; reason: string }>;
}

/**
 * Execute every post-timeline cue. `dialogueClips` must be parallel to
 * `plannedLines` (same order); highlight inserts shift it in place, exactly
 * like the legacy renderer.
 */
export function executePlanOnTimeline(opts: {
  plan: ProductionPlan;
  plannedLines: PlannedLine[];
  dialogueClips: TimelineClip[];
  assetsById: Map<string, LoadedAsset>;
  /** Standardized env-URL outro clip, for cues with assetId null. */
  envOutro?: ResolvedTheme | null;
  musicCrossfadeMs: number;
  dialogueStartMs: number;
  warnings: string[];
}): PlanTimelineResult {
  const { plan, plannedLines, dialogueClips, assetsById, warnings } = opts;
  const posByLineIndex = new Map<number, number>();
  plannedLines.forEach((l, i) => posByLineIndex.set(l.lineIndex, i));

  const result: PlanTimelineResult = {
    highlightClips: [],
    stingerClips: [],
    reactionClips: [],
    outroClip: null,
    bedAsset: null,
    reactionSummary: [],
    highlightSummary: [],
    stingerSummary: [],
    silenceSummary: [],
  };

  const clipForLine = (cue: ProductionCue): TimelineClip | null => {
    const pos = posByLineIndex.get(cue.lineIndex);
    if (pos === undefined) {
      warnings.push(`Plan ${cue.type} cue at line ${cue.lineIndex} skipped: line not on the timeline.`);
      return null;
    }
    return dialogueClips[pos];
  };

  const assetFor = (cue: ProductionCue): LoadedAsset | null => {
    const asset = cue.assetId ? assetsById.get(cue.assetId) : undefined;
    if (!asset) {
      warnings.push(
        `Plan ${cue.type} cue at line ${cue.lineIndex} skipped: asset '${cue.assetName ?? cue.assetId}' unavailable.`
      );
      return null;
    }
    return asset;
  };

  // Highlights first — they shift the timeline, so everything else must be
  // placed against the post-shift clip positions (same order as legacy).
  const highlightCues = plan.cues
    .filter((c) => c.type === "highlight_slot")
    .sort((a, b) => a.lineIndex - b.lineIndex);
  for (const cue of highlightCues) {
    const lineClip = clipForLine(cue);
    const asset = lineClip ? assetFor(cue) : null;
    if (!lineClip || !asset) continue;
    const afterEndMs = lineClip.startMs + lineClip.durationMs;
    const atMs = shiftTimelineForInsert(
      [...dialogueClips, ...result.highlightClips],
      afterEndMs,
      asset.durationMs
    );
    result.highlightClips.push({
      filePath: asset.filePath,
      startMs: atMs,
      durationMs: asset.durationMs,
      kind: "music",
      pan: 0,
      fadeInMs: cue.fadeInMs,
      fadeOutMs: cue.fadeOutMs,
      gainDb: cue.gainDb,
    });
    result.highlightSummary.push({ lineIndex: cue.lineIndex, asset: asset.name });
  }

  for (const cue of plan.cues) {
    switch (cue.type) {
      case "stinger": {
        const lineClip = clipForLine(cue);
        const asset = lineClip ? assetFor(cue) : null;
        if (!lineClip || !asset) break;
        const atMs = Math.max(0, lineClip.startMs - asset.durationMs - 150);
        result.stingerClips.push({
          filePath: asset.filePath,
          startMs: atMs,
          durationMs: asset.durationMs,
          kind: "sfx",
          pan: 0,
          fadeInMs: cue.fadeInMs,
          fadeOutMs: cue.fadeOutMs,
          gainDb: cue.gainDb,
        });
        result.stingerSummary.push({ lineIndex: cue.lineIndex, asset: asset.name, reason: cue.reason, atMs });
        break;
      }
      case "reaction": {
        const lineClip = clipForLine(cue);
        const asset = lineClip ? assetFor(cue) : null;
        if (!lineClip || !asset) break;
        const lineEndMs = lineClip.startMs + lineClip.durationMs;
        const atMs = Math.max(lineClip.startMs, lineEndMs - 350);
        result.reactionClips.push({
          filePath: asset.filePath,
          startMs: atMs,
          durationMs: asset.durationMs,
          kind: "sfx",
          pan: 0,
          fadeInMs: cue.fadeInMs,
          fadeOutMs: cue.fadeOutMs,
          gainDb: cue.gainDb,
        });
        result.reactionSummary.push({ lineIndex: cue.lineIndex, asset: asset.name, reason: cue.reason, atMs });
        break;
      }
      case "bed_change": {
        const asset = assetFor(cue);
        if (asset) result.bedAsset = asset;
        break;
      }
      case "silence": {
        result.silenceSummary.push({ lineIndex: cue.lineIndex, reason: cue.reason });
        break;
      }
      default:
        break; // intro handled pre-timeline; outro below; highlights above
    }
  }

  const outroCue = plan.cues.find((c) => c.type === "outro");
  if (outroCue) {
    const theme: ResolvedTheme | null = outroCue.assetId
      ? (assetsById.get(outroCue.assetId) ?? null)
      : (opts.envOutro ?? null);
    if (!theme) {
      warnings.push(`Plan outro cue skipped: asset '${outroCue.assetName ?? outroCue.assetId}' unavailable.`);
    } else {
      const dialogueEndMs = dialogueClips.length
        ? Math.max(...[...dialogueClips, ...result.highlightClips].map((c) => c.startMs + c.durationMs))
        : opts.dialogueStartMs;
      result.outroClip = {
        filePath: theme.filePath,
        startMs: Math.max(0, dialogueEndMs - Math.round(opts.musicCrossfadeMs / 2)),
        durationMs: theme.durationMs,
        kind: "music",
        pan: 0,
        fadeInMs: opts.musicCrossfadeMs,
        fadeOutMs: outroCue.fadeOutMs,
        gainDb: outroCue.gainDb,
      };
    }
  }

  return result;
}
