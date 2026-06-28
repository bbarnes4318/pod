import { Queue } from "bullmq";
import { getRedisClient } from "../redis";

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
