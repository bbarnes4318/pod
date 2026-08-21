import { Queue } from "bullmq";
import { getRedisClient } from "../redis";
import { db } from "../db";
import type { TtsVoiceOverrides } from "../providers/tts/voiceResolution";
import type { EpisodeBuildInput } from "../services/episodeService";
import { scriptJobIsInFlight, scriptQueueIdentity } from "./scriptQueueIdentity";
import { assertScriptReleasableForProduction } from "./productionGuard";

export const BACKGROUND_QUEUE_NAME = "podcast-generation";
export const PRODUCTION_QUEUE_NAME = "podcast-production";

const sharedJobOptions = {
  attempts: 3,
  backoff: {
    type: "exponential" as const,
    delay: 5000,
  },
  removeOnComplete: true,
  removeOnFail: false,
};

// Reuse global clients to prevent connection exhaustion in Next.js HMR dev mode.
const globalForQueue = globalThis as unknown as {
  podcastQueue: Queue | undefined;
  productionQueue: Queue | undefined;
};

// Scheduled ingestion, topic generation, and research only. Slow provider calls
// on this queue must never prevent a Studio production action from starting.
export const podcastQueue =
  globalForQueue.podcastQueue ??
  new Queue(BACKGROUND_QUEUE_NAME, {
    connection: getRedisClient() as any,
    defaultJobOptions: sharedJobOptions,
  });

// Interactive and publishable episode work has an independent worker lane.
// A 15-minute research timeout can no longer starve script, fact-check, TTS,
// mixing, content, or line-regeneration jobs submitted from Studio.
export const productionQueue =
  globalForQueue.productionQueue ??
  new Queue(PRODUCTION_QUEUE_NAME, {
    connection: getRedisClient() as any,
    defaultJobOptions: sharedJobOptions,
  });

if (process.env.NODE_ENV !== "production") {
  globalForQueue.podcastQueue = podcastQueue;
  globalForQueue.productionQueue = productionQueue;
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
  opts?: { jobId?: string; delay?: number }
) {
  // A deterministic jobId makes the enqueue idempotent (used by the scheduled
  // daily topic-generation tick); manual admin triggers pass no jobId.
  const jobOptions = {
    ...(opts?.jobId ? { jobId: opts.jobId } : {}),
    ...(typeof opts?.delay === "number" && opts.delay > 0 ? { delay: opts.delay } : {}),
  };
  return podcastQueue.add(
    "generate:topics",
    data,
    Object.keys(jobOptions).length > 0 ? jobOptions : undefined
  );
}

export interface ResearchBriefJobData {
  topicId: string;
  forceRegenerate?: boolean;
}

export async function queueResearchBriefGenerationJob(
  data: ResearchBriefJobData,
  opts?: { jobId?: string; priority?: number; delayMs?: number }
) {
  // A deterministic jobId makes the enqueue idempotent: BullMQ ignores a second
  // add with the same id, so an operator double-clicking "Start research"
  // cannot queue the same expensive LLM run twice.
  const jobOptions = {
    ...(opts?.jobId ? { jobId: opts.jobId } : {}),
    ...(typeof opts?.priority === "number" ? { priority: opts.priority } : {}),
    // Spacing, not throttling: every job still runs, it just does not start in
    // the same second as its siblings. See staggerDelayMs() at the call site.
    ...(typeof opts?.delayMs === "number" && opts.delayMs > 0 ? { delay: Math.round(opts.delayMs) } : {}),
  };
  return podcastQueue.add(
    "generate:research-brief",
    data,
    Object.keys(jobOptions).length > 0 ? jobOptions : undefined
  );
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
  return productionQueue.add("build:episode", data, opts?.jobId ? { jobId: opts.jobId } : undefined);
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
  /** Deterministic BullMQ id persisted into both submission and running logs. */
  queueJobId?: string;
  /** Immutable audit row written the instant Studio submits the job. */
  submissionLogId?: string;
  /** Script version this click requested based on the database at submission. */
  targetVersion?: number;
}

/**
 * Submit one traceable, idempotent script generation request.
 *
 * Previously the only JobLog row was created INSIDE the worker handler. With a
 * one-slot production worker, a newly-clicked episode therefore vanished until
 * every older job ahead of it finished; the first visible row belonged to that
 * older episode and looked like an episode-id mix-up. We now write a durable
 * `submitted` audit row before adding to Redis and use a deterministic BullMQ
 * id per episode/target version so repeat clicks reuse the same in-flight job.
 *
 * The worker still writes its normal `running` row when it becomes active. Both
 * rows carry queueJobId/targetVersion, so the handoff is explicit without a
 * schema migration or a risky rewrite of the large worker module.
 */
export async function queueScriptGenerationJob(data: ScriptGenJobData) {
  const latest = await db.script.findFirst({
    where: { episodeId: data.episodeId },
    orderBy: { version: "desc" },
    select: { version: true },
  });
  const identity = scriptQueueIdentity(data.episodeId, (latest?.version ?? 0) + 1);

  // A second click for the same not-yet-written version must not create another
  // expensive job or another misleading log row.
  const existing = await productionQueue.getJob(identity.jobId);
  if (existing) {
    const state = await existing.getState();
    if (scriptJobIsInFlight(state)) return existing;
    // Failed jobs are retained by policy. Remove the terminal record so an
    // explicit retry can reuse the same deterministic identity.
    try {
      await existing.remove();
    } catch {
      const current = await existing.getState();
      if (scriptJobIsInFlight(current)) return existing;
      throw new Error(`Could not clear terminal production script job ${identity.jobId} (state: ${current}).`);
    }
  }

  // Adoption bridge: releases before production-queue isolation placed Studio
  // script jobs on the background queue. If that legacy job is already active,
  // let it finish. Otherwise remove it before submitting the same deterministic
  // identity to the production lane, so it cannot execute hours later and
  // generate a duplicate script version.
  const legacy = await podcastQueue.getJob(identity.jobId);
  if (legacy) {
    const state = await legacy.getState();
    if (state === "active") return legacy;
    try {
      await legacy.remove();
    } catch {
      const current = await legacy.getState();
      if (current === "active") return legacy;
      throw new Error(`Could not migrate legacy script job ${identity.jobId} (state: ${current}).`);
    }
  }

  const payload: ScriptGenJobData = {
    ...data,
    queueJobId: identity.jobId,
    submissionLogId: identity.submissionLogId,
    targetVersion: identity.targetVersion,
  };
  const submittedAt = new Date();

  // `submitted` is an immutable enqueue event, not a claim that the worker has
  // started. Once active, the worker creates a newer `running` row carrying the
  // same queueJobId, so global Job Logs can no longer confuse queue order with
  // episode identity.
  await db.jobLog.upsert({
    where: { id: identity.submissionLogId },
    create: {
      id: identity.submissionLogId,
      jobType: "generate:script",
      status: "submitted",
      input: payload as any,
      output: { queueJobId: identity.jobId, targetVersion: identity.targetVersion } as any,
      createdAt: submittedAt,
    },
    update: {
      status: "submitted",
      input: payload as any,
      output: { queueJobId: identity.jobId, targetVersion: identity.targetVersion } as any,
      error: null,
      createdAt: submittedAt,
    },
  });

  try {
    return await productionQueue.add("generate:script", payload, { jobId: identity.jobId });
  } catch (error) {
    await db.jobLog.update({
      where: { id: identity.submissionLogId },
      data: {
        status: "failed",
        error: `Queue submission failed: ${error instanceof Error ? error.message : String(error)}`,
      },
    }).catch(() => undefined);
    throw error;
  }
}

export interface FactCheckJobData {
  scriptId: string;
  forceRecheck?: boolean;
}

export async function queueFactCheckJob(data: FactCheckJobData) {
  return productionQueue.add("fact-check:script", data);
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
  // Editorial enforcement happens HERE, not at the call sites. See
  // ./productionGuard for why. Throws ProductionHoldError when the script's
  // recorded verdict is anything other than `pass` without a human release.
  await assertScriptReleasableForProduction(data.scriptId, "tts:generate-segments");
  return productionQueue.add("tts:generate-segments", data);
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
  await assertScriptReleasableForProduction(data.scriptId, "audio:stitch-final");
  return productionQueue.add("audio:stitch-final", data);
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
  return productionQueue.add("content:generate-assets", data);
}

// Auto social clip render. Carries the SocialClip row id; the handler renders
// the clip audio from the real per-line AudioSegments and attempts a 9:16
// captioned mp4, then writes the URLs back onto the row.
export interface SocialClipJobData {
  clipId: string;
}

export async function queueSocialClipJob(data: SocialClipJobData) {
  return productionQueue.add("social-clip:generate", data, {
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
  return productionQueue.add("audio:regenerate-line", data, {
    jobId: `line-regen-${data.scriptId}-${data.lineIndex}`,
  });
}
