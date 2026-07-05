"use server";

import { db } from "@/lib/db";
import { queueTtsSegmentGenerationJob } from "@/lib/queue/podcastQueue";
import { TTS_ELIGIBLE_EPISODE_STATUSES } from "@/lib/services/ttsSegmentService";
import { revalidatePath } from "next/cache";

// Only structural problems (no script, no episode) make a script ineligible.
// Pipeline-state mismatches — unapproved script, early episode status, missing
// or non-passed fact check — come back as warnings so the operator console
// stays fully usable instead of turning into a fact-check error wall.
export async function fetchTtsEligibility(scriptId: string) {
  try {
    const script = await db.script.findUnique({
      where: { id: scriptId },
      include: { episode: true },
    });

    if (!script) {
      return { success: true, eligible: false, reason: "Script not found.", warnings: [] as string[] };
    }

    if (!script.episode) {
      return { success: true, eligible: false, reason: "Episode not linked.", warnings: [] as string[] };
    }

    const warnings: string[] = [];

    if (script.status !== "approved") {
      warnings.push(`Script status is '${script.status}' (not approved).`);
    }

    if (!TTS_ELIGIBLE_EPISODE_STATUSES.includes(script.episode.status)) {
      warnings.push(`Episode status is '${script.episode.status}' (has not passed fact check).`);
    }

    const latestFactCheck = await db.factCheckResult.findFirst({
      where: { scriptId },
      orderBy: { checkedAt: "desc" },
    });

    if (!latestFactCheck) {
      warnings.push("No fact check has been run for this script.");
    } else if (latestFactCheck.status !== "passed") {
      warnings.push(`Latest fact check status is '${latestFactCheck.status}' (not passed).`);
    }

    return { success: true, eligible: true, warnings };
  } catch (err: any) {
    return { success: false, error: err.message || "Failed to check TTS eligibility." };
  }
}

export async function triggerTtsGeneration(scriptId: string, forceRegenerate = false, providerOverride?: string) {
  try {
    const check = await fetchTtsEligibility(scriptId);
    if (!check.success || !check.eligible) {
      throw new Error(check.reason || "Script is not eligible for TTS generation.");
    }

    await queueTtsSegmentGenerationJob({ scriptId, forceRegenerate, providerOverride });
    revalidatePath(`/admin/audio-segments/${scriptId}`);
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message || "Failed to queue TTS segment generation job." };
  }
}

export async function triggerTtsRange(scriptId: string, startLineIndex: number, endLineIndex: number, providerOverride?: string) {
  try {
    const check = await fetchTtsEligibility(scriptId);
    if (!check.success || !check.eligible) {
      throw new Error(check.reason || "Script is not eligible for TTS generation.");
    }

    await queueTtsSegmentGenerationJob({
      scriptId,
      segmentRange: { startLineIndex, endLineIndex },
      forceRegenerate: true, // Range triggers usually want to overwrite
      providerOverride,
    });
    revalidatePath(`/admin/audio-segments/${scriptId}`);
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message || "Failed to queue TTS range generation job." };
  }
}

export async function triggerTtsForHost(scriptId: string, hostId: string, providerOverride?: string) {
  try {
    const check = await fetchTtsEligibility(scriptId);
    if (!check.success || !check.eligible) {
      throw new Error(check.reason || "Script is not eligible for TTS generation.");
    }

    await queueTtsSegmentGenerationJob({
      scriptId,
      hostId,
      forceRegenerate: true,
      providerOverride,
    });
    revalidatePath(`/admin/audio-segments/${scriptId}`);
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message || "Failed to queue TTS host generation job." };
  }
}

export async function retryTtsSegment(scriptId: string, lineIndex: number) {
  try {
    const check = await fetchTtsEligibility(scriptId);
    if (!check.success || !check.eligible) {
      throw new Error(check.reason || "Script is not eligible for TTS generation.");
    }

    await queueTtsSegmentGenerationJob({
      scriptId,
      segmentRange: { startLineIndex: lineIndex, endLineIndex: lineIndex },
      forceRegenerate: true,
    });
    revalidatePath(`/admin/audio-segments/${scriptId}`);
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message || "Failed to retry TTS segment." };
  }
}

export async function fetchTtsSegments(scriptId: string) {
  try {
    const segments = await db.audioSegment.findMany({
      where: { scriptId },
      orderBy: { lineIndex: "asc" },
    });

    return {
      success: true,
      segments: segments.map((s) => ({
        id: s.id,
        episodeId: s.episodeId,
        scriptId: s.scriptId,
        hostId: s.hostId,
        lineIndex: s.lineIndex,
        text: s.text,
        audioUrl: s.audioUrl,
        durationMs: s.durationMs,
        status: s.status,
        provider: s.provider,
        createdAt: s.createdAt.toISOString(),
      })),
    };
  } catch (err: any) {
    return { success: false, error: err.message || "Failed to fetch audio segments." };
  }
}
