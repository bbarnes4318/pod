"use server";

import { queuePodcastJob } from "@/lib/queue/podcastQueue";

export async function triggerPodcastJob(episodeId: string) {
  try {
    const job = await queuePodcastJob(episodeId, "fetch-sports");
    return { success: true, jobId: job.id };
  } catch (err: any) {
    console.error("[Actions] Failed to queue job in Redis:", err);
    return { 
      success: false, 
      error: err.message || "Redis connection failed. Ensure Redis is running." 
    };
  }
}
