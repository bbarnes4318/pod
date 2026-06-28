"use server";

import { db } from "@/lib/db";
import { queueResearchBriefGenerationJob } from "@/lib/queue/podcastQueue";
import { revalidatePath } from "next/cache";

export async function triggerResearchBriefGeneration(topicId: string, forceRegenerate = false) {
  try {
    // 1. Guard against stub LLM provider
    if (process.env.LLM_PROVIDER?.toLowerCase() === "stub" || !process.env.LLM_PROVIDER) {
      throw new Error("LLM provider is stub. Real research brief generation disabled.");
    }

    // 2. Load TopicCandidate and enforce approved status guard
    const topic = await db.topicCandidate.findUnique({
      where: { id: topicId },
    });

    if (!topic) {
      throw new Error(`TopicCandidate with ID ${topicId} not found.`);
    }

    if (topic.status !== "approved") {
      throw new Error(`TopicCandidate must be approved before generating a brief. Current status: ${topic.status}`);
    }

    // 3. Queue BullMQ generation job
    const job = await queueResearchBriefGenerationJob({
      topicId,
      forceRegenerate,
    });

    revalidatePath("/admin/research-briefs");
    return { success: true, jobId: job.id };
  } catch (err: any) {
    return { success: false, error: err.message || "Failed to trigger research brief generation." };
  }
}

export async function deleteResearchBrief(id: string) {
  try {
    await db.researchBrief.delete({
      where: { id },
    });
    revalidatePath("/admin/research-briefs");
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message || "Failed to delete research brief." };
  }
}
