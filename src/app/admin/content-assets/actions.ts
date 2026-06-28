"use server";

import { db } from "@/lib/db";
import { queueContentAssetGenerationJob } from "@/lib/queue/podcastQueue";
import { getStorageProvider } from "@/lib/providers/storage/factory";
import { revalidatePath } from "next/cache";

export async function triggerContentAssetGeneration(
  scriptId: string,
  options: {
    forceRegenerate?: boolean;
    includeChapters?: boolean;
    includeMarkdown?: boolean;
    includeJson?: boolean;
    providerOverride?: string;
  } = {}
) {
  try {
    // 1. Stricter eligibility checks on status
    const script = await db.script.findUnique({
      where: { id: scriptId },
      include: { episode: true },
    });

    if (!script) {
      throw new Error(`Script with ID ${scriptId} not found.`);
    }

    if (!script.episode) {
      throw new Error(`Episode not linked to Script ${scriptId}.`);
    }

    const episode = script.episode;

    if (episode.status === "content_generating") {
      throw new Error("Episode is already content_generating. Wait for the current content job to finish or manually reset the status.");
    }

    // Call BullMQ helper
    const job = await queueContentAssetGenerationJob({
      scriptId,
      ...options,
    });

    revalidatePath("/admin/content-assets");
    revalidatePath(`/admin/content-assets/${scriptId}`);
    revalidatePath(`/admin/final-audio/${scriptId}`);
    revalidatePath(`/admin/episodes/${episode.id}`);

    return { success: true, jobId: job.id };
  } catch (err: any) {
    return { success: false, error: err.message || "Failed to trigger content asset generation." };
  }
}

export async function fetchContentAssetEligibility(scriptId: string) {
  try {
    const script = await db.script.findUnique({
      where: { id: scriptId },
      include: {
        episode: {
          include: {
            topics: {
              orderBy: { orderIndex: "asc" },
              include: {
                topic: {
                  include: {
                    researchBrief: true,
                  },
                },
              },
            },
          },
        },
        audioSegments: true,
        factCheckResults: {
          orderBy: { checkedAt: "desc" },
          take: 1,
        },
      },
    });

    const checks = {
      scriptExists: !!script,
      scriptApproved: script ? script.status === "approved" : false,
      scriptContentValid: script ? (!!script.content && typeof script.content === "object") : false,
      scriptPlainTextNotEmpty: script ? (!!script.plainText && script.plainText.trim().length > 0) : false,
      episodeExists: script ? !!script.episode : false,
      episodeAudioReady: script?.episode ? (script.episode.status === "audio_ready" || script.episode.status === "content_ready") : false,
      episodeAudioUrlExists: script?.episode ? !!script.episode.audioUrl : false,
      episodeDurationValid: script?.episode ? (!!script.episode.durationSeconds || script.audioSegments.length > 0) : false,
      factCheckExists: script ? script.factCheckResults.length > 0 : false,
      factCheckPassed: script && script.factCheckResults.length > 0 ? script.factCheckResults[0].status === "passed" : false,
      allDialogueLinesHaveAudioSegment: false,
      allAudioSegmentsReady: false,
      allAudioSegmentsHaveUrl: false,
      noNeedsHumanReview: false,
      activeHostsExist: false,
      speakerNamesValid: false,
      speakerHostIdsValid: false,
      allTopicsHaveTopicCandidate: false,
      allTopicCandidatesHaveResearchBrief: false,
      allResearchBriefsValid: false,
    };

    let errorReasons: string[] = [];

    if (script && script.episode) {
      const episode = script.episode;

      // Host profiles
      const hostA = await db.aiHost.findFirst({ where: { name: "Max Voltage", isActive: true } });
      const hostB = await db.aiHost.findFirst({ where: { name: "Dr. Linebreak", isActive: true } });
      checks.activeHostsExist = !!hostA && !!hostB;
      if (!checks.activeHostsExist) {
        errorReasons.push("Active host profiles for Max Voltage and Dr. Linebreak must exist.");
      }

      // Extract lines
      const segments = (script.content as any)?.segments || [];
      const allLines: any[] = [];
      let noReview = true;
      let speakerNamesOk = true;
      let speakerHostIdsOk = true;

      for (const seg of segments) {
        if (seg && Array.isArray(seg.lines)) {
          for (const line of seg.lines) {
            allLines.push(line);
            if (line.needsHumanReview) noReview = false;
            if (line.speakerName !== "Max Voltage" && line.speakerName !== "Dr. Linebreak") {
              speakerNamesOk = false;
            }
            if (checks.activeHostsExist) {
              if (line.speakerName === "Max Voltage" && line.speakerHostId !== hostA?.id) speakerHostIdsOk = false;
              if (line.speakerName === "Dr. Linebreak" && line.speakerHostId !== hostB?.id) speakerHostIdsOk = false;
            }
          }
        }
      }

      checks.noNeedsHumanReview = noReview;
      if (!noReview) errorReasons.push("Script contains lines requiring human review.");
      checks.speakerNamesValid = speakerNamesOk && allLines.length > 0;
      if (!speakerNamesOk || allLines.length === 0) errorReasons.push("Script lines have invalid speaker names.");
      checks.speakerHostIdsValid = speakerHostIdsOk && allLines.length > 0;
      if (!speakerHostIdsOk || allLines.length === 0) errorReasons.push("Script line host IDs do not match active hosts.");

      // Map audio segments
      const segmentMap = new Map<number, any[]>();
      for (const seg of script.audioSegments) {
        const list = segmentMap.get(seg.lineIndex) || [];
        list.push(seg);
        segmentMap.set(seg.lineIndex, list);
      }

      let allLinesHaveAudio = true;
      let allAudioReady = true;
      let allAudioHasUrl = true;

      for (const line of allLines) {
        const list = segmentMap.get(line.lineIndex) || [];
        const activeSeg = list[0];
        if (!activeSeg) {
          allLinesHaveAudio = false;
          allAudioReady = false;
          allAudioHasUrl = false;
        } else {
          if (activeSeg.status !== "ready") allAudioReady = false;
          if (!activeSeg.audioUrl) allAudioHasUrl = false;
        }
      }

      checks.allDialogueLinesHaveAudioSegment = allLinesHaveAudio && allLines.length > 0;
      if (!allLinesHaveAudio) errorReasons.push("Some dialogue lines are missing matching AudioSegment records.");
      checks.allAudioSegmentsReady = allAudioReady && allLines.length > 0;
      if (!allAudioReady) errorReasons.push("Some AudioSegments are not ready.");
      checks.allAudioSegmentsHaveUrl = allAudioHasUrl && allLines.length > 0;
      if (!allAudioHasUrl) errorReasons.push("Some AudioSegments are missing audio URLs.");

      // Topics & research briefs
      let topicsHaveCandidate = true;
      let candidatesHaveBrief = true;
      let briefsValid = true;

      for (const et of episode.topics) {
        if (!et.topic) {
          topicsHaveCandidate = false;
          candidatesHaveBrief = false;
          briefsValid = false;
        } else {
          const brief = et.topic.researchBrief;
          if (!brief) {
            candidatesHaveBrief = false;
            briefsValid = false;
          } else {
            const facts = Array.isArray(brief.facts) ? brief.facts : [];
            const sourceIds = Array.isArray(brief.sourceIds) ? brief.sourceIds : [];
            if (facts.length === 0 || sourceIds.length === 0) {
              briefsValid = false;
            }
          }
        }
      }

      checks.allTopicsHaveTopicCandidate = topicsHaveCandidate && episode.topics.length > 0;
      if (!topicsHaveCandidate) errorReasons.push("Some linked topics are missing their TopicCandidate records.");
      checks.allTopicCandidatesHaveResearchBrief = candidatesHaveBrief && episode.topics.length > 0;
      if (!candidatesHaveBrief) errorReasons.push("Some TopicCandidates are missing ResearchBriefs.");
      checks.allResearchBriefsValid = briefsValid && episode.topics.length > 0;
      if (!briefsValid) errorReasons.push("Some ResearchBriefs have empty facts or sourceIds.");
    } else {
      errorReasons.push("Script or linked Episode is missing.");
    }

    if (script) {
      if (script.status !== "approved") errorReasons.push(`Script is not approved (status: ${script.status}).`);
      if (script.factCheckResults.length === 0) errorReasons.push("No fact check results found.");
      else if (script.factCheckResults[0].status !== "passed") errorReasons.push(`Latest fact check status is '${script.factCheckResults[0].status}'.`);
    }

    if (script?.episode) {
      if (script.episode.status !== "audio_ready" && script.episode.status !== "content_ready") {
        errorReasons.push(`Episode status is '${script.episode.status}', must be 'audio_ready'.`);
      }
      if (!script.episode.audioUrl) errorReasons.push("Episode final audioUrl is missing.");
    }

    const eligible = Object.values(checks).every((val) => val === true);

    return {
      success: true,
      eligible,
      checks,
      errorReasons,
    };
  } catch (err: any) {
    return { success: false, error: err.message || "Failed to check eligibility." };
  }
}

export async function fetchContentAssetDetail(scriptId: string) {
  try {
    const script = await db.script.findUnique({
      where: { id: scriptId },
      include: {
        episode: {
          include: {
            topics: {
              orderBy: { orderIndex: "asc" },
              include: {
                topic: {
                  include: {
                    researchBrief: true,
                  },
                },
              },
            },
          },
        },
        factCheckResults: {
          orderBy: { checkedAt: "desc" },
          take: 1,
        },
      },
    });

    if (!script) {
      return { success: false, error: "Script not found" };
    }

    const episode = script.episode;
    const latestFactCheck = script.factCheckResults[0];

    let transcriptMarkdown = "";
    let showNotesMarkdown = "";
    let metadataJson = null;

    const storageProvider = getStorageProvider();
    const metadataKey = `episodes/${episode.id}/scripts/${script.id}/content/metadata.json`;
    const transcriptKey = `episodes/${episode.id}/scripts/${script.id}/content/transcript.md`;
    const showNotesKey = `episodes/${episode.id}/scripts/${script.id}/content/show-notes.md`;

    try {
      const res = await storageProvider.getObject({ key: metadataKey });
      metadataJson = JSON.parse(res.body.toString("utf-8"));
    } catch (e) {
      console.log("No metadata JSON found in storage.");
    }

    try {
      const res = await storageProvider.getObject({ key: transcriptKey });
      transcriptMarkdown = res.body.toString("utf-8");
    } catch (e) {
      console.log("No transcript markdown found in storage.");
    }

    try {
      const res = await storageProvider.getObject({ key: showNotesKey });
      showNotesMarkdown = res.body.toString("utf-8");
    } catch (e) {
      console.log("No show notes markdown found in storage.");
    }

    // Latest JobLog
    let latestJob = null;
    try {
      const recentJobs = await db.jobLog.findMany({
        where: { jobType: "content:generate-assets" },
        orderBy: { createdAt: "desc" },
        take: 10,
      });
      latestJob = recentJobs.find((job) => {
        const input = job.input as any;
        return input && input.scriptId === scriptId;
      }) || null;
    } catch (err) {
      console.warn("Failed to find latest job log:", err);
    }

    return {
      success: true,
      detail: {
        scriptId: script.id,
        episodeId: episode.id,
        episodeTitle: episode.title,
        episodeDescription: episode.description,
        episodeStatus: episode.status,
        audioUrl: episode.audioUrl,
        durationSeconds: episode.durationSeconds,
        scriptVersion: script.version,
        scriptStatus: script.status,
        transcriptUrl: episode.transcriptUrl,
        longShowNotes: episode.longShowNotes,
        latestFactCheckStatus: latestFactCheck ? latestFactCheck.status : "missing",
        transcriptMarkdown,
        showNotesMarkdown,
        metadataJson,
        latestJob,
      },
    };
  } catch (err: any) {
    return { success: false, error: err.message || "Failed to fetch details." };
  }
}

export async function fetchContentAssetDashboard(filters: {
  episodeStatus?: string;
  contentStatus?: string;
  search?: string;
} = {}) {
  try {
    const whereClause: any = {};

    if (filters.search) {
      whereClause.episode = {
        title: {
          contains: filters.search,
          mode: "insensitive",
        },
      };
    }

    if (filters.episodeStatus) {
      if (whereClause.episode) {
        whereClause.episode.status = filters.episodeStatus;
      } else {
        whereClause.episode = { status: filters.episodeStatus };
      }
    }

    // Fetch scripts with episode
    const scripts = await db.script.findMany({
      where: whereClause,
      include: {
        episode: true,
      },
      orderBy: { createdAt: "desc" },
    });

    let filteredScripts = scripts;
    if (filters.contentStatus) {
      filteredScripts = scripts.filter((s) => {
        const hasContent = s.episode.status === "content_ready" && !!s.episode.transcriptUrl && !!s.episode.longShowNotes;
        return filters.contentStatus === "ready" ? hasContent : !hasContent;
      });
    }

    const items = await Promise.all(
      filteredScripts.map(async (s) => {
        let generatedAt = null;
        try {
          const recentJobs = await db.jobLog.findMany({
            where: { jobType: "content:generate-assets", status: "completed" },
            orderBy: { createdAt: "desc" },
            take: 10,
          });
          const match = recentJobs.find((j) => (j.input as any)?.scriptId === s.id);
          if (match) {
            generatedAt = match.createdAt.toISOString();
          }
        } catch (e) {}

        return {
          scriptId: s.id,
          episodeId: s.episode.id,
          episodeTitle: s.episode.title,
          scriptVersion: s.version,
          episodeStatus: s.episode.status,
          scriptStatus: s.status,
          audioUrl: s.episode.audioUrl,
          transcriptUrl: s.episode.transcriptUrl,
          showNotesText: s.episode.longShowNotes,
          duration: s.episode.durationSeconds,
          generatedAt,
        };
      })
    );

    return { success: true, items };
  } catch (err: any) {
    return { success: false, error: err.message || "Failed to fetch dashboard." };
  }
}

export async function fetchLatestContentAssetJob(scriptId: string) {
  try {
    const recentJobs = await db.jobLog.findMany({
      where: { jobType: "content:generate-assets" },
      orderBy: { createdAt: "desc" },
      take: 10,
    });
    const job = recentJobs.find((j) => (j.input as any)?.scriptId === scriptId) || null;

    return { success: true, job };
  } catch (err: any) {
    return { success: false, error: err.message || "Failed to fetch job." };
  }
}
