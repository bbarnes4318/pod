// Post-TTS plan execution (PR 3, Part 15). PURE (produces clips + a validation
// report; the stitcher runs FFmpeg). Turns a PostTtsSoundDirectionPlan into
// placed, fitted render clips (intro/outro/cues) + a bed directive, and asserts
// the plan is safe to render.
//
// A clip may carry a SOURCE EXCERPT window (sourceStartMs/sourceEndMs) when cue
// fitting excerpted or time-stretched the asset — the stitcher trims/stretches
// the source before placing it. Every clip references only frozen-profile,
// actually-loaded assets; before returning, executeDirectedPlan validates
// bounds, protected-speech collisions, fades, gains, and required bookends.

import type { TimelineClip } from "@/lib/audio/assembly";
import { fitCue, resolveCueFitConfig, type CueFitConfig } from "@/lib/audio/cueFitting";
import { cueCollidesWithProtected, type ProtectedAudioRegion } from "@/lib/audio/protectedRegions";
import type { PostTtsSoundDirectionPlan, DirectedBookendSegment } from "@/lib/audio/postTtsSoundDirector";

const GAIN_MIN = -24, GAIN_MAX = 6, FADE_MAX = 10_000;

export interface LoadedAssetLite { assetId: string; filePath: string; durationMs: number }

/** A placed clip plus the source-trim window the stitcher must apply first. */
export interface DirectedRenderClip extends TimelineClip {
  assetId: string;
  sourceStartMs: number;   // 0 unless excerpted
  sourceEndMs: number;     // = source duration unless excerpted
  stretchPercent: number;  // 0 unless time-stretched
  fitStrategy: string;
}

export interface DirectedBedDirective {
  assetId: string; filePath: string;
  segments: Array<{ startMs: number; endMs: number; boundary: string }>;
  baseGainDb: number; duckedGainDb: number; duckAttackMs: number; duckReleaseMs: number;
  fadeInMs: number; fadeOutMs: number; loopCrossfadeMs: number;
}

export interface DirectedExecution {
  /** Intro treatment rendered as one or more gain-segments (e.g. cold_open_ducked
   *  = full lead + ducked under-speech). Empty when there is no intro. */
  introClips: DirectedRenderClip[];
  /** Outro treatment rendered as gain-segments (e.g. rise_under_final = ducked
   *  under the final sentence + full tail). Empty when there is no outro. */
  outroClips: DirectedRenderClip[];
  cueClips: DirectedRenderClip[];
  bed: DirectedBedDirective | null;
  dialogueStartMs: number;
  fittings: Array<{ assetId: string; kind: string; strategy: string; audibleMs: number; stretchPercent: number; excerpted: boolean; reason: string }>;
  skippedCues: Array<{ assetId: string; lineIndex: number; reason: string }>;
  validation: { ok: boolean; errors: string[] };
}

export interface ExecuteDirectedOptions {
  /** Asset ids permitted by the frozen profile (bookends + pools). Any clip
   *  referencing an id outside this set is a hard validation failure. */
  frozenAssetIds: Set<string>;
  protectedRegions: ProtectedAudioRegion[];
  cueFitConfig?: CueFitConfig;
  musicGainDb?: number;
}

const clampFade = (v: number) => Math.max(0, Math.min(FADE_MAX, Math.round(v)));

export function executeDirectedPlan(
  plan: PostTtsSoundDirectionPlan,
  loaded: Map<string, LoadedAssetLite>,
  opts: ExecuteDirectedOptions
): DirectedExecution {
  const cfg = opts.cueFitConfig ?? resolveCueFitConfig();
  const errors: string[] = [];
  const fittings: DirectedExecution["fittings"] = [];
  const skippedCues: DirectedExecution["skippedCues"] = [];

  const asset = (id: string | null | undefined): LoadedAssetLite | null => (id ? loaded.get(id) ?? null : null);
  const frozen = (id: string) => opts.frozenAssetIds.has(id);

  // Turn a bookend treatment's gain-SEGMENTS into render clips (each an excerpt
  // of the SAME frozen asset at its directed timeline position + gain). A segment
  // whose source window exceeds the loaded asset is clamped and flagged.
  const buildBookendClips = (assetId: string, segs: DirectedBookendSegment[], a: LoadedAssetLite, label: string): DirectedRenderClip[] => {
    const out: DirectedRenderClip[] = [];
    for (const s of segs) {
      const srcStart = Math.max(0, s.sourceStartMs);
      const srcEnd = Math.min(a.durationMs, s.sourceEndMs);
      if (srcEnd - srcStart < 1) { errors.push(`${label} segment ${s.role} has an empty/out-of-range source window (${s.sourceStartMs}-${s.sourceEndMs} of ${a.durationMs}ms)`); continue; }
      out.push({
        assetId, filePath: a.filePath, startMs: Math.max(0, Math.round(s.timelineStartMs)), durationMs: Math.round(srcEnd - srcStart),
        kind: "music", pan: 0, fadeInMs: clampFade(s.fadeInMs), fadeOutMs: clampFade(s.fadeOutMs), gainDb: s.gainDb,
        sourceStartMs: srcStart, sourceEndMs: srcEnd, stretchPercent: 0, fitStrategy: s.role,
      });
    }
    return out;
  };

  // --- Intro ---------------------------------------------------------------
  let introClips: DirectedRenderClip[] = [];
  let dialogueStartMs = 0;
  const intro = plan.bookendPlan.intro;
  if (intro && intro.assetId && intro.treatment !== "none") {
    const a = asset(intro.assetId);
    if (!frozen(intro.assetId)) errors.push(`intro asset ${intro.assetId} is not in the frozen profile`);
    else if (!a) errors.push(`intro asset ${intro.assetId} was not loaded`);
    else {
      introClips = buildBookendClips(intro.assetId, intro.segments, a, "intro");
      dialogueStartMs = Math.max(0, intro.speechEntryMs);
    }
  } else if (intro && intro.required && intro.treatment === "none") {
    errors.push("required intro has no usable treatment");
  }

  // --- Cues (transitions + reactions) --------------------------------------
  const cueClips: DirectedRenderClip[] = [];
  for (const c of plan.cuePlacements) {
    if (!frozen(c.assetId)) { errors.push(`cue asset ${c.assetId} is not in the frozen profile`); continue; }
    const a = asset(c.assetId);
    if (!a) { skippedCues.push({ assetId: c.assetId, lineIndex: c.lineIndex, reason: "not loaded" }); continue; }
    const fit = fitCue(a.durationMs, c.gapDurationMs, cfg);
    fittings.push({ assetId: c.assetId, kind: c.kind, strategy: fit.strategy, audibleMs: fit.audibleMs, stretchPercent: fit.stretchPercent, excerpted: fit.sourceEndMs < a.durationMs, reason: fit.reason });
    if (!fit.ok) { skippedCues.push({ assetId: c.assetId, lineIndex: c.lineIndex, reason: fit.reason }); continue; }
    const startMs = c.targetStartMs;
    const endMs = startMs + fit.audibleMs;
    // Hard cue must not cover protected speech (defense in depth after the director).
    if (cueCollidesWithProtected(opts.protectedRegions, startMs, endMs, "hard")) {
      skippedCues.push({ assetId: c.assetId, lineIndex: c.lineIndex, reason: "protected-speech collision at execution" });
      continue;
    }
    cueClips.push({
      assetId: c.assetId, filePath: a.filePath, startMs, durationMs: fit.audibleMs, kind: "sfx", pan: 0,
      fadeInMs: clampFade(fit.fadeInMs), fadeOutMs: clampFade(fit.fadeOutMs), gainDb: c.gainDb,
      sourceStartMs: fit.sourceStartMs, sourceEndMs: fit.sourceEndMs, stretchPercent: fit.stretchPercent, fitStrategy: fit.strategy,
    });
  }

  // --- Outro ---------------------------------------------------------------
  let outroClips: DirectedRenderClip[] = [];
  const outro = plan.bookendPlan.outro;
  if (outro && outro.assetId && outro.treatment !== "none") {
    const a = asset(outro.assetId);
    if (!frozen(outro.assetId)) errors.push(`outro asset ${outro.assetId} is not in the frozen profile`);
    else if (!a) errors.push(`outro asset ${outro.assetId} was not loaded`);
    else {
      outroClips = buildBookendClips(outro.assetId, outro.segments, a, "outro");
    }
  } else if (outro && outro.required && outro.treatment === "none") {
    errors.push("required outro has no usable treatment");
  }

  // --- Bed -----------------------------------------------------------------
  let bed: DirectedBedDirective | null = null;
  if (plan.bedPlan) {
    const a = asset(plan.bedPlan.assetId);
    if (!frozen(plan.bedPlan.assetId)) errors.push(`bed asset ${plan.bedPlan.assetId} is not in the frozen profile`);
    else if (!a) errors.push(`bed asset ${plan.bedPlan.assetId} was not loaded`);
    else bed = {
      assetId: plan.bedPlan.assetId, filePath: a.filePath, segments: plan.bedPlan.segments.map((s) => ({ startMs: s.startMs, endMs: s.endMs, boundary: s.boundary })),
      baseGainDb: plan.bedPlan.baseGainDb, duckedGainDb: plan.bedPlan.duckedGainDb, duckAttackMs: plan.bedPlan.duckAttackMs, duckReleaseMs: plan.bedPlan.duckReleaseMs,
      fadeInMs: plan.bedPlan.fadeInMs, fadeOutMs: plan.bedPlan.fadeOutMs, loopCrossfadeMs: plan.bedPlan.loopCrossfadeMs,
    };
  }

  // --- Validation (Part 15) ------------------------------------------------
  const all: DirectedRenderClip[] = [...introClips, ...cueClips, ...outroClips];
  for (const c of all) {
    if (!(c.startMs >= 0) || !(c.durationMs > 0)) errors.push(`clip ${c.assetId} has invalid bounds (${c.startMs}/${c.durationMs})`);
    if (c.gainDb < GAIN_MIN || c.gainDb > GAIN_MAX) errors.push(`clip ${c.assetId} gain ${c.gainDb} out of bounds`);
    if (c.fadeInMs < 0 || c.fadeInMs > FADE_MAX || c.fadeOutMs < 0 || c.fadeOutMs > FADE_MAX) errors.push(`clip ${c.assetId} fades out of bounds`);
    if (c.sourceEndMs < c.sourceStartMs) errors.push(`clip ${c.assetId} negative source window`);
  }
  // A bookend segment may cover a HARD-protected region ONLY when it is ducked
  // (role "under_speech"). Any UNDUCKED bookend audio over hard-protected speech
  // is a hard failure (the first/last meaningful words must stay intelligible).
  const introDuckedRoles = new Set((intro?.segments ?? []).filter((s) => s.ducked).map((s) => s.role));
  const outroDuckedRoles = new Set((outro?.segments ?? []).filter((s) => s.ducked).map((s) => s.role));
  const checkUnducked = (clips: DirectedRenderClip[], duckedRoles: Set<string>, label: string) => {
    for (const c of clips) {
      if (duckedRoles.has(c.fitStrategy)) continue; // ducked segment: allowed under hard speech
      if (cueCollidesWithProtected(opts.protectedRegions, c.startMs, c.startMs + c.durationMs, "hard")) {
        errors.push(`${label} segment ${c.fitStrategy} plays UNDUCKED over hard-protected speech (${c.startMs}-${c.startMs + c.durationMs}ms)`);
      }
    }
  };
  checkUnducked(introClips, introDuckedRoles, "intro");
  checkUnducked(outroClips, outroDuckedRoles, "outro");

  // Required bookends must remain represented by at least one clip.
  if (intro?.required && introClips.length === 0) errors.push("required intro is not represented in the render clips");
  if (outro?.required && outroClips.length === 0) errors.push("required outro is not represented in the render clips");

  return { introClips, outroClips, cueClips, bed, dialogueStartMs, fittings, skippedCues, validation: { ok: errors.length === 0, errors } };
}
