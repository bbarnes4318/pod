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
    const triggeredAt = new Date().toISOString();
    const job = await queueTopicGenerationJob({
      leagueId: params.leagueId,
      sport: params.sport,
      minScore: Number(params.minScore) || 50,
    });

    revalidatePath("/admin/topics");
    // triggeredAt lets the client poll for THIS run's real JobLog result
    // (see fetchLatestTopicGenerationLog) instead of assuming success.
    return { success: true, jobId: job.id, triggeredAt };
  } catch (err: any) {
    return { success: false, error: err.message || "Failed to trigger topic generation." };
  }
}

export interface TopicGenerationLog {
  id: string;
  status: string; // "running" | "completed" | "failed"
  createdAt: string;
  error: string | null;
  output: Record<string, any> | null;
}

/**
 * Return the most recent `generate:topics` JobLog so the UI can surface the
 * REAL outcome of a generation run — including the case where the job completes
 * "successfully" but inserted zero rows (no evidence, sport/league mismatch,
 * below-threshold, etc.). A green job that produced nothing must not look like
 * success, so the client reads insertedCount / noEvidenceCount /
 * skippedRecordsReasonSummary straight from this output.
 */
export async function fetchLatestTopicGenerationLog(): Promise<
  { success: true; log: TopicGenerationLog | null } | { success: false; error: string }
> {
  await requireAdmin();
  try {
    const log = await db.jobLog.findFirst({
      where: { jobType: "generate:topics" },
      orderBy: { createdAt: "desc" },
    });
    if (!log) return { success: true, log: null };
    return {
      success: true,
      log: {
        id: log.id,
        status: log.status,
        createdAt: log.createdAt.toISOString(),
        error: log.error ?? null,
        output: (log.output as Record<string, any>) ?? null,
      },
    };
  } catch (err: any) {
    return { success: false, error: err.message || "Failed to fetch generation log." };
  }
}
