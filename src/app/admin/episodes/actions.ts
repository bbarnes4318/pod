"use server";

import { requireAdmin, adminIdentity } from "@/lib/adminAuth";
import { db } from "@/lib/db";
import { Prisma } from "@prisma/client";
import { queueEpisodeBuildJob, toEpisodeBuildJobData, queueScriptGenerationJob } from "@/lib/queue/podcastQueue";
import { EpisodeBuildInput } from "@/lib/services/episodeService";
import { createEpisodeDraft } from "@/lib/services/episodeCreation";
import { revalidatePath } from "next/cache";

/**
 * Trigger an episode build. ADMIN-ONLY (requireAdmin). Forwards EVERY supported
 * field through the validated mapper — nothing is hand-dropped. The
 * `reuseOverride` flag (bypass the exclude_podcast recent-use guard for a
 * pinned topic) is an ADMIN capability: it is only honored here, behind
 * requireAdmin, and is audit-logged. Ordinary /app + /studio actions never
 * accept it, and the service never treats a direct call as authorization.
 */
export async function triggerEpisodeBuild(
  input: EpisodeBuildInput,
  opts?: { reuseOverrideReason?: string }
) {
  await requireAdmin();
  try {
    // Authorization for the override lives HERE (server-side requireAdmin), not
    // in any client-supplied role/flag. Audit it before enqueuing.
    if (input.reuseOverride) {
      await logReuseOverride({
        admin: adminIdentity(),
        podcastId: input.podcastId ?? null,
        topicIds: input.topicIds ?? [],
        reason: opts?.reuseOverrideReason ?? null,
      });
    }

    // Validated mapper forwards podcastId/ownerId/leagueIds/verticals/
    // teamNames/reuseOverride and every other supported field.
    const job = await queueEpisodeBuildJob(toEpisodeBuildJobData(input));

    revalidatePath("/admin/episodes");
    return { success: true, jobId: job.id };
  } catch (err: any) {
    return { success: false, error: err.message || "Failed to trigger episode build." };
  }
}

/** Durable audit record for an admin reuse-override, plus a structured log line
 *  (admin identity, podcast, topic ids, timestamp, optional reason). */
async function logReuseOverride(entry: {
  admin: string;
  podcastId: string | null;
  topicIds: string[];
  reason: string | null;
}): Promise<void> {
  const record = { ...entry, at: new Date().toISOString() };
  console.warn("[audit] reuse-override authorized", record);
  try {
    await db.jobLog.create({
      data: { jobType: "admin:reuse-override", status: "completed", input: record as Prisma.InputJsonValue, output: {} },
    });
  } catch {
    // Auditing must never block the build; the console line is the fallback.
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

    // Delete the episode + its topic joins. TopicCandidate EDITORIAL status is
    // NOT touched: usage is derived from EpisodeTopic, so removing this episode
    // simply removes its usage record — a topic never gets flipped back to a
    // different editorial state by a deletion.
    await db.$transaction(async (tx) => {
      await tx.episodeTopic.deleteMany({ where: { episodeId } });
      await tx.episode.delete({ where: { id: episodeId } });
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
