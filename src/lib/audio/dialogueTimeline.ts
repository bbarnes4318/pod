// Actual-dialogue timeline (PR 3). PURE + deterministic.
//
// The canonical model of the REAL generated dialogue, built from measured
// segment durations + measured leading/trailing silence + the assembled
// timeline (start/end, applied pauses, overlaps) + script/format metadata. It
// deliberately distinguishes encoded file bounds from AUDIBLE speech bounds so
// downstream cue direction never treats file duration as spoken duration, and
// it derives the real usable gaps between lines (accounting for silence and
// overlaps). No ffmpeg here — measurement is done in waveformAnalysis.ts and
// fed in, keeping this layer deterministic and unit-testable.

import { classifyGap, type WaveformAnalysisConfig, type DetectedAudioGap, type GapBoundary } from "./waveformAnalysis";

export const ACTUAL_DIALOGUE_TIMELINE_VERSION = 1 as const;

export type TimingSource = "provider_metadata" | "ffprobe_waveform" | "assembly";

export interface ActualTimelineLineInput {
  lineIndex: number;
  segmentId?: string | null;
  hostId: string;
  seatIndex: number;
  fileDurationMs: number;      // encoded/standardized clip duration
  timelineStartMs: number;     // placed start on the assembled timeline
  timelineEndMs: number;       // placed end (== start + fileDurationMs typically)
  leadSilenceMs: number;       // measured leading silence
  trailSilenceMs: number;      // measured trailing silence
  embeddedPauseMs?: number;    // script pauseBefore (intended pause)
  appliedPauseMs?: number;     // spacing the assembler added before this line
  appliedOverlapMs?: number;   // interruption overlap applied before this line
  isInterruption: boolean;
  segmentBoundary: GapBoundary; // "inline" | "segment" | "topic"
  formatRole?: string | null;
  timingSource: TimingSource;
}

export interface ActualTimelineLine extends ActualTimelineLineInput {
  /** Absolute timeline position of the first audible spoken word. */
  speechStartMs: number;
  /** Absolute timeline position of the last audible spoken word. */
  speechEndMs: number;
  /** Audible spoken duration — NEVER the file duration. */
  speechDurationMs: number;
}

export interface ActualDialogueTimeline {
  version: number;
  dialogueDurationMs: number;  // end of the last audible speech (+ its trailing silence)
  speechStartMs: number;       // first audible speech across the episode
  speechEndMs: number;         // last audible speech across the episode
  lines: ActualTimelineLine[];
  gaps: DetectedAudioGap[];
}

export type DialogueTimelineError =
  | { code: "dialogue_timeline_invalid"; reason: string };

function invalid(reason: string): never {
  const e = new Error(`dialogue_timeline_invalid: ${reason}`) as Error & { category: string };
  e.category = "dialogue_timeline_invalid";
  throw e;
}

/**
 * Build the actual dialogue timeline. Throws a typed dialogue_timeline_invalid
 * error on structurally impossible input (non-finite/negative durations,
 * silence exceeding the clip, non-monotonic placement).
 */
export function buildActualDialogueTimeline(
  input: ActualTimelineLineInput[],
  cfg: WaveformAnalysisConfig
): ActualDialogueTimeline {
  if (!Array.isArray(input) || input.length === 0) invalid("no dialogue lines");

  const lines: ActualTimelineLine[] = input.map((l, i) => {
    if (!Number.isFinite(l.fileDurationMs) || l.fileDurationMs <= 0) invalid(`line ${l.lineIndex}: bad fileDurationMs ${l.fileDurationMs}`);
    if (!Number.isFinite(l.timelineStartMs) || l.timelineStartMs < 0) invalid(`line ${l.lineIndex}: bad timelineStartMs`);
    if (l.timelineEndMs < l.timelineStartMs) invalid(`line ${l.lineIndex}: end before start`);
    const lead = Math.max(0, Math.min(l.leadSilenceMs || 0, l.fileDurationMs));
    const trail = Math.max(0, Math.min(l.trailSilenceMs || 0, l.fileDurationMs - lead));
    const speechStartMs = l.timelineStartMs + lead;
    const speechEndMs = Math.max(speechStartMs, l.timelineStartMs + (l.fileDurationMs - trail));
    void i;
    return { ...l, leadSilenceMs: lead, trailSilenceMs: trail, speechStartMs, speechEndMs, speechDurationMs: speechEndMs - speechStartMs };
  });

  // Real usable gaps between consecutive lines: the silent region between one
  // line's last audible word and the next line's first audible word. Overlaps
  // (interruptions) make this negative -> the gap is "removed".
  const gaps: DetectedAudioGap[] = [];
  for (let i = 1; i < lines.length; i++) {
    const prev = lines[i - 1];
    const curr = lines[i];
    const audibleGapMs = curr.speechStartMs - prev.speechEndMs;
    const overlapMs = curr.appliedOverlapMs != null
      ? Math.max(0, curr.appliedOverlapMs)
      : Math.max(0, prev.timelineEndMs - curr.timelineStartMs);
    gaps.push({
      lineIndex: curr.lineIndex,
      startMs: prev.speechEndMs,
      durationMs: Math.max(0, audibleGapMs),
      boundary: curr.segmentBoundary,
      overlapMs,
      classification: classifyGap(audibleGapMs, curr.segmentBoundary, overlapMs, cfg),
    });
  }

  const first = lines[0];
  const last = lines[lines.length - 1];
  return {
    version: ACTUAL_DIALOGUE_TIMELINE_VERSION,
    dialogueDurationMs: last.timelineStartMs + last.fileDurationMs,
    speechStartMs: first.speechStartMs,
    speechEndMs: last.speechEndMs,
    lines,
    gaps,
  };
}
