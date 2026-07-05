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
  ttsProvider?: string;
  ttsVoiceOverrides?: TtsVoiceOverrides;
}

export async function queueEpisodeBuildJob(data: EpisodeBuildJobData) {
  return podcastQueue.add("build:episode", data);
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

