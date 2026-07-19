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
import type { PostTtsSoundDirectionPlan } from "@/lib/audio/postTtsSoundDirector";

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
  introClip: DirectedRenderClip | null;
  outroClip: DirectedRenderClip | null;
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
  const musicGain = opts.musicGainDb ?? -2;
  const errors: string[] = [];
  const fittings: DirectedExecution["fittings"] = [];
  const skippedCues: DirectedExecution["skippedCues"] = [];

  const asset = (id: string | null | undefined): LoadedAssetLite | null => (id ? loaded.get(id) ?? null : null);
  const frozen = (id: string) => opts.frozenAssetIds.has(id);

  // --- Intro ---------------------------------------------------------------
  let introClip: DirectedRenderClip | null = null;
  let dialogueStartMs = 0;
  const intro = plan.bookendPlan.intro;
  if (intro && intro.assetId && intro.treatment !== "none") {
    const a = asset(intro.assetId);
    if (!frozen(intro.assetId)) errors.push(`intro asset ${intro.assetId} is not in the frozen profile`);
    else if (!a) errors.push(`intro asset ${intro.assetId} was not loaded`);
    else {
      introClip = {
        assetId: intro.assetId, filePath: a.filePath, startMs: Math.max(0, intro.introStartMs), durationMs: a.durationMs,
        kind: "music", pan: 0, fadeInMs: clampFade(20), fadeOutMs: clampFade(intro.fadeMs), gainDb: musicGain,
        sourceStartMs: 0, sourceEndMs: a.durationMs, stretchPercent: 0, fitStrategy: "full",
      };
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
  let outroClip: DirectedRenderClip | null = null;
  const outro = plan.bookendPlan.outro;
  if (outro && outro.assetId && outro.treatment !== "none") {
    const a = asset(outro.assetId);
    if (!frozen(outro.assetId)) errors.push(`outro asset ${outro.assetId} is not in the frozen profile`);
    else if (!a) errors.push(`outro asset ${outro.assetId} was not loaded`);
    else {
      outroClip = {
        assetId: outro.assetId, filePath: a.filePath, startMs: Math.max(0, outro.outroStartMs), durationMs: a.durationMs,
        kind: "music", pan: 0, fadeInMs: clampFade(outro.fadeInMs), fadeOutMs: clampFade(outro.fadeOutMs), gainDb: musicGain,
        sourceStartMs: 0, sourceEndMs: a.durationMs, stretchPercent: 0, fitStrategy: "full",
      };
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
  const all: DirectedRenderClip[] = [...(introClip ? [introClip] : []), ...cueClips, ...(outroClip ? [outroClip] : [])];
  for (const c of all) {
    if (!(c.startMs >= 0) || !(c.durationMs > 0)) errors.push(`clip ${c.assetId} has invalid bounds (${c.startMs}/${c.durationMs})`);
    if (c.gainDb < GAIN_MIN || c.gainDb > GAIN_MAX) errors.push(`clip ${c.assetId} gain ${c.gainDb} out of bounds`);
    if (c.fadeInMs < 0 || c.fadeInMs > FADE_MAX || c.fadeOutMs < 0 || c.fadeOutMs > FADE_MAX) errors.push(`clip ${c.assetId} fades out of bounds`);
    if (c.sourceEndMs < c.sourceStartMs) errors.push(`clip ${c.assetId} negative source window`);
  }
  // Required bookends must remain represented as a clip.
  if (intro?.required && !introClip) errors.push("required intro is not represented in the render clips");
  if (outro?.required && !outroClip) errors.push("required outro is not represented in the render clips");

  return { introClip, outroClip, cueClips, bed, dialogueStartMs, fittings, skippedCues, validation: { ok: errors.length === 0, errors } };
}
