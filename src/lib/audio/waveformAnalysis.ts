// Deterministic post-TTS waveform analysis (PR 3).
//
// The pre-TTS planner estimates line timing. This module measures the ACTUAL
// generated dialogue: per-segment leading/trailing silence (so file duration is
// never mistaken for spoken duration) and classification of the real gaps
// between lines into what a cue can safely use.
//
// Room-tone note: the app mixes a continuous pink-noise room tone (~-58 dB)
// into the FINAL foreground, but the per-segment WAVs analyzed here are
// PRE-room-tone (standardized dialogue only), so a speech-vs-silence threshold
// near -40 dB is correct for them. The threshold is env-configurable and never
// a single hardcoded value baked into logic. Gaps BETWEEN segments are computed
// from the real assembled timeline (arithmetic), not by scanning mixed audio.

import { runFfmpeg, getFileDurationMs } from "./assembly";

export interface WaveformAnalysisConfig {
  silenceThresholdDb: number;   // speech vs silence boundary for a segment WAV
  minSilenceMs: number;         // shortest run counted as silence
  minTransitionGapMs: number;   // shortest gap that may host a transition/stinger
  minReactionGapMs: number;     // shortest gap that may host a reaction
  protectedSpeechPaddingMs: number; // padding around speech that stays protected
  maxAnalysisDurationMs: number;    // safety cap on how much audio we scan
}

const num = (name: string, dflt: number): number => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) ? v : dflt;
};

/** Resolve the analysis config from env (safe defaults). Pure w.r.t. its env. */
export function resolveWaveformConfig(): WaveformAnalysisConfig {
  return {
    silenceThresholdDb: num("POST_TTS_SILENCE_THRESHOLD_DB", -40),
    minSilenceMs: num("POST_TTS_MIN_SILENCE_MS", 120),
    minTransitionGapMs: num("POST_TTS_MIN_TRANSITION_GAP_MS", 1200),
    minReactionGapMs: num("POST_TTS_MIN_REACTION_GAP_MS", 450),
    protectedSpeechPaddingMs: num("POST_TTS_PROTECTED_SPEECH_PADDING_MS", 150),
    maxAnalysisDurationMs: num("POST_TTS_MAX_ANALYSIS_DURATION_MS", 600_000),
  };
}

export type SilenceSource = "ffprobe_waveform" | "assembly" | "provider_metadata";

export interface SegmentSilence {
  durationMs: number;      // encoded file duration
  leadSilenceMs: number;   // silence before the first audible speech
  trailSilenceMs: number;  // silence after the last audible speech
  speechStartMs: number;   // first audible speech (= leadSilenceMs)
  speechEndMs: number;     // last audible speech (= durationMs - trailSilenceMs)
  speechDurationMs: number; // audible spoken duration (never the file duration)
  source: SilenceSource;
}

/**
 * Measure a standardized segment WAV's leading/trailing silence and derive its
 * audible speech window. Deterministic (silencedetect + ffprobe duration).
 */
export async function analyzeSegmentSilence(
  ffmpegPath: string,
  ffprobePath: string,
  filePath: string,
  cfg: WaveformAnalysisConfig
): Promise<SegmentSilence> {
  const durationMs = await getFileDurationMs(ffprobePath, filePath);
  const scanMs = Math.min(durationMs, cfg.maxAnalysisDurationMs);
  const minSilenceSec = Math.max(0.005, cfg.minSilenceMs / 1000);
  const out = await runFfmpeg(ffmpegPath, [
    "-t", (scanMs / 1000).toFixed(3),
    "-i", filePath,
    "-af", `silencedetect=noise=${cfg.silenceThresholdDb}dB:d=${minSilenceSec}`,
    "-f", "null", "-",
  ]);
  const starts = [...out.matchAll(/silence_start:\s*(-?[\d.]+)/g)].map((m) => parseFloat(m[1]));
  const ends = [...out.matchAll(/silence_end:\s*(-?[\d.]+)/g)].map((m) => parseFloat(m[1]));

  let leadSilenceMs = 0;
  if (starts.length > 0 && starts[0] <= 0.03 && ends.length > 0) {
    leadSilenceMs = Math.max(0, Math.round(ends[0] * 1000));
  }
  // Trailing silence: the LAST silence region that either has no closing end
  // (runs to EOF) OR closes at ~EOF. ffmpeg emits a silence_end at the file end
  // when the clip finishes mid-silence, so a bare start-count check misses it.
  let trailSilenceMs = 0;
  if (starts.length > 0) {
    const lastStart = starts[starts.length - 1];
    const closesAtEof = ends.length < starts.length || (ends.length > 0 && ends[ends.length - 1] >= durationMs / 1000 - 0.05);
    if (closesAtEof) trailSilenceMs = Math.max(0, Math.round(durationMs - lastStart * 1000));
  }
  // Never let measured silence exceed the file.
  leadSilenceMs = Math.min(leadSilenceMs, durationMs);
  trailSilenceMs = Math.min(trailSilenceMs, Math.max(0, durationMs - leadSilenceMs));
  const speechStartMs = leadSilenceMs;
  const speechEndMs = Math.max(speechStartMs, durationMs - trailSilenceMs);
  return {
    durationMs, leadSilenceMs, trailSilenceMs, speechStartMs, speechEndMs,
    speechDurationMs: Math.max(0, speechEndMs - speechStartMs),
    source: "ffprobe_waveform",
  };
}

// ---------------------------------------------------------------------------
// Gap classification (pure)
// ---------------------------------------------------------------------------
export type GapBoundary = "inline" | "segment" | "topic";
export type GapClass =
  | "overlap_removed" // an interruption/overlap consumed the apparent gap
  | "too_short"       // shorter than any usable cue window
  | "breath"          // a natural breath-sized gap (no hard cue)
  | "reaction_ok"     // long enough for a reaction
  | "transition_ok"   // long enough for a transition/stinger
  | "topic_gap";      // a topic-boundary gap (widest musical room)

export interface DetectedAudioGap {
  /** Index of the line that OPENS the gap (the gap precedes this line). */
  lineIndex: number;
  startMs: number;         // timeline position where the gap begins
  durationMs: number;      // usable gap length (after overlap removal)
  boundary: GapBoundary;
  overlapMs: number;       // overlap that ate into the raw gap
  classification: GapClass;
}

/** Classify a real timeline gap. `overlapMs > 0` means speech overlapped the
 *  boundary, so there is no usable silent gap regardless of arithmetic. */
export function classifyGap(gapMs: number, boundary: GapBoundary, overlapMs: number, cfg: WaveformAnalysisConfig): GapClass {
  if (overlapMs > 0 || gapMs <= 0) return "overlap_removed";
  if (gapMs < cfg.minReactionGapMs) return gapMs < cfg.minSilenceMs ? "too_short" : "breath";
  if (boundary === "topic" && gapMs >= cfg.minTransitionGapMs) return "topic_gap";
  if (gapMs >= cfg.minTransitionGapMs) return "transition_ok";
  return "reaction_ok";
}

/** Is a gap classification usable for a hard transition / stinger? */
export const gapAllowsTransition = (c: GapClass) => c === "transition_ok" || c === "topic_gap";
/** Is a gap classification usable for a reaction? */
export const gapAllowsReaction = (c: GapClass) => c === "reaction_ok" || c === "transition_ok" || c === "topic_gap";
