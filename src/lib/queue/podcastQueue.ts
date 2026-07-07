import { Queue } from "bullmq";
import { getRedisClient } from "../redis";
import type { TtsVoiceOverrides } from "../providers/tts/voiceResolution";

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

export async function queueIngestionJob(data: IngestJobData) {
  // Use a deterministic jobId if appropriate, or let BullMQ generate one
  return podcastQueue.add("ingest:sports-data", data);
}

export interface TopicGenJobData {
  leagueId: string;
  sport: string;
  minScore: number;
}

export async function queueTopicGenerationJob(data: TopicGenJobData) {
  return podcastQueue.add("generate:topics", data);
}

export interface ResearchBriefJobData {
  topicId: string;
  forceRegenerate?: boolean;
}

export async function queueResearchBriefGenerationJob(data: ResearchBriefJobData) {
  return podcastQueue.add("generate:research-brief", data);
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
}

export async function queueEpisodeBuildJob(data: EpisodeBuildJobData, opts?: { jobId?: string }) {
  // A deterministic jobId makes the enqueue idempotent: BullMQ ignores a
  // second add with the same id (used by the recurring scheduler).
  return podcastQueue.add("build:episode", data, opts?.jobId ? { jobId: opts.jobId } : undefined);
}

export interface ScriptGenJobData {
  episodeId: string;
  forceRegenerate?: boolean;
  scriptStyle?: "heated-debate" | "balanced-analysis" | "sports-radio";
  targetDurationMinutes?: number;
  maxWords?: number;
}

export async function queueScriptGenerationJob(data: ScriptGenJobData) {
  return podcastQueue.add("generate:script", data);
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

