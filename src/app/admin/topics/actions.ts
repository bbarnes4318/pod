"use server";

import { requireAdmin } from "@/lib/adminAuth";
import { db } from "@/lib/db";
import { queueTopicGenerationJob } from "@/lib/queue/podcastQueue";
import { revalidatePath } from "next/cache";

export async function approveTopic(id: string) {
  await requireAdmin();
  try {
    await db.topicCandidate.update({
      where: { id },
      data: { status: "approved" },
    });
    revalidatePath("/admin/topics");
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message || "Failed to approve topic" };
  }
}

export async function rejectTopic(id: string) {
  await requireAdmin();
  try {
    await db.topicCandidate.update({
      where: { id },
      data: { status: "rejected" },
    });
    revalidatePath("/admin/topics");
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message || "Failed to reject topic" };
  }
}

export async function resetTopicToPending(id: string) {
  await requireAdmin();
  try {
    await db.topicCandidate.update({
      where: { id },
      data: { status: "pending" },
    });
    revalidatePath("/admin/topics");
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message || "Failed to reset topic status" };
  }
}

export async function fetchTopicStats() {
  await requireAdmin();
  try {
    const games = await db.game.count();
    const news = await db.newsItem.count();
    const injuries = await db.injury.count();
    const odds = await db.oddsSnapshot.count();
    const teamStats = await db.teamStat.count();
    const playerStats = await db.playerStat.count();
    const evidenceCount = games + news + injuries + odds + teamStats + playerStats;

    const pendingCount = await db.topicCandidate.count({ where: { status: "pending" } });
    const approvedCount = await db.topicCandidate.count({ where: { status: "approved" } });
    const rejectedCount = await db.topicCandidate.count({ where: { status: "rejected" } });

    return {
      success: true,
      stats: { evidenceCount, pendingCount, approvedCount, rejectedCount },
    };
  } catch (err: any) {
    return { success: false, error: err.message || "Failed to fetch stats" };
  }
}

interface GenerateParams {
  leagueId: string;
  sport: string;
  minScore: number;
}

export async function triggerTopicGeneration(params: GenerateParams) {
  await requireAdmin();
  try {
    // 1. Guard against stub LLM provider
    if (process.env.LLM_PROVIDER?.toLowerCase() === "stub" || !process.env.LLM_PROVIDER) {
      throw new Error("LLM provider is stub. Real topic generation disabled.");
    }

    // 2. Guard against missing database evidence
    const games = await db.game.count();
    const news = await db.newsItem.count();
    const injuries = await db.injury.count();
    const odds = await db.oddsSnapshot.count();
    const teamStats = await db.teamStat.count();
    const playerStats = await db.playerStat.count();
    const totalEvidence = games + news + injuries + odds + teamStats + playerStats;

    if (totalEvidence === 0) {
      throw new Error("No real sports evidence available. Ingest real sports data before generating topics.");
    }

    // 3. Queue BullMQ generation job
    const job = await queueTopicGenerationJob({
      leagueId: params.leagueId,
      sport: params.sport,
      minScore: Number(params.minScore) || 50,
    });

    revalidatePath("/admin/topics");
    return { success: true, jobId: job.id };
  } catch (err: any) {
    return { success: false, error: err.message || "Failed to trigger topic generation." };
  }
}
