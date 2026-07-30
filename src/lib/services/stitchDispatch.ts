// Render-mode dispatch for spoken-audio jobs.
//
// The PERSISTED Episode.ttsRenderMode (written at generation time by
// ttsSceneService) decides which pipeline handles a script — never the
// current environment variables. Legacy episodes (null / "legacy_line")
// keep the exact per-line pipeline; scene episodes use the scene assembler.

import { db } from "@/lib/db";
import { generateTtsSegments } from "@/lib/services/ttsSegmentService";
import { stitchFinalEpisodeAudio } from "@/lib/services/audioStitchingService";
import { stitchSceneEpisodeAudio, isSceneRenderMode } from "@/lib/services/sceneStitchingService";
import {
  assertSceneGenerationComplete,
  readSceneQaAttemptLimit,
  sceneGenerationIsComplete,
} from "@/lib/audio/sceneGenerationOutcome";
import {
  generateDialogueScenes,
  readRenderModeSetting,
  regenerateSceneForLine,
} from "@/lib/services/ttsSceneService";
import type { TtsSegmentJobData, FinalAudioStitchJobData } from "@/lib/queue/podcastQueue";

// Scene rendering was fully implemented but the unset-value default remained
// `legacy_line`, so production continued making one Fish request per stored
// script line. That is the exact mechanical, context-resetting delivery this
// subsystem was built to replace. "auto" is now the runtime default: eligible
// Fish/ElevenLabs casts render whole scenes; unsupported/mixed casts fall back
// explicitly and record why. An operator may still force the old path with
// TTS_RENDER_MODE=legacy_line.
if (!process.env.TTS_RENDER_MODE?.trim()) {
  process.env.TTS_RENDER_MODE = "auto";
}

/**
 * Voice a script. Scene mode is attempted when the operator flag allows it and
 * the job carries no line-level filters (a segmentRange/host-filtered request
 * is inherently a line-mode console operation). All fallback decisions are
 * recorded by the scene service itself.
 */
export async function dispatchTtsGeneration(data: TtsSegmentJobData) {
  const lineLevelRequest = !!data.segmentRange || !!data.hostId;
  if (readRenderModeSetting() === "legacy_line" || lineLevelRequest) {
    const res = await generateTtsSegments(data);
    // Persist the decision for line-level runs on episodes not already scene-voiced.
    const script = await db.script.findUnique({ where: { id: data.scriptId }, select: { episodeId: true } });
    if (script && !lineLevelRequest) {
      await db.episode.update({ where: { id: script.episodeId }, data: { ttsRenderMode: "legacy_line" } });
    }
    return { pipeline: "legacy_line" as const, result: res };
  }

  // Retry scene-performance QA INSIDE this active worker stage. The prior
  // implementation threw after the first rejected candidate and relied on
  // BullMQ to retry the whole job. The worker immediately wrote that attempt as
  // `failed`, so the customer saw a stopped episode even while another attempt
  // was already scheduled. Keeping the bounded loop here makes the UI truthful:
  // the Voices stage stays active, ready scene fingerprints are reused, and only
  // the rejected scene is sent back to the provider.
  const maxAttempts = readSceneQaAttemptLimit();
  let qaAttempt = 1;
  let summary = await generateDialogueScenes({
    scriptId: data.scriptId,
    forceRegenerate: data.forceRegenerate,
    providerOverride: data.providerOverride,
    voiceOverrides: data.voiceOverrides,
  });

  while (!sceneGenerationIsComplete(summary) && qaAttempt < maxAttempts) {
    console.warn(
      `[TTS] Scene QA attempt ${qaAttempt}/${maxAttempts} left ${summary.failedScenes} failed scene(s); ` +
        `retrying only the failed scene fingerprints.`
    );
    qaAttempt += 1;
    summary = await generateDialogueScenes({
      scriptId: data.scriptId,
      // A user-requested full regeneration applies only to the first pass. Once
      // that pass has produced ready scenes, retry passes must preserve them.
      forceRegenerate: false,
      providerOverride: data.providerOverride,
      voiceOverrides: data.voiceOverrides,
    });
  }

  // A partial scene run is never allowed to chain into final mixing. This error
  // is now raised only after the internal retry budget is actually exhausted.
  assertSceneGenerationComplete(summary, qaAttempt);

  return { pipeline: summary.mode, result: { ...summary, qaAttempts: qaAttempt } };
}

/** Stitch a script's final episode audio via the pipeline that VOICED it. */
export async function dispatchFinalStitch(data: FinalAudioStitchJobData) {
  const script = await db.script.findUnique({
    where: { id: data.scriptId },
    select: { episode: { select: { ttsRenderMode: true } } },
  });
  if (isSceneRenderMode(script?.episode?.ttsRenderMode)) {
    return stitchSceneEpisodeAudio(data);
  }
  return stitchFinalEpisodeAudio(data);
}

/**
 * Line-edit regeneration. Legacy episodes re-voice ONE line; scene episodes
 * truthfully regenerate the SMALLEST CONTAINING SCENE (an isolated line
 * cannot be re-performed without changing the conversation around it), then
 * re-stitch from unchanged scenes + the regenerated scene.
 */
export async function dispatchLineRegen(scriptId: string, lineIndex: number) {
  const script = await db.script.findUnique({
    where: { id: scriptId },
    select: { episode: { select: { ttsRenderMode: true } } },
  });
  if (isSceneRenderMode(script?.episode?.ttsRenderMode)) {
    const regen = await regenerateSceneForLine(scriptId, lineIndex);
    const stitch = await stitchSceneEpisodeAudio({ scriptId, forceRegenerate: true });
    return {
      mode: "scene" as const,
      regeneratedScene: {
        sceneIndex: regen.sceneIndex,
        firstLineIndex: regen.firstLineIndex,
        lastLineIndex: regen.lastLineIndex,
      },
      tts: regen.summary,
      stitch,
    };
  }
  const tts = await generateTtsSegments({
    scriptId,
    segmentRange: { startLineIndex: lineIndex, endLineIndex: lineIndex },
    forceRegenerate: true,
  });
  // Unchanged legacy semantics: the re-splice reuses every other line's audio.
  const stitch = await stitchFinalEpisodeAudio({ scriptId });
  return { mode: "legacy_line" as const, tts, stitch };
}
