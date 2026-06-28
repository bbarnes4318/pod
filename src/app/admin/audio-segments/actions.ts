"use server";

import { db } from "@/lib/db";
import { queueTtsSegmentGenerationJob } from "@/lib/queue/podcastQueue";
import { revalidatePath } from "next/cache";

export async function fetchTtsEligibility(scriptId: string) {
  try {
    const script = await db.script.findUnique({
      where: { id: scriptId },
      include: { episode: true },
    });

    if (!script) {
      return { success: true, eligible: false, reason: "Script not found." };
    }

    if (script.status !== "approved") {
      return { success: true, eligible: false, reason: `Script status is '${script.status}'. Only approved scripts can generate TTS.` };
    }

    if (!script.episode) {
      return { success: true, eligible: false, reason: "Episode not linked." };
    }

    if (script.episode.status !== "fact_checked") {
      return { success: true, eligible: false, reason: `Episode status is '${script.episode.status}'. TTS can only run after the episode is 'fact_checked'.` };
    }

    const latestFactCheck = await db.factCheckResult.findFirst({
      where: { scriptId },
      orderBy: { checkedAt: "desc" },
    });

    if (!latestFactCheck) {
      return { success: true, eligible: false, reason: "Fact check result is missing." };
    }

    if (latestFactCheck.status !== "passed") {
      return { success: true, eligible: false, reason: `Latest fact check status is '${latestFactCheck.status}'. Fact check must pass to generate TTS.` };
    }

    return { success: true, eligible: true };
  } catch (err: any) {
    return { success: false, error: err.message || "Failed to check TTS eligibility." };
  }
}

export async function triggerTtsGeneration(scriptId: string, forceRegenerate = false) {
  try {
    const check = await fetchTtsEligibility(scriptId);
    if (!check.success || !check.eligible) {
      throw new Error(check.reason || "Script is not eligible for TTS generation.");
    }

    await queueTtsSegmentGenerationJob({ scriptId, forceRegenerate });
    revalidatePath(`/admin/audio-segments/${scriptId}`);
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message || "Failed to queue TTS segment generation job." };
  }
}

export async function triggerTtsRange(scriptId: string, startLineIndex: number, endLineIndex: number) {
  try {
    const check = await fetchTtsEligibility(scriptId);
    if (!check.success || !check.eligible) {
      throw new Error(check.reason || "Script is not eligible for TTS generation.");
    }

    await queueTtsSegmentGenerationJob({
      scriptId,
      segmentRange: { startLineIndex, endLineIndex },
      forceRegenerate: true, // Range triggers usually want to overwrite
    });
    revalidatePath(`/admin/audio-segments/${scriptId}`);
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message || "Failed to queue TTS range generation job." };
  }
}

export async function triggerTtsForHost(scriptId: string, hostId: string) {
  try {
    const check = await fetchTtsEligibility(scriptId);
    if (!check.success || !check.eligible) {
      throw new Error(check.reason || "Script is not eligible for TTS generation.");
    }

    await queueTtsSegmentGenerationJob({
      scriptId,
      hostId,
      forceRegenerate: true,
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
        createdAt: s.createdAt.toISOString(),
      })),
    };
  } catch (err: any) {
    return { success: false, error: err.message || "Failed to fetch audio segments." };
  }
}
