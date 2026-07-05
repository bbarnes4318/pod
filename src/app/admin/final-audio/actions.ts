"use server";

import { db } from "@/lib/db";
import { queueFinalAudioStitchJob } from "@/lib/queue/podcastQueue";
import {
  isProductionStyle,
  isSfxDensity,
  parseEpisodeSoundDesign,
} from "@/lib/audio/soundDesignShared";
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

    // Per-line audio readiness — tolerant of duplicate segment rows: a line is
    // "ready" if ANY of its segment rows is ready with an audioUrl.
    const segmentMap = new Map<number, any[]>();
    for (const seg of script.audioSegments) {
      const list = segmentMap.get(seg.lineIndex) || [];
      list.push(seg);
      segmentMap.set(seg.lineIndex, list);
    }

    let missing = 0;
    let notReady = 0;
    for (const line of allLines) {
      const list = segmentMap.get(line.lineIndex) || [];
      if (list.length === 0) {
        missing++;
      } else if (!list.some((s) => s.status === "ready" && s.audioUrl)) {
        notReady++;
      }
    }
    const readyCount = allLines.length - missing - notReady;
    const allReady = missing === 0 && notReady === 0;

    // Self-heal a stuck flag: the episode's transition to audio_segments_ready
    // only happens inside the TTS job, so partial runs / duplicate rows can
    // leave it at fact_checked even when every line's audio is ready. If the
    // audio is genuinely all ready, advance the status here.
    if (allReady && episode.status === "fact_checked") {
      await db.episode.update({ where: { id: episode.id }, data: { status: "audio_segments_ready" } });
      episode.status = "audio_segments_ready";
    }

    if (!allReady) {
      return {
        eligible: false,
        reason: `Audio not ready: ${readyCount} of ${allLines.length} lines have audio (${missing} missing, ${notReady} failed/not-ready). Generate the remaining segments in the Audio Segments console.`,
        details: { missing, failed: notReady, duplicate: 0, totalLines: allLines.length, ready: readyCount },
      };
    }

    if (episode.status !== "audio_segments_ready" && episode.status !== "audio_ready" && episode.status !== "audio_stitching") {
      return { eligible: false, reason: `Episode status is '${episode.status}'. Episode must be 'audio_segments_ready'.` };
    }

    return {
      eligible: true,
      details: { missing: 0, failed: 0, duplicate: 0, totalLines: allLines.length, ready: allLines.length },
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
    /** "clean" | "light" | "full" — post-production depth for this render. */
    productionStyle?: string;
    /** "subtle" | "medium" | "hype" — reaction-SFX density. */
    sfxDensity?: string;
    /** Rights-gated highlight placements; persisted on the episode. */
    highlights?: Array<{ lineIndex: number; assetId: string }>;
  }
) {
  try {
    const el = await fetchFinalAudioEligibility(scriptId);
    if (!el.eligible) {
      throw new Error(el.reason || "Script is not eligible for stitching.");
    }

    if (options.productionStyle !== undefined && !isProductionStyle(options.productionStyle)) {
      throw new Error(`Unknown production style '${options.productionStyle}'.`);
    }
    if (options.sfxDensity !== undefined && !isSfxDensity(options.sfxDensity)) {
      throw new Error(`Unknown SFX density '${options.sfxDensity}'.`);
    }

    // Persist the sound-design selection on the episode BEFORE queueing —
    // the worker reads highlights (and fallback style/density) from there.
    if (options.productionStyle || options.sfxDensity || options.highlights) {
      const script = await db.script.findUnique({
        where: { id: scriptId },
        select: { episodeId: true, episode: { select: { soundDesign: true } } },
      });
      if (script) {
        const existing = parseEpisodeSoundDesign(script.episode?.soundDesign);
        const highlights = (options.highlights ?? existing.highlights ?? []).filter(
          (h) => Number.isInteger(h.lineIndex) && typeof h.assetId === "string" && h.assetId
        );
        await db.episode.update({
          where: { id: script.episodeId },
          data: {
            soundDesign: {
              ...existing,
              ...(options.productionStyle ? { style: options.productionStyle } : {}),
              ...(options.sfxDensity ? { sfxDensity: options.sfxDensity } : {}),
              highlights,
            } as any,
          },
        });
      }
    }

    await queueFinalAudioStitchJob({
      scriptId,
      forceRegenerate: options.forceRegenerate,
      includeIntro: options.includeIntro,
      includeOutro: options.includeOutro,
      normalizeAudio: options.normalizeAudio,
      targetLufs: options.targetLufs,
      productionStyle: options.productionStyle,
      sfxDensity: options.sfxDensity,
    });

    revalidatePath(`/admin/final-audio/${scriptId}`);
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message || "Failed to trigger stitching job." };
  }
}

/** Sound-design context for the stitch console: episode settings, show
 *  defaults, and the cleared highlight assets available for placement. */
export async function fetchSoundDesignContext(scriptId: string) {
  try {
    const script = await db.script.findUnique({
      where: { id: scriptId },
      select: { episode: { select: { soundDesign: true } } },
    });
    const [config, highlightAssets] = await Promise.all([
      db.soundDesignConfig.findUnique({ where: { id: "default" } }),
      db.audioAsset.findMany({
        where: { kind: "highlight", isActive: true, rightsConfirmed: true },
        orderBy: { createdAt: "desc" },
      }),
    ]);
    return {
      success: true,
      episodeSoundDesign: parseEpisodeSoundDesign(script?.episode?.soundDesign),
      defaults: {
        style: config?.defaultStyle || "clean",
        sfxDensity: config?.defaultSfxDensity || "subtle",
        configured: !!config,
      },
      highlightAssets: highlightAssets.map((a) => ({
        id: a.id,
        name: a.name,
        durationMs: a.durationMs,
        license: a.license,
      })),
    };
  } catch (err: any) {
    return { success: false, error: err.message || "Failed to load sound design context." };
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
        transcriptUrl: script.episode.transcriptUrl,
        longShowNotes: script.episode.longShowNotes,
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
