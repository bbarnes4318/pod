"use server";

import { requireAdmin } from "@/lib/adminAuth";
import { db } from "@/lib/db";
import { queueEpisodeBuildJob, queueScriptGenerationJob } from "@/lib/queue/podcastQueue";
import { EpisodeBuildInput } from "@/lib/services/episodeService";
import { createEpisodeDraft } from "@/lib/services/episodeCreation";
import { revalidatePath } from "next/cache";

export async function triggerEpisodeBuild(input: EpisodeBuildInput) {
  await requireAdmin();
  try {
    // Submit the BullMQ building job
    const job = await queueEpisodeBuildJob({
      title: input.title,
      description: input.description,
      topicIds: input.topicIds,
      leagueId: input.leagueId,
      sport: input.sport,
      targetTopicCount: input.targetTopicCount,
      minDebateScore: input.minDebateScore,
      hostIds: input.hostIds,
      ttsProvider: input.ttsProvider,
      ttsVoiceOverrides: input.ttsVoiceOverrides,
      productionStyle: input.productionStyle,
      sfxDensity: input.sfxDensity,
    });

    revalidatePath("/admin/episodes");
    return { success: true, jobId: job.id };
  } catch (err: any) {
    return { success: false, error: err.message || "Failed to trigger episode build." };
  }
}

export async function createEpisodeFromSelectedTopics(
  topicIds: string[],
  title?: string,
  description?: string,
  ttsProvider?: string,
  ttsVoiceOverrides?: EpisodeBuildInput["ttsVoiceOverrides"],
  productionStyle?: string,
  sfxDensity?: string,
  hostIds?: string[]
) {
  await requireAdmin();
  try {
    const res = await createEpisodeDraft({
      mode: "manual",
      selectedTopicIds: topicIds,
      strictSelection: true,
      title,
      description,
      hostIds,
      ttsProvider,
      ttsVoiceOverrides,
      productionStyle,
      sfxDensity,
    });
    if (!res.ok) return { success: false, error: res.error || "Failed to build episode from selected topics." };

    revalidatePath("/admin/episodes");
    return { success: true, episodeId: res.episodeId };
  } catch (err: any) {
    return { success: false, error: err.message || "Failed to build episode from selected topics." };
  }
}

/** Every ACTIVE host, for the episode host picker + voice pickers. No name
 *  filter — whoever the operator has activated on /admin/personalities is
 *  castable. Ordered most-intense first so the default pair keeps the
 *  emotional-vs-analytical framing. */
export async function fetchActiveDebateHosts() {
  await requireAdmin();
  try {
    const hosts = await db.aiHost.findMany({
      where: { isActive: true, isArchived: false },
      orderBy: [{ intensityLevel: "desc" }, { name: "asc" }],
    });
    return {
      success: true,
      hosts: hosts.map((h) => ({
        id: h.id,
        name: h.name,
        slug: h.slug,
        ttsProvider: h.ttsProvider,
        ttsVoiceId: h.ttsVoiceId,
      })),
    };
  } catch (err: any) {
    return { success: false, error: err.message || "Failed to fetch hosts.", hosts: [] };
  }
}

export async function updateEpisodeMetadata(episodeId: string, title: string, description: string) {
  await requireAdmin();
  try {
    await db.episode.update({
      where: { id: episodeId },
      data: {
        title: title.trim(),
        description: description.trim() || null,
      },
    });

    revalidatePath("/admin/episodes");
    revalidatePath(`/admin/episodes/${episodeId}`);
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message || "Failed to update episode metadata." };
  }
}

export async function deleteDraftEpisode(episodeId: string) {
  await requireAdmin();
  try {
    const ep = await db.episode.findUnique({
      where: { id: episodeId },
      include: { topics: true },
    });

    if (!ep) {
      throw new Error(`Episode with ID ${episodeId} not found.`);
    }

    if (ep.status !== "draft") {
      throw new Error(`Only draft episodes can be deleted. Current status: ${ep.status}`);
    }

    // Atomic transaction for deleting and reverting topic candidate statuses
    await db.$transaction(async (tx) => {
      for (const et of ep.topics) {
        // Revert topic candidate status from used back to approved only if it is not linked to any other episode
        const linkCount = await tx.episodeTopic.count({
          where: {
            topicId: et.topicId,
            NOT: { episodeId },
          },
        });

        if (linkCount === 0) {
          await tx.topicCandidate.update({
            where: { id: et.topicId },
            data: { status: "approved" },
          });
        }
      }

      // Delete EpisodeTopic relations
      await tx.episodeTopic.deleteMany({
        where: { episodeId },
      });

      // Delete Episode
      await tx.episode.delete({
        where: { id: episodeId },
      });
    });

    revalidatePath("/admin/episodes");
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message || "Failed to delete draft episode." };
  }
}

export async function fetchEligibleTopics(filters: {
  leagueId?: string;
  sport?: string;
  minDebateScore?: number;
}) {
  await requireAdmin();
  try {
    const minScore = filters.minDebateScore !== undefined ? Number(filters.minDebateScore) : 70;
    const where: any = {
      status: "approved",
      debateScore: { gte: minScore },
      researchBrief: { isNot: null },
    };

    if (filters.leagueId) {
      where.leagueId = filters.leagueId.toUpperCase();
    }
    if (filters.sport) {
      where.sport = { equals: filters.sport, mode: "insensitive" };
    }

    const topics = await db.topicCandidate.findMany({
      where,
      include: { researchBrief: true },
      orderBy: { debateScore: "desc" },
    });

    // Enforce strict ResearchBrief validations on facts, sourceIds, host arguments
    const qualified = topics.filter((t) => {
      const brief = t.researchBrief;
      if (!brief) return false;
      
      const facts = Array.isArray(brief.facts) ? brief.facts : [];
      if (facts.length === 0) return false;

      const sourceIds = Array.isArray(brief.sourceIds) ? brief.sourceIds : [];
      if (sourceIds.length === 0) return false;

      if (!brief.argumentForHostA?.trim() || !brief.argumentForHostB?.trim()) return false;

      return true;
    });

    return {
      success: true,
      topics: qualified.map((t) => ({
        id: t.id,
        title: t.title,
        sport: t.sport,
        leagueId: t.leagueId,
        debateScore: t.debateScore,
        evidenceCount: Array.isArray(t.evidenceIds) ? t.evidenceIds.length : 0,
      })),
    };
  } catch (err: any) {
    return { success: false, error: err.message || "Failed to fetch eligible topics." };
  }
}

export async function triggerScriptGeneration(episodeId: string, forceRegenerate?: boolean) {
  await requireAdmin();
  try {
    const job = await queueScriptGenerationJob({
      episodeId,
      forceRegenerate: !!forceRegenerate,
    });

    revalidatePath(`/admin/episodes/${episodeId}`);
    return { success: true, jobId: job.id };
  } catch (err: any) {
    return { success: false, error: err.message || "Failed to queue script generation." };
  }
}

export async function fetchEpisodeScripts(episodeId: string) {
  await requireAdmin();
  try {
    const scripts = await db.script.findMany({
      where: { episodeId },
      orderBy: { version: "desc" },
    });

    return {
      success: true,
      scripts: scripts.map((s) => ({
        id: s.id,
        version: s.version,
        status: s.status,
        plainText: s.plainText,
        createdAt: s.createdAt.toISOString(),
      })),
    };
  } catch (err: any) {
    return { success: false, error: err.message || "Failed to fetch scripts." };
  }
}
