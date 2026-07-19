// Safe render diagnostics — the per-render cue-sheet report persisted on the
// EpisodeAudioRender record (EpisodeAudioRender.diagnostics).
//
// The goal is a durable, auditable answer to "what did this render actually
// do, and why?" — every selected cue, why it was chosen, what was skipped and
// the exact safe reason, the measured bookend result, and the render's timing.
// It is deliberately buildable on BOTH the success and failure paths so a
// failed render still explains itself.
//
// HARD RULE: nothing here may contain a secret — no audio URLs, storage keys,
// Redis URLs, rights-document keys, or signed URLs. Asset ids (uuids) and safe
// display names are fine; those already live in the episode snapshot. As
// defense in depth, every string that flows in from a warning/reason is
// scrubbed of anything URL/key-shaped before it is stored.

import type { ProductionPlan } from "./productionPlan";
import type { SoundDesignSummary } from "./soundDesign";
import type { BookendVerification } from "./bookendQa";
import type { FrozenSoundProfile } from "@/lib/services/podcastSoundProfile";

export const RENDER_DIAGNOSTICS_VERSION = 1 as const;

/** Strip anything that looks like a URL, storage key, or signed token from a
 *  free-text string. Diagnostics store names + reasons, never locations. */
export function scrubSafeText(s: string): string {
  return s
    // protocol URLs (http, https, s3, redis, file, ...)
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, "[redacted-url]")
    // signed-url query fragments / long opaque tokens
    .replace(/[?&](X-Amz-[^=\s]+|signature|token|sig|key)=\S+/gi, "$1=[redacted]")
    // storage-key-ish path segments (episodes/.../final/...)
    .replace(/\b(?:episodes|assets|rights|renders)\/[\w./-]+/gi, "[redacted-key]")
    .trim();
}

function safeRef(ref: { assetId: string; name: string } | null | undefined) {
  return ref ? { assetId: ref.assetId, name: scrubSafeText(ref.name) } : null;
}

export interface RenderDiagnosticsInput {
  renderId: string;
  renderVersion: number;
  renderMode: string;
  /** Snapshot version the episode was created under (1/2/3/...); null if none. */
  snapshotVersion: number | null;
  /** Frozen sound-profile mode (system_default/custom/clean) or null for legacy. */
  soundProfileMode: string | null;
  plannerSeed: number | null;
  plannerVersion: string | null;
  style: string;
  sfxDensity: string;
  targetLoudnessLufs: number | null;
  cooldownScope: string;
  /** The frozen pool (for intro/outro/bed ids + safe names); null for legacy. */
  frozenProfile: FrozenSoundProfile | null;
  /** The executed cue sheet (planner path) — null on the legacy rotation path. */
  productionPlan: ProductionPlan | null;
  /** What actually reached the mix (the existing proof summary). */
  summary: SoundDesignSummary;
  /** Post-render waveform verification of the bookends; null if it could not run. */
  bookend: BookendVerification | null;
  /** Last spoken word (ms) and final master duration (ms). */
  speechEndMs: number;
  masterDurationMs: number | null;
  /** Safe skip warnings gathered during load/plan/execution. */
  skippedWarnings: string[];
}

export interface RenderDiagnostics {
  version: number;
  renderId: string;
  renderVersion: number;
  renderMode: string;
  snapshotVersion: number | null;
  soundProfileMode: string | null;
  plannerSeed: number | null;
  plannerVersion: string | null;
  style: string;
  sfxDensity: string;
  targetLoudnessLufs: number | null;
  cooldownScope: string;
  pool: {
    intro: { assetId: string; name: string } | null;
    outro: { assetId: string; name: string } | null;
    bed: { assetId: string; name: string } | null;
  };
  /** Per-cue detail: selection reason + musical-fit for every planned cue. */
  cues: Array<{
    type: string;
    lineIndex: number;
    assetId: string | null;
    assetName: string | null;
    category: string | null;
    timing: string;
    gainDb: number;
    fadeInMs: number;
    fadeOutMs: number;
    fit: number | null;
    /** Per-cue freshness is not separately emitted by the current planner
     *  (it is folded into `fit`); surfaced as null rather than fabricated. */
    freshness: number | null;
    reason: string;
  }>;
  /** What actually reached the mix (planned vs executed placement). */
  executed: {
    intro: string | null;
    outro: string | null;
    bed: string | null;
    bedDucking: boolean;
    stingerCount: number;
    reactionCount: number;
    highlightCount: number;
    stingers: Array<{ lineIndex: number; asset: string; reason: string; atMs: number }>;
    reactions: Array<{ lineIndex: number; asset: string; reason: string; atMs: number }>;
    silences: Array<{ lineIndex: number; reason: string }>;
  };
  cooldown: {
    scope: string;
    suppressions: number | null;
    distinctAssetsUsed: number | null;
  };
  /** Cues the plan deliberately held + assets skipped with their safe reason. */
  skipped: {
    silences: Array<{ lineIndex: number; reason: string }>;
    warnings: string[];
  };
  timing: {
    speechEndMs: number;
    masterDurationMs: number | null;
    outroTailMs: number | null;
  };
  bookend: {
    ran: boolean;
    ok: boolean | null;
    introVerified: boolean | null;
    outroVerified: boolean | null;
    outroTailMs: number | null;
    headRmsDb: number | null;
    tailRmsDb: number | null;
    failures: string[];
    checks: Array<{ name: string; status: string; detail: string }>;
  };
}

/**
 * Assemble the safe render diagnostics. Pure and deterministic given its input.
 */
export function buildRenderDiagnostics(input: RenderDiagnosticsInput): RenderDiagnostics {
  const plan = input.productionPlan;
  const fp = input.frozenProfile;

  const cues = (plan?.cues ?? []).map((c) => ({
    type: c.type,
    lineIndex: c.lineIndex,
    assetId: c.assetId,
    assetName: c.assetName ? scrubSafeText(c.assetName) : null,
    category: c.category ?? null,
    timing: c.timing,
    gainDb: c.gainDb,
    fadeInMs: c.fadeInMs,
    fadeOutMs: c.fadeOutMs,
    fit: typeof c.fit === "number" ? c.fit : null,
    freshness: null,
    reason: scrubSafeText(c.reason ?? ""),
  }));

  const outroTailMs =
    input.masterDurationMs != null ? input.masterDurationMs - input.speechEndMs : null;

  return {
    version: RENDER_DIAGNOSTICS_VERSION,
    renderId: input.renderId,
    renderVersion: input.renderVersion,
    renderMode: input.renderMode,
    snapshotVersion: input.snapshotVersion,
    soundProfileMode: input.soundProfileMode,
    plannerSeed: input.plannerSeed,
    plannerVersion: input.plannerVersion,
    style: input.style,
    sfxDensity: input.sfxDensity,
    targetLoudnessLufs: input.targetLoudnessLufs,
    cooldownScope: input.cooldownScope,
    pool: {
      intro: safeRef(fp?.intro ?? null),
      outro: safeRef(fp?.outro ?? null),
      bed: safeRef(fp?.bed ?? null),
    },
    cues,
    executed: {
      intro: input.summary.introAsset ? scrubSafeText(input.summary.introAsset) : null,
      outro: input.summary.outroAsset ? scrubSafeText(input.summary.outroAsset) : null,
      bed: input.summary.bedAsset ? scrubSafeText(input.summary.bedAsset) : null,
      bedDucking: input.summary.bedDucking,
      stingerCount: input.summary.stingerCount,
      reactionCount: input.summary.reactionCount,
      highlightCount: input.summary.highlightCount,
      stingers: (input.summary.stingers ?? []).map((s) => ({
        lineIndex: s.lineIndex,
        asset: scrubSafeText(s.asset),
        reason: scrubSafeText(s.reason),
        atMs: s.atMs,
      })),
      reactions: (input.summary.reactions ?? []).map((s) => ({
        lineIndex: s.lineIndex,
        asset: scrubSafeText(s.asset),
        reason: scrubSafeText(s.reason),
        atMs: s.atMs,
      })),
      silences: (input.summary.silences ?? []).map((s) => ({
        lineIndex: s.lineIndex,
        reason: scrubSafeText(s.reason),
      })),
    },
    cooldown: {
      scope: input.cooldownScope,
      suppressions: plan?.stats.cooldownSuppressions ?? null,
      distinctAssetsUsed: plan?.stats.distinctAssetsUsed ?? null,
    },
    skipped: {
      silences: (input.summary.silences ?? []).map((s) => ({
        lineIndex: s.lineIndex,
        reason: scrubSafeText(s.reason),
      })),
      warnings: input.skippedWarnings.map(scrubSafeText),
    },
    timing: {
      speechEndMs: input.speechEndMs,
      masterDurationMs: input.masterDurationMs,
      outroTailMs,
    },
    bookend: input.bookend
      ? {
          ran: true,
          ok: input.bookend.ok,
          introVerified: input.bookend.introVerified,
          outroVerified: input.bookend.outroVerified,
          outroTailMs: input.bookend.outroTailMs,
          headRmsDb: input.bookend.headRmsDb,
          tailRmsDb: input.bookend.tailRmsDb,
          failures: input.bookend.failures.map(scrubSafeText),
          checks: input.bookend.checks.map((c) => ({ name: c.name, status: c.status, detail: scrubSafeText(c.detail) })),
        }
      : {
          ran: false,
          ok: null,
          introVerified: null,
          outroVerified: null,
          outroTailMs,
          headRmsDb: null,
          tailRmsDb: null,
          failures: [],
          checks: [],
        },
  };
}
