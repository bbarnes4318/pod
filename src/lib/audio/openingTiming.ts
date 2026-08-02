// Opening timing invariants — the single source of truth for how long an
// episode may sit on music before the first host word. PURE + deterministic
// (no env reads, no I/O), so every render path and every test can share it.
//
// PRODUCTION DEFECT THIS EXISTS TO PREVENT
// ----------------------------------------
// Episode e7867729 opened with 30.9 SECONDS of theme music before anyone
// spoke. The cause was not a bug in one branch — it was the same formula
// copy-pasted into three placement sites:
//
//     dialogueStartMs = max(0, introAsset.durationMs - musicCrossfadeMs)
//
// That formula has NO upper bound: it derives the pre-roll entirely from the
// length of whatever theme asset happens to be selected. A 31.8s theme with the
// default 900ms crossfade produces a 30.9s pre-roll, and every one of the three
// sites (legacy stitcher, plan execution, scene stitcher) would have produced
// it. The post-TTS director's "full_before" treatment had the same shape of
// hole: it guarded a MINIMUM asset length and never a maximum.
//
// THE INVARIANT
// -------------
// The first spoken word must begin within MAX_SPEECH_START_MS. A theme longer
// than MAX_SONIC_LOGO_MS is NOT delayed-into-place — it is cut down to a sonic
// logo (or moved under/after the spoken cold open by the treatment that owns
// that decision). Delaying speech to fit the music is always the wrong trade:
// listeners leave.

/** Hard ceiling on when the first spoken word may enter. */
export const MAX_SPEECH_START_MS = 2000;

/** Longest stretch of theme that may play BEFORE the first spoken word. */
export const MAX_SONIC_LOGO_MS = 1500;

/** Matches the historical `AUDIO_MUSIC_CROSSFADE_MS || 900` default. */
export const DEFAULT_MUSIC_CROSSFADE_MS = 900;

export interface OpeningTimingCaps {
  /** Override the speech-start ceiling (tests / explicit operator intent). */
  maxSpeechStartMs?: number;
  /** Override the sonic-logo ceiling. */
  maxSonicLogoMs?: number;
}

function speechCap(opts: OpeningTimingCaps): number {
  const v = opts.maxSpeechStartMs;
  return Number.isFinite(v) && (v as number) >= 0 ? Math.round(v as number) : MAX_SPEECH_START_MS;
}

function logoCap(opts: OpeningTimingCaps): number {
  const v = opts.maxSonicLogoMs;
  return Number.isFinite(v) && (v as number) >= 0 ? Math.round(v as number) : MAX_SONIC_LOGO_MS;
}

/**
 * Clamp a raw pre-roll to the speech-start ceiling. This is the last line of
 * defence: whatever a treatment, plan, or asset length computed, speech starts
 * within the cap. Non-finite / negative input collapses to 0 (start now).
 */
export function capDialogueStartMs(rawStartMs: number, opts: OpeningTimingCaps = {}): number {
  const cap = speechCap(opts);
  if (!Number.isFinite(rawStartMs) || rawStartMs <= 0) return 0;
  return Math.min(Math.round(rawStartMs), cap);
}

/** Longest excerpt of an asset that may play before the first word. */
export function sonicLogoLengthMs(assetDurationMs: number, opts: OpeningTimingCaps = {}): number {
  if (!Number.isFinite(assetDurationMs) || assetDurationMs <= 0) return 0;
  return Math.min(Math.round(assetDurationMs), logoCap(opts));
}

export type OpeningMode =
  /** No intro asset at all — dialogue starts at 0. */
  | "no_intro"
  /** The asset is short enough to play in full before speech. */
  | "theme_before_speech"
  /** The asset was longer than the logo cap and is cut to a sonic logo. */
  | "sonic_logo";

export interface OpeningPlan {
  mode: OpeningMode;
  /** How much of the intro asset plays before the first word (ms of source). */
  introPlayDurationMs: number;
  /** True when the asset was longer than the cap and had to be cut. */
  truncated: boolean;
  /** Where the first spoken word enters. ALWAYS <= MAX_SPEECH_START_MS. */
  dialogueStartMs: number;
  /** Fade-out applied at the end of the played excerpt (the crossfade). */
  fadeOutMs: number;
  /** Human-readable justification, safe for job logs / diagnostics. */
  reason: string;
}

/**
 * Decide the opening: how much theme plays, and when speech enters.
 *
 * - Asset absent/zero-length -> no intro, speech at 0.
 * - Asset <= the sonic-logo cap -> UNCHANGED legacy behaviour: the whole asset
 *   plays and speech enters under its fade tail (`duration - crossfade`).
 * - Asset longer than the cap -> the theme is CUT to a sonic logo. Speech
 *   enters under that logo's fade, never after the full theme.
 *
 * The returned `dialogueStartMs` is always passed through capDialogueStartMs,
 * so no input can produce a pre-roll past the ceiling.
 */
export function resolveOpeningPlan(opts: {
  introDurationMs: number | null | undefined;
  musicCrossfadeMs?: number;
} & OpeningTimingCaps): OpeningPlan {
  const dur = Number(opts.introDurationMs);
  const crossfade = Number.isFinite(opts.musicCrossfadeMs)
    ? Math.max(0, Math.round(opts.musicCrossfadeMs as number))
    : DEFAULT_MUSIC_CROSSFADE_MS;

  if (!Number.isFinite(dur) || dur <= 0) {
    return {
      mode: "no_intro",
      introPlayDurationMs: 0,
      truncated: false,
      dialogueStartMs: 0,
      fadeOutMs: 0,
      reason: "no intro asset — dialogue starts immediately",
    };
  }

  const cap = logoCap(opts);
  if (dur <= cap) {
    // Short asset: exactly the historical behaviour (and already inside the
    // ceiling, since cap <= MAX_SPEECH_START_MS by construction).
    return {
      mode: "theme_before_speech",
      introPlayDurationMs: Math.round(dur),
      truncated: false,
      dialogueStartMs: capDialogueStartMs(Math.round(dur) - crossfade, opts),
      fadeOutMs: Math.min(crossfade, Math.round(dur)),
      reason: `intro asset ${Math.round(dur)}ms is within the ${cap}ms sonic-logo cap — plays in full before speech`,
    };
  }

  // Long asset: cut to a sonic logo. The crossfade is shortened to a fraction
  // of the logo so the branded hit is actually AUDIBLE before it ducks away —
  // a 900ms fade over a 1500ms logo would leave almost nothing at full gain.
  const playMs = cap;
  const fadeOutMs = Math.min(crossfade, Math.max(120, Math.round(playMs * 0.4)));
  return {
    mode: "sonic_logo",
    introPlayDurationMs: playMs,
    truncated: true,
    dialogueStartMs: capDialogueStartMs(playMs - fadeOutMs, opts),
    fadeOutMs,
    reason:
      `intro asset ${Math.round(dur)}ms exceeds the ${cap}ms sonic-logo cap — ` +
      `truncated to ${playMs}ms so speech starts within ${speechCap(opts)}ms instead of ${Math.max(0, Math.round(dur) - crossfade)}ms`,
  };
}
