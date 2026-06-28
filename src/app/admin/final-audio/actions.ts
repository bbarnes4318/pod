"use server";

import { db } from "@/lib/db";
import { queueFinalAudioStitchJob } from "@/lib/queue/podcastQueue";
import { revalidatePath } from "next/cache";

export async function fetchFinalAudioEligibility(scriptId: string) {
  try {
    const script = await db.script.findUnique({
      where: { id: scriptId },
      include: {
        episode: true,
        audioSegments: true,
        factCheckResults: {
          orderBy: { checkedAt: "desc" },
          take: 1,
        },
      },
    });

    if (!script) {
      return { eligible: false, reason: "Script not found." };
    }

    if (script.status !== "approved") {
      return { eligible: false, reason: `Script status is '${script.status}'. Only approved scripts can be stitched.` };
    }

    if (!script.episode) {
      return { eligible: false, reason: "No linked episode found." };
    }

    const episode = script.episode;

    if (episode.status !== "audio_segments_ready" && episode.status !== "audio_ready" && episode.status !== "audio_stitching") {
      return { eligible: false, reason: `Episode status is '${episode.status}'. Episode must be 'audio_segments_ready'.` };
    }

    const latestFactCheck = script.factCheckResults[0];
    if (!latestFactCheck || latestFactCheck.status !== "passed") {
      return { eligible: false, reason: "Latest fact check result did not pass." };
    }

    const segments = (script.content as any)?.segments || [];
    const allLines: any[] = [];
    for (const seg of segments) {
      if (seg && Array.isArray(seg.lines)) {
        allLines.push(...seg.lines);
      }
    }

    if (allLines.length === 0) {
      return { eligible: false, reason: "Script contains no dialogue lines." };
    }

    // AudioSegment checks
    const segmentMap = new Map<number, any[]>();
    for (const seg of script.audioSegments) {
      const list = segmentMap.get(seg.lineIndex) || [];
      list.push(seg);
      segmentMap.set(seg.lineIndex, list);
    }

    let missing = 0;
    let failed = 0;
    let duplicate = 0;

    for (const line of allLines) {
      const list = segmentMap.get(line.lineIndex) || [];
      if (list.length === 0) {
        missing++;
      } else if (list.length > 1) {
        duplicate++;
      }

      const activeSeg = list[0];
      if (activeSeg) {
        if (activeSeg.status !== "ready" || !activeSeg.audioUrl) {
          failed++;
        }
      }
    }

    if (missing > 0 || failed > 0 || duplicate > 0) {
      return {
        eligible: false,
        reason: `Audio segments check failed. Missing: ${missing}, Failed/Not Ready: ${failed}, Duplicates: ${duplicate}.`,
        details: { missing, failed, duplicate, totalLines: allLines.length, ready: allLines.length - missing - failed },
      };
    }

    return {
      eligible: true,
      details: { missing, failed, duplicate, totalLines: allLines.length, ready: allLines.length },
    };
  } catch (err: any) {
    return { eligible: false, reason: err.message || "Failed to fetch eligibility." };
  }
}

export async function triggerFinalAudioStitch(
  scriptId: string,
  options: {
    forceRegenerate?: boolean;
    includeIntro?: boolean;
    includeOutro?: boolean;
    normalizeAudio?: boolean;
    targetLufs?: number;
  }
) {
  try {
    const el = await fetchFinalAudioEligibility(scriptId);
    if (!el.eligible) {
      throw new Error(el.reason || "Script is not eligible for stitching.");
    }

    await queueFinalAudioStitchJob({
      scriptId,
      forceRegenerate: options.forceRegenerate,
      includeIntro: options.includeIntro,
      includeOutro: options.includeOutro,
      normalizeAudio: options.normalizeAudio,
      targetLufs: options.targetLufs,
    });

    revalidatePath(`/admin/final-audio/${scriptId}`);
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message || "Failed to trigger stitching job." };
  }
}

export async function fetchLatestAudioStitchJob(scriptId: string) {
  try {
    const latestJob = await db.jobLog.findFirst({
      where: {
        jobType: "audio:stitch-final",
        input: {
          path: ["scriptId"],
          equals: scriptId,
        },
      },
      orderBy: { createdAt: "desc" },
    });

    if (!latestJob) {
      return { success: true, job: null };
    }

    return {
      success: true,
      job: {
        id: latestJob.id,
        status: latestJob.status,
        error: latestJob.error,
        createdAt: latestJob.createdAt.toISOString(),
        output: latestJob.output ? (latestJob.output as any) : null,
      },
    };
  } catch (err: any) {
    return { success: false, error: err.message || "Failed to fetch latest stitching job." };
  }
}

export async function fetchFinalAudioDetail(scriptId: string) {
  try {
    const script = await db.script.findUnique({
      where: { id: scriptId },
      include: {
        episode: true,
        audioSegments: true,
      },
    });

    if (!script) {
      throw new Error("Script not found.");
    }

    const segments = (script.content as any)?.segments || [];
    const allLines: any[] = [];
    for (const seg of segments) {
      if (seg && Array.isArray(seg.lines)) {
        allLines.push(...seg.lines);
      }
    }

    const latestFactCheck = await db.factCheckResult.findFirst({
      where: { scriptId },
      orderBy: { checkedAt: "desc" },
    });

    const el = await fetchFinalAudioEligibility(scriptId);

    const latestStitch = await fetchLatestAudioStitchJob(scriptId);

    return {
      success: true,
      detail: {
        scriptId: script.id,
        episodeId: script.episodeId,
        episodeTitle: script.episode.title,
        episodeStatus: script.episode.status,
        version: script.version,
        status: script.status,
        latestFactCheckStatus: latestFactCheck ? latestFactCheck.status : "missing",
        finalAudioUrl: script.episode.audioUrl,
        durationSeconds: script.episode.durationSeconds,
        totalLines: allLines.length,
        eligibility: el,
        latestJob: latestStitch.success ? latestStitch.job : null,
      },
    };
  } catch (err: any) {
    return { success: false, error: err.message || "Failed to fetch final audio detail." };
  }
}

export async function fetchFinalAudioDashboard(filters?: {
  search?: string;
  episodeStatus?: string;
  finalAudioStatus?: string;
}) {
  try {
    const where: any = {
      status: "approved",
    };

    if (filters?.episodeStatus || filters?.search) {
      where.episode = {};
      if (filters.episodeStatus) {
        where.episode.status = filters.episodeStatus;
      }
      if (filters.search) {
        where.episode.title = { contains: filters.search, mode: "insensitive" };
      }
    }

    const scripts = await db.script.findMany({
      where,
      include: {
        episode: true,
        audioSegments: true,
        factCheckResults: {
          orderBy: { checkedAt: "desc" },
          take: 1,
        },
      },
      orderBy: { createdAt: "desc" },
    });

    const list = scripts.map((s) => {
      const latestFC = s.factCheckResults[0];
      const segments = (s.content as any)?.segments || [];
      let totalLines = 0;
      for (const seg of segments) {
        if (seg && Array.isArray(seg.lines)) {
          totalLines += seg.lines.length;
        }
      }

      const readySegments = s.audioSegments.filter((a) => a.status === "ready").length;

      return {
        scriptId: s.id,
        episodeId: s.episodeId,
        episodeTitle: s.episode.title,
        version: s.version,
        episodeStatus: s.episode.status,
        scriptStatus: s.status,
        factCheckStatus: latestFC ? latestFC.status : "missing",
        readySegments,
        totalLines,
        finalAudioUrl: s.episode.audioUrl,
        durationSeconds: s.episode.durationSeconds,
      };
    });

    let filteredList = list;
    if (filters?.finalAudioStatus) {
      if (filters.finalAudioStatus === "ready") {
        filteredList = list.filter((item) => !!item.finalAudioUrl);
      } else if (filters.finalAudioStatus === "pending") {
        filteredList = list.filter((item) => !item.finalAudioUrl);
      }
    }

    return { success: true, list: filteredList };
  } catch (err: any) {
    return { success: false, error: err.message || "Failed to fetch dashboard." };
  }
}
