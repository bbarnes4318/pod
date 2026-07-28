import { Queue } from "bullmq";
import { db } from "../db";
import { getRedisClient } from "../redis";
import type { TtsVoiceOverrides } from "../providers/tts/voiceResolution";
import type { EpisodeBuildInput } from "../services/episodeService";
import {
  SCRIPT_JOB_TYPE,
  canUpdateQueuedScriptJob,
  isPendingScriptJobState,
  scriptGenerationJobId,
} from "./scriptJobTracking";

const QUEUE_NAME = "podcast-generation";

// Reuse global client to prevent connection exhaustion in Next.js HMR dev mode
const globalForQueue = globalThis as unknown as {
  podcastQueue: Queue | undefined;
};

export const podcastQueue =
  globalForQueue.podcastQueue ??
  new Queue(QUEUE_NAME, {
    connection: getRedisClient() as any,
    defaultJobOptions: {
      attempts: 3,
      backoff: {
        type: "exponential",
        delay: 5000,
      },
      removeOnComplete: true,
      removeOnFail: false,
    },
  });

if (process.env.NODE_ENV !== "production") {
  globalForQueue.podcastQueue = podcastQueue;
}

export interface JobData {
  episodeId: string;
  stage?: "fetch-sports" | "generate-script" | "generate-audio" | "stitch-audio" | "publish";
}

export async function queuePodcastJob(episodeId: string, stage: JobData["stage"] = "fetch-sports") {
  return podcastQueue.add(
    "generate-podcast",
    { episodeId, stage },
    {
      jobId: `episode-${episodeId}-${stage}`, // Avoid duplicates for the same stage
    }
  );
}

export interface IngestJobData {
  providerType: string;
  leagueId: string;
  sport: string;
  dateOrRange: string;
}

export async function queueIngestionJob(
  data: IngestJobData,
  opts?: { jobId?: string; delayMs?: number }
) {
  // A deterministic jobId makes the enqueue idempotent (used by the scheduled
  // ingest fan-out); delayMs lets the odds job run after the games it matches.
  const jobOpts: { jobId?: string; delay?: number } = {};
  if (opts?.jobId) jobOpts.jobId = opts.jobId;
  if (opts?.delayMs && opts.delayMs > 0) jobOpts.delay = opts.delayMs;
  return podcastQueue.add("ingest:sports-data", data, Object.keys(jobOpts).length ? jobOpts : undefined);
}

export interface TopicGenJobData {
  leagueId: string;
  sport: string;
  minScore: number;
}

export async function queueTopicGenerationJob(
  data: TopicGenJobData,
  opts?: { jobId?: string }
) {
  // A deterministic jobId makes the enqueue idempotent (used by the scheduled
  // daily topic-generation tick); manual admin triggers pass no jobId.
  return podcastQueue.add("generate:topics", data, opts?.jobId ? { jobId: opts.jobId } : undefined);
}

export interface ResearchBriefJobData {
  topicId: string;
  forceRegenerate?: boolean;
}

export async function queueResearchBriefGenerationJob(data: ResearchBriefJobData, opts?: { jobId?: string }) {
  // A deterministic jobId makes the enqueue idempotent: BullMQ ignores a second
  // add with the same id, so an operator double-clicking "Start research"
  // cannot queue the same expensive LLM run twice.
  return podcastQueue.add("generate:research-brief", data, opts?.jobId ? { jobId: opts.jobId } : undefined);
}

export interface EpisodeBuildJobData {
  title?: string;
  description?: string;
  topicIds?: string[];
  leagueId?: string;
  sport?: string;
  targetTopicCount?: number;
  minDebateScore?: number;
  podcastId?: string;
  leagueIds?: string[];
  verticals?: string[];
  teamNames?: string[];
  hostIds?: string[];
  /** User.id of the creator; persisted as Episode.ownerId (null for
   *  scheduler/system builds). */
  ownerId?: string;
  ttsProvider?: string;
  ttsVoiceOverrides?: TtsVoiceOverrides;
  productionStyle?: string;
  sfxDensity?: string;
  /** Authorized exclude_podcast reuse override (admin/system enqueuers only). */
  reuseOverride?: boolean;
}

export async function queueEpisodeBuildJob(data: EpisodeBuildJobData, opts?: { jobId?: string }) {
  // A deterministic jobId makes the enqueue idempotent: BullMQ ignores a
  // second add with the same id (used by the recurring scheduler).
  return podcastQueue.add("build:episode", data, opts?.jobId ? { jobId: opts.jobId } : undefined);
}

/** Every EpisodeBuildInput field a build job carries — the single source of
 *  truth the mapper and its contract test both check against. */
export const EPISODE_BUILD_JOB_FIELDS = [
  "title",
  "description",
  "topicIds",
  "leagueId",
  "sport",
  "targetTopicCount",
  "minDebateScore",
  "podcastId",
  "leagueIds",
  "verticals",
  "teamNames",
  "hostIds",
  "ownerId",
  "ttsProvider",
  "ttsVoiceOverrides",
  "productionStyle",
  "sfxDensity",
  "reuseOverride",
] as const;

/**
 * Map an accepted `EpisodeBuildInput` to the queue job payload, forwarding
 * EVERY supported field. Centralizing this stops a queue action from
 * hand-assembling a partial payload and silently dropping fields like
 * podcastId / ownerId / leagueIds / verticals / teamNames / reuseOverride.
 * Undefined values are omitted so a deterministic jobId stays stable.
 */
export function toEpisodeBuildJobData(input: EpisodeBuildInput): EpisodeBuildJobData {
  const data: EpisodeBuildJobData = {};
  for (const field of EPISODE_BUILD_JOB_FIELDS) {
    const value = input[field];
    if (value !== undefined) {
      // Each field's type lines up 1:1 between the two interfaces.
      (data as Record<string, unknown>)[field] = value;
    }
  }
  return data;
}

export interface ScriptGenJobData {
  episodeId: string;
  forceRegenerate?: boolean;
  scriptStyle?: "heated-debate" | "balanced-analysis" | "sports-radio";
  targetDurationMinutes?: number;
  maxWords?: number;
}

/**
 * Queue script generation with an identity the operator can see immediately.
 *
 * Previous behavior created JobLog only inside the worker. Production runs with
 * concurrency=1 therefore left every waiting script completely invisible while
 * an older job appeared to be the "new" one. We now:
 *   1. coalesce duplicate requests for the same episode;
 *   2. update the payload while a request is still waiting;
 *   3. create a queued JobLog before returning to the UI; and
 *   4. turn an enqueue failure into a visible failed row.
 */
export async function queueScriptGenerationJob(data: ScriptGenJobData) {
  const jobId = scriptGenerationJobId(data.episodeId);
  const existing = await podcastQueue.getJob(jobId);

  if (existing) {
    const state = await existing.getState();
    if (isPendingScriptJobState(state)) {
      if (canUpdateQueuedScriptJob(state)) {
        await existing.updateData(data);
      }
      return existing;
    }

    // removeOnFail=false intentionally preserves terminal failures for diagnosis.
    // A deliberate retry must remove that terminal BullMQ record before reusing
    // the per-episode id.
    try {
      await existing.remove();
    } catch (err) {
      const currentState = await existing.getState().catch(() => state);
      if (isPendingScriptJobState(currentState)) return existing;
      throw err;
    }
  }

  const queuedAt = new Date().toISOString();
  const queuedLog = await db.jobLog.create({
    data: {
      jobType: SCRIPT_JOB_TYPE,
      status: "queued",
      input: { ...data, queueJobId: jobId, queuedAt } as any,
      output: { queueJobId: jobId, queueState: "queued" } as any,
    },
  });

  try {
    return await podcastQueue.add(SCRIPT_JOB_TYPE, data, { jobId });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown queue error";
    await db.jobLog.update({
      where: { id: queuedLog.id },
      data: {
        status: "failed",
        error: `Script generation could not be queued: ${message}`,
        output: { queueJobId: jobId, queueState: "enqueue_failed" } as any,
      },
    });
    throw err;
  }
}

export interface FactCheckJobData {
  scriptId: string;
  forceRecheck?: boolean;
}

export async function queueFactCheckJob(data: FactCheckJobData) {
  return podcastQueue.add("fact-check:script", data);
}

export interface TtsSegmentJobData {
  scriptId: string;
  forceRegenerate?: boolean;
  segmentRange?: {
    startLineIndex: number;
    endLineIndex: number;
  };
  hostId?: string;
  providerOverride?: string;
  voiceOverrides?: TtsVoiceOverrides;
}

export async function queueTtsSegmentGenerationJob(data: TtsSegmentJobData) {
  return podcastQueue.add("tts:generate-segments", data);
}

export interface FinalAudioStitchJobData {
  scriptId: string;
  forceRegenerate?: boolean;
  includeIntro?: boolean;
  includeOutro?: boolean;
  normalizeAudio?: boolean;
  targetLufs?: number;
  /** Post-production depth: "clean" | "light" | "full". */
  productionStyle?: string;
  /** Reaction-SFX density: "subtle" | "medium" | "hype". */
  sfxDensity?: string;
}

export async function queueFinalAudioStitchJob(data: FinalAudioStitchJobData) {
  return podcastQueue.add("audio:stitch-final", data);
}

export interface ContentAssetJobData {
  scriptId: string;
  forceRegenerate?: boolean;
  includeChapters?: boolean;
  includeMarkdown?: boolean;
  includeJson?: boolean;
  providerOverride?: string;
}

export async function queueContentAssetGenerationJob(data: ContentAssetJobData) {
  return podcastQueue.add("content:generate-assets", data);
}

// Auto social clip render. Carries the SocialClip row id; the handler renders
// the clip audio from the real per-line AudioSegments and attempts a 9:16
// captioned mp4, then writes the URLs back onto the row.
export interface SocialClipJobData {
  clipId: string;
}

export async function queueSocialClipJob(data: SocialClipJobData) {
  return podcastQueue.add("social-clip:generate", data, {
    jobId: `social-clip-${data.clipId}`,
  });
}

export interface LineAudioRegenJobData {
  scriptId: string;
  /** The single script line to re-voice. */
  lineIndex: number;
}

/**
 * Line-level audio regeneration: re-synthesize ONE line's TTS and re-splice the
 * episode. The handler runs the existing per-line TTS (segmentRange = just this
 * line) and then the existing stitcher, which reuses every OTHER line's already
 * synthesized audio — so a one-line change costs one line of TTS, not a full
 * episode re-render. jobId is per (script,line) so rapid re-clicks coalesce.
 */
export async function queueLineAudioRegenJob(data: LineAudioRegenJobData) {
  return podcastQueue.add("audio:regenerate-line", data, {
    jobId: `line-regen-${data.scriptId}-${data.lineIndex}`,
  });
}
