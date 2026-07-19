// Post-TTS stitch bridge (PR 3, C5). Connects the live stitcher to the post-TTS
// director + executor: builds the actual dialogue timeline from the standardized
// segment WAVs (measuring real per-segment silence), runs the deterministic
// director, executes it into placed/fitted cue clips (trimming excerpts), and
// returns render-ready clips + the plan for diagnostics. Uses real ffmpeg only
// for measurement + excerpt trimming; all decisions are deterministic.

import path from "path";
import { runFfmpeg, standardizeClipToWav, getFileDurationMs, type TimelineClip } from "@/lib/audio/assembly";
import { analyzeSegmentSilence, resolveWaveformConfig, type GapBoundary } from "@/lib/audio/waveformAnalysis";
import { buildActualDialogueTimeline, type ActualTimelineLineInput } from "@/lib/audio/dialogueTimeline";
import { directPostTtsSound, type DirectorScriptLine, type PostTtsSoundDirectionPlan } from "@/lib/audio/postTtsSoundDirector";
import { executeDirectedPlan, type LoadedAssetLite, type DirectedExecution } from "@/lib/audio/postTtsExecution";
import type { FrozenSoundProfile } from "@/lib/services/podcastSoundProfile";

export interface StitchPlannedLineLite {
  filePath: string;
  durationMs: number;
  lineIndex: number;
  hostSlot: number;
  pauseBefore?: number;
  isInterruption?: boolean;
  segmentBreak?: "none" | "segment" | "topic";
  leadSilenceMs?: number;
  tailSilenceMs?: number;
}

export interface PostTtsBridgeInput {
  ffmpegPath: string;
  ffprobePath: string;
  tempDir: string;
  sampleRate: number;
  episodeId: string;
  scriptId: string;
  formatId: string;
  seed: string;
  frozenProfile: FrozenSoundProfile;
  plannedLines: StitchPlannedLineLite[];
  dialogueClips: Array<{ startMs: number; durationMs: number }>;
  scriptLines: DirectorScriptLine[];
  /** assetId -> loaded asset (filePath + durationMs). Frozen pool only. */
  loadedById: Map<string, { filePath: string; durationMs: number; assetId: string }>;
  includeIntro: boolean;
  includeOutro: boolean;
}

export interface PostTtsBridgeResult {
  ok: boolean;
  failureReason: string | null;
  plan: PostTtsSoundDirectionPlan;
  execution: DirectedExecution;
  /** Render-ready cue clips (transitions + reactions), excerpts pre-trimmed. */
  cueClips: TimelineClip[];
  /** True when the director's bed plan says a bed should play. */
  bedRequested: boolean;
}

const boundaryOf = (b?: "none" | "segment" | "topic"): GapBoundary => (b === "segment" ? "segment" : b === "topic" ? "topic" : "inline");

/** Run the post-TTS direction pipeline against the assembled dialogue. Never
 *  reads current podcast config or assets outside the frozen profile. */
export async function runPostTtsDirection(input: PostTtsBridgeInput): Promise<PostTtsBridgeResult> {
  const wcfg = resolveWaveformConfig();

  // Measure real per-segment silence (parallel, bounded by the segment count).
  const silences = await Promise.all(input.plannedLines.map(async (l) => {
    try { return await analyzeSegmentSilence(input.ffmpegPath, input.ffprobePath, l.filePath, wcfg); }
    catch { return null; }
  }));

  const timelineInput: ActualTimelineLineInput[] = input.plannedLines.map((l, i) => {
    const clip = input.dialogueClips[i];
    const sil = silences[i];
    return {
      lineIndex: l.lineIndex, hostId: `seat-${l.hostSlot}`, seatIndex: l.hostSlot,
      fileDurationMs: l.durationMs, timelineStartMs: clip.startMs, timelineEndMs: clip.startMs + l.durationMs,
      leadSilenceMs: sil?.leadSilenceMs ?? l.leadSilenceMs ?? 0,
      trailSilenceMs: sil?.trailSilenceMs ?? l.tailSilenceMs ?? 0,
      embeddedPauseMs: undefined, appliedPauseMs: i > 0 ? Math.max(0, clip.startMs - (input.dialogueClips[i - 1].startMs + input.plannedLines[i - 1].durationMs)) : 0,
      appliedOverlapMs: i > 0 ? Math.max(0, (input.dialogueClips[i - 1].startMs + input.plannedLines[i - 1].durationMs) - clip.startMs) : 0,
      isInterruption: !!l.isInterruption, segmentBoundary: boundaryOf(l.segmentBreak), timingSource: sil ? "ffprobe_waveform" : "assembly",
    };
  });

  const timeline = buildActualDialogueTimeline(timelineInput, wcfg);

  const plan = directPostTtsSound({
    episodeId: input.episodeId, scriptId: input.scriptId, seed: input.seed, formatId: input.formatId,
    frozenProfile: input.frozenProfile, timeline, scriptLines: input.scriptLines,
    introAssetDurationMs: input.frozenProfile.intro ? input.loadedById.get(input.frozenProfile.intro.assetId)?.durationMs ?? null : null,
    outroAssetDurationMs: input.frozenProfile.outro ? input.loadedById.get(input.frozenProfile.outro.assetId)?.durationMs ?? null : null,
    includeIntro: input.includeIntro, includeOutro: input.includeOutro, protectedSpeechPaddingMs: wcfg.protectedSpeechPaddingMs,
  });

  const frozenAssetIds = new Set<string>();
  for (const r of [input.frozenProfile.intro, input.frozenProfile.outro, input.frozenProfile.bed, ...input.frozenProfile.stingers, ...input.frozenProfile.reactions]) {
    if (r) frozenAssetIds.add(r.assetId);
  }
  const loaded = new Map<string, LoadedAssetLite>();
  for (const [id, a] of input.loadedById) loaded.set(id, { assetId: id, filePath: a.filePath, durationMs: a.durationMs });

  const execution = executeDirectedPlan(plan, loaded, { frozenAssetIds, protectedRegions: plan.protectedRegions });

  // A director failure OR an invalid render plan is a HARD, safe render failure —
  // never a silent fallback to the legacy planner.
  if (plan.failure) return failResult(plan, execution, `post-TTS director failed: ${plan.failure}`);
  if (!execution.validation.ok) return failResult(plan, execution, `post-TTS render plan invalid: ${execution.validation.errors.join("; ")}`);

  // Excerpted cues are pre-trimmed from the source so the mix is never abrupt.
  const cueClips: TimelineClip[] = [];
  for (const c of execution.cueClips) {
    let filePath = c.filePath;
    if (c.sourceEndMs < (input.loadedById.get(c.assetId)?.durationMs ?? c.sourceEndMs) - 1 || c.sourceStartMs > 0) {
      const trimmed = path.join(input.tempDir, `posttts-cue-${c.assetId}-${Math.round(c.startMs)}.wav`);
      await runFfmpeg(input.ffmpegPath, ["-y", "-i", c.filePath, "-af", `atrim=${(c.sourceStartMs / 1000).toFixed(3)}:${(c.sourceEndMs / 1000).toFixed(3)},asetpts=PTS-STARTPTS`, "-ar", String(input.sampleRate), "-c:a", "pcm_s16le", trimmed]);
      filePath = trimmed;
      void standardizeClipToWav; void getFileDurationMs;
    }
    cueClips.push({ filePath, startMs: c.startMs, durationMs: c.durationMs, kind: c.kind, pan: c.pan, fadeInMs: c.fadeInMs, fadeOutMs: c.fadeOutMs, gainDb: c.gainDb });
  }

  return { ok: true, failureReason: null, plan, execution, cueClips, bedRequested: !!execution.bed };
}

function failResult(plan: PostTtsSoundDirectionPlan, execution: DirectedExecution, reason: string): PostTtsBridgeResult {
  return { ok: false, failureReason: reason, plan, execution, cueClips: [], bedRequested: false };
}
