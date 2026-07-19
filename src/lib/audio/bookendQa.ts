// Post-render bookend verification.
//
// A database cue row is NOT proof that an intro/outro is audible in the
// finished master. Cues get planned, executed, mixed, mastered, and uploaded;
// any of those stages can drop a bookend (a decode failure, a zeroed clip, a
// truncated encode) while the render still reports "success". That is exactly
// how episodes have shipped with no audible outro.
//
// This module measures the RENDERED WAVEFORM with ffmpeg and answers, for the
// finished master:
//   * did the master extend beyond the last spoken word by the outro tail?
//   * is that tail actual audio (above a silence threshold), not just the
//     continuous room-tone floor?
//   * was the master truncated before the outro finished?
//   * when an intro was placed, is the head of the file audible?
//
// The caller (the stitcher) uses the result to FAIL a render whose enabled,
// placed outro is missing/silent/clipped, instead of handing out a broken
// "audio_ready" file. All returned reasons are safe (no URLs, keys, or paths).

import { getFileDurationMs, runFfmpeg } from "./assembly";

/** What the render intended for the bookends, plus the measured speech end. */
export interface BookendExpectation {
  /** The render REQUIRES an audible intro (enabled, non-clean, and the resolved
   *  configuration intended one). A required intro that is not placed OR not
   *  audible FAILS. */
  introRequired: boolean;
  /** An intro clip was actually placed on the timeline. */
  introPlaced: boolean;
  introDurationMs: number | null;
  /** Stage-specific safe reason to report if a REQUIRED intro was never placed
   *  (resolution/genre/load/execute drop). */
  introAbsenceReason?: string;
  /** The render REQUIRES an audible outro (see introRequired). */
  outroRequired: boolean;
  /** An outro clip was actually placed on the timeline. */
  outroPlaced: boolean;
  /** outroClip.startMs (where the outro begins, usually just under the sign-off). */
  outroStartMs: number | null;
  outroDurationMs: number | null;
  /** Stage-specific safe reason to report if a REQUIRED outro was never placed. */
  outroAbsenceReason?: string;
  /** Max end (ms) of the dialogue (+highlight) clips — the last spoken word. */
  speechEndMs: number;
  /** RMS (dB) above which a window counts as real audio, not the room-tone
   *  floor. The foreground carries continuous pink-noise room tone near
   *  -58 dB; a real mastered bookend sits far above this. Default -45. */
  silenceThresholdDb?: number;
  /** Minimum tail (ms) beyond the last spoken word a required+placed outro must
   *  add. Default 300. */
  minOutroTailMs?: number;
  /** Slack (ms) for the truncation check. Default 300. */
  truncationToleranceMs?: number;
}

// ---------------------------------------------------------------------------
// Requirement resolution: is a bookend REQUIRED for this render, independent of
// whether one survived to a placed clip? This is what turns "an enabled outro
// silently vanished during resolution / genre gate / loading / execution" into
// a hard failure instead of a passing "honest skip". The frozen profile is the
// source of truth for a snapshot episode; the legacy/system path uses the
// configured theme id / env fallback, and treats "enabled but nothing
// configured" as required (a misconfiguration that must fail, not ship mute).
// ---------------------------------------------------------------------------

export type BookendKind = "intro" | "outro";

export interface BookendRequirementInput {
  kind: BookendKind;
  /** style === "clean". */
  clean: boolean;
  /** includeIntro / includeOutro (the render-level enable toggle). */
  enabled: boolean;
  hasFrozenProfile: boolean;
  /** v4 EXPLICIT frozen bookend intent: true (enabled) / false (disabled) /
   *  null (v2/v3 profile with no frozen intent — compatibility path). When true,
   *  the bookend is required even if no asset resolved (that must fail). When
   *  false, it is intentionally disabled. When null, requirement is inferred
   *  from the resolved asset / exclusion, never fabricated. */
  frozenIntent: boolean | null;
  /** frozenProfile.intro?.assetId ?? null (or outro). */
  frozenRefAssetId: string | null;
  /** frozenProfile.excluded entry reason for this role, or null. A present
   *  reason means the bookend was configured/enabled but dropped at profile
   *  resolution (rights/missing/kind) — still required, and must fail. */
  frozenExcludedReason: string | null;
  /** Legacy/system path: the configured SoundDesignConfig theme id, or null. */
  legacyConfiguredAssetId: string | null;
  /** Legacy/system path: an AUDIO_INTRO_URL / AUDIO_OUTRO_URL env fallback set. */
  legacyEnvConfigured: boolean;
}

export interface BookendRequirement {
  required: boolean;
  assetId: string | null;
  code:
    | "clean"
    | "disabled"
    | "frozen_disabled"
    | "frozen_enabled_no_asset"
    | "profile_no_bookend"
    | "frozen_asset"
    | "excluded_at_resolution"
    | "legacy_configured"
    | "legacy_unconfigured";
  excludedReason: string | null;
}

export function resolveBookendRequirement(i: BookendRequirementInput): BookendRequirement {
  if (i.clean) return { required: false, assetId: null, code: "clean", excludedReason: null };
  if (!i.enabled) return { required: false, assetId: null, code: "disabled", excludedReason: null };
  if (i.hasFrozenProfile) {
    // The frozen profile is authoritative for a snapshot episode.
    if (i.frozenIntent === false) {
      // v4 explicit: intentionally disabled. Not required; absence is valid.
      return { required: false, assetId: null, code: "frozen_disabled", excludedReason: null };
    }
    if (i.frozenIntent === true) {
      // v4 explicit: enabled. REQUIRED regardless of whether an asset resolved —
      // an enabled bookend with no asset and no exclusion is the exact defect v4
      // makes visible, and it must fail (never silently ship without it).
      if (i.frozenRefAssetId) return { required: true, assetId: i.frozenRefAssetId, code: "frozen_asset", excludedReason: null };
      if (i.frozenExcludedReason) return { required: true, assetId: null, code: "excluded_at_resolution", excludedReason: i.frozenExcludedReason };
      return { required: true, assetId: null, code: "frozen_enabled_no_asset", excludedReason: null };
    }
    // frozenIntent === null: v2/v3 profile with NO frozen intent. Documented
    // compatibility — infer requirement from what actually resolved; never
    // fabricate historical intent from the current podcast configuration.
    if (i.frozenRefAssetId) return { required: true, assetId: i.frozenRefAssetId, code: "frozen_asset", excludedReason: null };
    if (i.frozenExcludedReason) return { required: true, assetId: null, code: "excluded_at_resolution", excludedReason: i.frozenExcludedReason };
    return { required: false, assetId: null, code: "profile_no_bookend", excludedReason: null };
  }
  // Legacy / system default path.
  if (i.legacyConfiguredAssetId || i.legacyEnvConfigured) {
    return { required: true, assetId: i.legacyConfiguredAssetId, code: "legacy_configured", excludedReason: null };
  }
  // Enabled + non-clean + nothing configured anywhere = a misconfiguration; a
  // non-clean render that was asked for a bookend must not ship without one.
  return { required: true, assetId: null, code: "legacy_unconfigured", excludedReason: null };
}

export interface BookendAbsenceContext {
  req: BookendRequirement;
  /** Planner path: the plan carries a cue of this kind (asset or env). null on
   *  the legacy (no-plan) path. false means the planner emitted no such cue —
   *  the strongest signal of a theme-genre-gate rejection. */
  planHasCue: boolean | null;
  /** The intended asset id is in the loaded asset set. null when unknown. */
  assetLoaded: boolean | null;
  /** A safe warning naming this asset (load/rights/hash), already scrubbed. */
  loadWarning: string | null;
  /** How many themes the planner genre-excluded this render. */
  themesExcluded: number;
}

/** A safe, stage-specific reason a REQUIRED bookend never became a clip. */
export function describeBookendAbsence(kind: BookendKind, ctx: BookendAbsenceContext): string {
  const { req } = ctx;
  if (req.code === "excluded_at_resolution") {
    return `${kind} was configured but excluded at profile resolution: ${req.excludedReason ?? "rights/compatibility"}`;
  }
  if (req.code === "frozen_enabled_no_asset") {
    return `${kind} is enabled in the frozen (v4) sound profile but no ${kind} asset was assigned or resolved`;
  }
  if (req.code === "legacy_unconfigured") {
    return `${kind} is enabled for a non-clean render but no ${kind} asset is configured`;
  }
  if (ctx.planHasCue === false) {
    const extra = ctx.themesExcluded > 0 ? ` (${ctx.themesExcluded} theme(s) genre-excluded)` : "";
    return `${kind} produced no cue - excluded by the theme genre gate or not planned${extra}`;
  }
  if (req.assetId && ctx.assetLoaded === false) {
    return ctx.loadWarning
      ? `${kind} asset failed to load: ${ctx.loadWarning}`
      : `${kind} asset was not loaded (missing object / decode / hash mismatch)`;
  }
  return `${kind} was resolved but not placed on the final timeline (execution/mix drop)`;
}

export interface BookendCheck {
  name: string;
  status: "pass" | "fail" | "skip";
  detail: string;
}

export interface BookendVerification {
  ok: boolean;
  masterDurationMs: number;
  speechEndMs: number;
  /** masterDurationMs - speechEndMs. Negative/zero means the master ended at or
   *  before the last spoken word (no tail). */
  outroTailMs: number;
  headRmsDb: number | null;
  tailRmsDb: number | null;
  introVerified: boolean;
  outroVerified: boolean;
  /** Safe failure reasons (never contain URLs/keys/paths). */
  failures: string[];
  checks: BookendCheck[];
}

/** Mean RMS (dB) over a window, via ffmpeg astats. Returns -Infinity for a
 *  silent window (astats reports "-inf") or when the meter produced no value,
 *  so a dropped/zeroed bookend reads as silence rather than throwing. */
async function windowRmsDb(
  ffmpegPath: string,
  filePath: string,
  fromSec: number,
  toSec: number
): Promise<number> {
  const from = Math.max(0, fromSec);
  const to = Math.max(from + 0.01, toSec);
  const out = await runFfmpeg(ffmpegPath, [
    "-i", filePath,
    "-af", `atrim=${from.toFixed(3)}:${to.toFixed(3)},astats=metadata=0:measure_overall=RMS_level:measure_perchannel=none`,
    "-f", "null", "-",
  ]);
  // astats prints "RMS level dB: -18.4" or "RMS level dB: -inf" for silence.
  const m = out.match(/RMS level dB:\s*(-?inf|-?[\d.]+)/);
  if (!m) return -Infinity;
  if (/inf/i.test(m[1])) return -Infinity;
  const v = parseFloat(m[1]);
  return Number.isFinite(v) ? v : -Infinity;
}

/**
 * Verify the intro/outro are actually present and complete in the finished
 * master. Pure measurement — never mutates anything. Safe to call on any mp3.
 */
export async function verifyBookends(
  ffmpegPath: string,
  ffprobePath: string,
  masterPath: string,
  exp: BookendExpectation
): Promise<BookendVerification> {
  const silenceThreshold = exp.silenceThresholdDb ?? -45;
  const minOutroTailMs = exp.minOutroTailMs ?? 300;
  const truncTolMs = exp.truncationToleranceMs ?? 300;

  const masterDurationMs = await getFileDurationMs(ffprobePath, masterPath);
  const speechEndMs = Math.max(0, Math.round(exp.speechEndMs));
  const outroTailMs = masterDurationMs - speechEndMs;

  const checks: BookendCheck[] = [];
  const failures: string[] = [];
  let headRmsDb: number | null = null;
  let tailRmsDb: number | null = null;
  let introVerified = false;
  let outroVerified = false;

  // --- Intro ---------------------------------------------------------------
  if (!exp.introRequired) {
    checks.push({ name: "intro", status: "skip", detail: "intro not required (disabled / clean / profile has none)" });
  } else if (!exp.introPlaced || !exp.introDurationMs) {
    // REQUIRED but never became a clip — it was dropped at resolution, the genre
    // gate, loading, or execution. That must FAIL the render (not "honest skip"),
    // so a non-clean episode can never ship missing an intro it was meant to have.
    const reason = exp.introAbsenceReason || "Required intro is missing from the render (resolution/genre/load/execute drop).";
    failures.push(reason);
    checks.push({ name: "intro", status: "fail", detail: reason });
  } else {
    // The first ~1.5s is intro-only (dialogue starts under the intro's fade
    // tail). Measure that head window.
    const headMs = Math.min(exp.introDurationMs, 1500);
    headRmsDb = await windowRmsDb(ffmpegPath, masterPath, 0, headMs / 1000);
    if (headRmsDb > silenceThreshold) {
      introVerified = true;
      checks.push({ name: "intro", status: "pass", detail: `intro head audible (${headRmsDb.toFixed(1)} dB over first ${headMs} ms)` });
    } else {
      const reason = `Enabled intro is not audible in the final master (head RMS ${Number.isFinite(headRmsDb) ? headRmsDb.toFixed(1) : "-inf"} dB <= ${silenceThreshold} dB threshold).`;
      failures.push(reason);
      checks.push({ name: "intro", status: "fail", detail: reason });
    }
  }

  // --- Outro ---------------------------------------------------------------
  if (!exp.outroRequired) {
    checks.push({ name: "outro", status: "skip", detail: "outro not required (disabled / clean / profile has none)" });
  } else if (!exp.outroPlaced || !exp.outroDurationMs) {
    // REQUIRED but never became a clip (unconfigured / genre-rejected / rights-
    // excluded / missing from plan / not loaded / not executed). FAIL — this is
    // the "some finished episodes have no audible outro" defect.
    const reason = exp.outroAbsenceReason || "Required outro is missing from the render (resolution/genre/load/execute drop).";
    failures.push(reason);
    checks.push({ name: "outro", status: "fail", detail: reason });
  } else {
    // 1. Not truncated: the master must reach the planned end of the outro clip.
    const plannedOutroEndMs = (exp.outroStartMs ?? speechEndMs) + exp.outroDurationMs;
    const truncated = masterDurationMs < plannedOutroEndMs - truncTolMs;

    // 2. Tail beyond speech: the outro must extend past the last spoken word.
    const tailLongEnough = outroTailMs >= minOutroTailMs;

    // 3. Tail audible: the region after the last spoken word is outro-only.
    //    Measure it (bounded so a very long outro doesn't scan the whole tail).
    if (outroTailMs > 0) {
      const tailStartSec = speechEndMs / 1000;
      const tailEndSec = Math.min(masterDurationMs, speechEndMs + Math.min(outroTailMs, 2500)) / 1000;
      tailRmsDb = await windowRmsDb(ffmpegPath, masterPath, tailStartSec, tailEndSec);
    } else {
      tailRmsDb = -Infinity;
    }
    const tailAudible = tailRmsDb > silenceThreshold;

    if (truncated) {
      const reason = `Final master is truncated before the outro completes (master ${masterDurationMs} ms < planned outro end ${plannedOutroEndMs} ms).`;
      failures.push(reason);
      checks.push({ name: "outro_truncation", status: "fail", detail: reason });
    } else {
      checks.push({ name: "outro_truncation", status: "pass", detail: `master reaches planned outro end (${masterDurationMs} ms >= ${plannedOutroEndMs} ms)` });
    }

    if (!tailLongEnough) {
      const reason = `Enabled outro does not extend beyond the final spoken line (tail ${outroTailMs} ms < ${minOutroTailMs} ms required).`;
      failures.push(reason);
      checks.push({ name: "outro_tail_length", status: "fail", detail: reason });
    } else {
      checks.push({ name: "outro_tail_length", status: "pass", detail: `outro tail ${outroTailMs} ms >= ${minOutroTailMs} ms` });
    }

    if (!tailAudible) {
      const reason = `Enabled outro is not audible after the final spoken line (tail RMS ${Number.isFinite(tailRmsDb) ? tailRmsDb.toFixed(1) : "-inf"} dB <= ${silenceThreshold} dB threshold) - the outro disappeared during mixing/encoding.`;
      failures.push(reason);
      checks.push({ name: "outro_tail_audible", status: "fail", detail: reason });
    } else {
      checks.push({ name: "outro_tail_audible", status: "pass", detail: `outro tail audible (${tailRmsDb!.toFixed(1)} dB)` });
    }

    outroVerified = !truncated && tailLongEnough && tailAudible;
  }

  return {
    ok: failures.length === 0,
    masterDurationMs,
    speechEndMs,
    outroTailMs,
    headRmsDb,
    tailRmsDb,
    introVerified,
    outroVerified,
    failures,
    checks,
  };
}
