"use server";

import { requireAdmin } from "@/lib/adminAuth";
import { db } from "@/lib/db";
import { queueScriptGenerationJob } from "@/lib/queue/podcastQueue";
import { revalidatePath } from "next/cache";

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

// REMOVED: `fetchEligibleTopics`.
//
// It was the Admin surface's own, hidden eligibility engine — a SQL WHERE of
// `status: "approved"` + `debateScore: { gte: minScore /* 70 */ }` +
// `researchBrief: { isNot: null }`, followed by a silent `.filter()` on facts /
// sourceIds / host arguments. Three problems, all now fixed by deleting it:
//
//   1. The automatic debate-score floor gated MANUAL visibility. A topic
//      scoring 69 was unpickable and, worse, invisible — with no reason given.
//   2. Rejected/archived/pending topics vanished rather than explaining
//      themselves, so "not researched yet" and "scored low" looked identical.
//   3. It never checked `evidenceIds`, so it advertised topics that
//      createEpisodeDraft would then refuse — the filter and the creation
//      service disagreed about what "eligible" meant.
//
// The Admin board now loads the authorized global catalog through
// `fetchAdminRundownTopics` (./rundownActions), which evaluates every topic with
// the SHARED contract in src/lib/services/topicEligibility.ts — the same one
// Studio uses — and returns blocking reasons and warnings instead of silence.
//
// REMOVED: `triggerEpisodeBuild` and `createEpisodeFromSelectedTopics`.
// Both were Admin-only creation entry points superseded by
// `createAdminRundownEpisode` (./rundownActions), which routes Manual, Automatic
// and Hybrid through the SHARED createRundownEpisode → createEpisodeDraft core.
// The queued `episode:build` job itself is untouched and still serves the
// recurring scheduler and /app/create.

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
