"use server";

// User-surface episode-creation actions. The /app create flow used to call
// the /admin server actions directly; those are now admin-gated
// (requireAdmin), so the listener surface gets its own ungated actions that
// wrap the same services/queue jobs. Guards mirror the admin versions.

import { db } from "@/lib/db";
import { revalidatePath } from "next/cache";
import { currentUser } from "@/lib/currentUser";
import {
  queueResearchBriefGenerationJob,
  queueScriptGenerationJob,
  queueEpisodeBuildJob,
} from "@/lib/queue/podcastQueue";
import { buildEpisodeFromTopics, EpisodeBuildInput } from "@/lib/services/episodeService";
import { isValidVertical } from "@/lib/verticals";
import { SEGMENT_MIN, SEGMENT_MAX } from "../podcasts/config";

/** Shared /app creation guard: returns the standard error shape when the
 *  caller is not signed in. Creation/management requires an account. */
async function requireSignedIn(): Promise<{ success: false; error: string } | null> {
  if (!(await currentUser())) {
    return { success: false as const, error: "Please sign in to create or manage content." };
  }
  return null;
}

/** Lock in a pending take so it can be researched. */
export async function approveTake(topicId: string) {
  try {
    const gate = await requireSignedIn(); if (gate) return gate;
    await db.topicCandidate.update({ where: { id: topicId }, data: { status: "approved" } });
    revalidatePath("/app/create");
    revalidatePath("/app/topics");
    return { success: true as const };
  } catch (err: any) {
    return { success: false as const, error: err.message || "Failed to lock in the take." };
  }
}

/** Kick off research for an approved take. */
export async function researchTake(topicId: string, forceRegenerate = false) {
  try {
    const gate = await requireSignedIn(); if (gate) return gate;
    if (process.env.LLM_PROVIDER?.toLowerCase() === "stub" || !process.env.LLM_PROVIDER) {
      throw new Error("LLM provider is stub. Real research brief generation disabled.");
    }
    const topic = await db.topicCandidate.findUnique({ where: { id: topicId } });
    if (!topic) throw new Error("That take no longer exists.");
    if (topic.status !== "approved" && topic.status !== "used") {
      throw new Error("Lock in the take before researching it.");
    }
    const job = await queueResearchBriefGenerationJob({ topicId, forceRegenerate });
    return { success: true as const, jobId: job.id };
  } catch (err: any) {
    return { success: false as const, error: err.message || "Failed to start the research." };
  }
}

/** Build an episode from explicitly chosen (researched) takes. */
export async function produceEpisodeFromTopics(
  topicIds: string[],
  ttsProvider?: string,
  ttsVoiceOverrides?: EpisodeBuildInput["ttsVoiceOverrides"]
) {
  try {
    const gate = await requireSignedIn(); if (gate) return gate;
    const res = await buildEpisodeFromTopics({ topicIds, ttsProvider, ttsVoiceOverrides });
    revalidatePath("/app/create");
    revalidatePath("/app/episodes");
    return { success: true as const, episodeId: res.episodeId };
  } catch (err: any) {
    return { success: false as const, error: err.message || "Failed to produce the episode." };
  }
}

/** Start the debate (script generation) for a draft episode. */
export async function startDebate(episodeId: string) {
  try {
    const gate = await requireSignedIn(); if (gate) return gate;
    const job = await queueScriptGenerationJob({ episodeId });
    revalidatePath(`/app/episodes/${episodeId}`);
    return { success: true as const, jobId: job.id };
  } catch (err: any) {
    return { success: false as const, error: err.message || "Failed to start the debate." };
  }
}

/**
 * Standalone Create Episode: one action, no podcast required. Auto-selects
 * the best researched topics (optionally narrowed to a vertical) and
 * enqueues the full build — the same pipeline recurring podcasts use.
 */
export async function createStandaloneEpisode(input: {
  title?: string;
  vertical?: string;
  segmentCount: number;
}) {
  try {
    const gate = await requireSignedIn(); if (gate) return gate;
    const segmentCount = Math.round(Number(input.segmentCount));
    if (!Number.isFinite(segmentCount) || segmentCount < SEGMENT_MIN || segmentCount > SEGMENT_MAX) {
      return { success: false as const, error: `Segments must be between ${SEGMENT_MIN} and ${SEGMENT_MAX}.` };
    }
    const title = input.title?.trim() || undefined;
    if (title && title.length > 120) {
      return { success: false as const, error: "Keep the title under 120 characters." };
    }

    let verticals: string[] | undefined;
    if (input.vertical && input.vertical !== "All") {
      if (!isValidVertical(input.vertical)) return { success: false as const, error: "Unknown vertical." };
      verticals = [input.vertical]; // matcher handles sports AND non-sport verticals
    }

    const job = await queueEpisodeBuildJob({
      title,
      verticals,
      targetTopicCount: segmentCount,
    });

    revalidatePath("/app/create");
    revalidatePath("/app/episodes");
    return { success: true as const, jobId: job.id };
  } catch (err: any) {
    return { success: false as const, error: err.message || "Failed to create the episode." };
  }
}
