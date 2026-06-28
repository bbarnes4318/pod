// Standalone Queue Worker for Take Machine
import "dotenv/config";
import { Worker, Job } from "bullmq";
import { getRedisClient } from "../redis";
import { JobData } from "./podcastQueue";

const QUEUE_NAME = "podcast-generation";

console.log("--------------------------------------------------");
console.log("TAKE MACHINE WORKER - INITIALIZING");
console.log(`Redis Connection: ${process.env.REDIS_URL || "redis://localhost:6379"}`);
console.log(`Queue Name: ${QUEUE_NAME}`);
console.log("--------------------------------------------------");

// Initialize BullMQ Worker
const worker = new Worker(
  QUEUE_NAME,
  async (job: Job<JobData>) => {
    const { episodeId, stage } = job.data;
    console.log(`[Worker] Job ${job.id} [${job.name}] started for Episode ID: ${episodeId}, Stage: ${stage}`);

    // Placeholder step execution simulating the pipeline
    switch (stage) {
      case "fetch-sports":
        console.log("[Worker] Stage: Fetching sports Talking Points & scoring them...");
        await simulateProgress(1000);
        break;
      case "generate-script":
        console.log("[Worker] Stage: Generating debate script for Max Voltage and Dr. Linebreak...");
        await simulateProgress(1500);
        break;
      case "generate-audio":
        console.log("[Worker] Stage: Converting script lines to TTS audio segments...");
        await simulateProgress(2000);
        break;
      case "stitch-audio":
        console.log("[Worker] Stage: Stitching audio segments with FFmpeg into final MP3...");
        await simulateProgress(1000);
        break;
      case "publish":
        console.log("[Worker] Stage: Finalizing metadata and updating RSS feed...");
        await simulateProgress(800);
        break;
      default:
        console.log(`[Worker] Unknown stage: ${stage}. Running generic processing...`);
        await simulateProgress(1000);
    }

    console.log(`[Worker] Job ${job.id} completed successfully!`);
    return { success: true, processedStage: stage, episodeId };
  },
  {
    connection: getRedisClient() as any,
    concurrency: 2, // Allow processing up to 2 jobs concurrently
  }
);

// Worker Event Listeners
worker.on("active", (job) => {
  console.log(`[Worker] Job ${job.id} became active`);
});

worker.on("completed", (job, result) => {
  console.log(`[Worker] Job ${job.id} completed. Result:`, result);
});

worker.on("failed", (job, err) => {
  console.error(`[Worker] Job ${job?.id} failed with error:`, err.message);
});

worker.on("error", (err) => {
  console.error("[Worker] Global worker error occurred:", err);
});

// Helper function to simulate background processing delay
function simulateProgress(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Graceful Shutdown
const shutdown = async (signal: string) => {
  console.log(`[Worker] Received ${signal}. Closing queue worker...`);
  await worker.close();
  console.log("[Worker] Queue worker closed. Exiting process.");
  process.exit(0);
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
