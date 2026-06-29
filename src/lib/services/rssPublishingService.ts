import { db } from "../db";
import { getStorageProvider } from "../providers/storage/factory";

export async function validateEpisodeForRss(
  scriptId: string,
  action?: "prepare" | "publish" | "unpublish"
) {
  const checks = {
    scriptExists: false,
    scriptApproved: false,
    episodeExists: false,
    episodeStatusValid: false,
    episodeTitleExists: false,
    episodeAudioUrlExists: false,
    episodeDurationValid: false,
    episodeTranscriptUrlExists: false,
    episodeLongShowNotesExists: false,
    factCheckPassed: false,
    allAudioSegmentsReady: false,
    audioFileSizeResolved: false,
    audioMimeTypeValid: false,
    podcastConfigValid: false,
    rssGuidValid: false,
    noPlaceholderMetadata: true,
  };

  const errorReasons: string[] = [];

  // 1. Script existence
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

  if (!script) {
    errorReasons.push("Script does not exist.");
    return { eligible: false, checks, errorReasons, resolvedSize: 0, missingConfig: [] };
  }
  checks.scriptExists = true;

  // 2. Script approved
  if (script.status === "approved") {
    checks.scriptApproved = true;
  } else {
    errorReasons.push(`Script status is '${script.status}', must be 'approved'.`);
  }

  // 3. Episode linked
  const episode = script.episode;
  if (!episode) {
    errorReasons.push("Episode is not linked to script.");
    return { eligible: false, checks, errorReasons, resolvedSize: 0, missingConfig: [] };
  }
  checks.episodeExists = true;

  // 4. Episode status valid
  if (action === "prepare") {
    if (
      episode.status === "content_ready" ||
      episode.status === "publish_ready"
    ) {
      checks.episodeStatusValid = true;
    } else {
      errorReasons.push("Episode status must be 'content_ready' or 'publish_ready' to prepare.");
    }
  } else if (action === "publish") {
    if (episode.status === "publish_ready" || episode.status === "published") {
      checks.episodeStatusValid = true;
    } else {
      errorReasons.push(`Episode status is '${episode.status}', must be 'publish_ready' or 'published' to publish.`);
    }
  } else if (action === "unpublish") {
    if (episode.status === "published") {
      checks.episodeStatusValid = true;
    } else {
      errorReasons.push(`Episode status is '${episode.status}', must be 'published' to unpublish.`);
    }
  } else {
    // General check
    if (
      episode.status === "content_ready" ||
      episode.status === "publish_ready" ||
      episode.status === "published"
    ) {
      checks.episodeStatusValid = true;
    } else {
      errorReasons.push(`Episode status is '${episode.status}', must be content_ready, publish_ready, or published.`);
    }
  }

  // 5. Episode details
  if (episode.title && episode.title.trim()) {
    checks.episodeTitleExists = true;
  } else {
    errorReasons.push("Episode title is missing.");
  }

  if (episode.audioUrl && episode.audioUrl.trim()) {
    checks.episodeAudioUrlExists = true;
  } else {
    errorReasons.push("Episode audioUrl is missing.");
  }

  if (episode.durationSeconds && episode.durationSeconds > 0) {
    checks.episodeDurationValid = true;
  } else {
    errorReasons.push("Episode durationSeconds is missing or invalid.");
  }

  if (episode.transcriptUrl && episode.transcriptUrl.trim()) {
    checks.episodeTranscriptUrlExists = true;
  } else {
    errorReasons.push("Episode transcriptUrl is missing.");
  }

  if (episode.longShowNotes && episode.longShowNotes.trim()) {
    checks.episodeLongShowNotesExists = true;
  } else {
    errorReasons.push("Episode longShowNotes is missing.");
  }

  // 6. Fact check
  const latestFactCheck = script.factCheckResults[0];
  if (latestFactCheck && latestFactCheck.status === "passed") {
    checks.factCheckPassed = true;
  } else {
    errorReasons.push(
      latestFactCheck
        ? `Latest fact check status is '${latestFactCheck.status}', must be 'passed'.`
        : "No fact check results found."
    );
  }

  // 7. AudioSegments validation against Script.content lines
  try {
    const content = script.content as any;
    const scriptSegments = content?.segments;
    if (!Array.isArray(scriptSegments) || scriptSegments.length === 0) {
      errorReasons.push("Script segments are missing or empty in Script.content.");
    } else {
      let allDialogueLinesValid = true;
      const scriptLines: any[] = [];
      
      for (let sIdx = 0; sIdx < scriptSegments.length; sIdx++) {
        const seg = scriptSegments[sIdx];
        if (seg && Array.isArray(seg.lines)) {
          for (let lIdx = 0; lIdx < seg.lines.length; lIdx++) {
            const line = seg.lines[lIdx];
            if (!line || typeof line.lineIndex !== "number") {
              allDialogueLinesValid = false;
              errorReasons.push(`Script line at segment ${sIdx}, index ${lIdx} is missing a valid lineIndex.`);
            } else {
              scriptLines.push(line);
            }
          }
        }
      }

      if (allDialogueLinesValid) {
        if (scriptLines.length === 0) {
          errorReasons.push("Script contains no dialogue lines.");
        } else {
          let segmentsValidationPassed = true;
          
          for (const line of scriptLines) {
            const matches = script.audioSegments.filter(
              (as) => as.lineIndex === line.lineIndex
            );
            
            if (matches.length === 0) {
              segmentsValidationPassed = false;
              errorReasons.push(`Dialogue line ${line.lineIndex} is missing an AudioSegment.`);
            } else if (matches.length > 1) {
              segmentsValidationPassed = false;
              errorReasons.push(`Dialogue line ${line.lineIndex} has multiple (${matches.length}) AudioSegments.`);
            } else {
              const match = matches[0];
              if (match.status !== "ready") {
                segmentsValidationPassed = false;
                errorReasons.push(`AudioSegment for line ${line.lineIndex} is not ready (status: '${match.status}').`);
              }
              if (!match.audioUrl || !match.audioUrl.trim()) {
                segmentsValidationPassed = false;
                errorReasons.push(`AudioSegment for line ${line.lineIndex} has a missing or empty audioUrl.`);
              }
            }
          }
          
          if (segmentsValidationPassed) {
            checks.allAudioSegmentsReady = true;
          }
        }
      }
    }
  } catch (err: any) {
    errorReasons.push(`Failed to parse and validate Script.content lines: ${err.message}`);
  }

  // 8. Audio file size
  let resolvedSize = episode.audioFileSizeBytes || 0;
  if (!resolvedSize && episode.audioUrl) {
    try {
      const storageProvider = getStorageProvider();
      const head = await storageProvider.headObject({ url: episode.audioUrl });
      resolvedSize = head.sizeBytes;
    } catch (e: any) {
      console.warn("Failed to resolve storage file size during validation:", e.message);
    }
  }

  if (resolvedSize > 0) {
    checks.audioFileSizeResolved = true;
  } else {
    errorReasons.push("Audio file size could not be resolved or is 0.");
  }

  // 9. MIME type
  if (episode.audioMimeType && (episode.audioMimeType === "audio/mpeg" || episode.audioMimeType === "audio/mp3")) {
    checks.audioMimeTypeValid = true;
  } else {
    errorReasons.push(`Audio MIME type '${episode.audioMimeType}' is invalid.`);
  }

  // 10. Podcast config checklist
  const requiredConfig = [
    "PODCAST_TITLE",
    "PODCAST_DESCRIPTION",
    "PODCAST_LANGUAGE",
    "PODCAST_AUTHOR",
    "PODCAST_OWNER_NAME",
    "PODCAST_OWNER_EMAIL",
    "PODCAST_SITE_URL",
    "PODCAST_RSS_URL",
    "PODCAST_IMAGE_URL",
  ];
  const missingConfig = requiredConfig.filter((key) => !process.env[key] || !process.env[key]?.trim());
  if (missingConfig.length === 0) {
    checks.podcastConfigValid = true;
  } else {
    errorReasons.push(`Podcast configuration is incomplete. Missing: ${missingConfig.join(", ")}`);
  }

  // 11. GUID
  if (episode.rssGuid || (episode.id && script.id)) {
    checks.rssGuidValid = true;
  } else {
    errorReasons.push("GUID cannot be generated.");
  }

  // 12. No placeholder metadata
  const isPlaceholder = (val: string | null) => {
    if (!val) return false;
    const lower = val.toLowerCase();
    return lower.includes("[placeholder]") || lower.includes("placeholder description") || lower.includes("todo");
  };

  if (isPlaceholder(episode.title) || isPlaceholder(episode.description) || isPlaceholder(episode.longShowNotes)) {
    checks.noPlaceholderMetadata = false;
    errorReasons.push("Episode metadata contains placeholder text.");
  }

  const eligible = Object.values(checks).every((v) => v === true);
  return {
    eligible,
    checks,
    errorReasons,
    resolvedSize,
    missingConfig,
  };
}

export async function prepareEpisodeForPublishing(scriptId: string) {
  const jobLog = await db.jobLog.create({
    data: {
      jobType: "rss:prepare-episode",
      status: "running",
      input: { scriptId, action: "prepare" } as any,
      output: {},
    },
  });

  try {
    const script = await db.script.findUnique({
      where: { id: scriptId },
      include: { episode: true },
    });

    if (!script || !script.episode) {
      throw new Error("Script or linked Episode not found.");
    }

    const previousEpisodeStatus = script.episode.status;

    // Run validation
    const val = await validateEpisodeForRss(scriptId, "prepare");
    if (!val.eligible) {
      throw new Error(`Publishing preparation failed. Blockers: ${val.errorReasons.join("; ")}`);
    }

    // Determine GUID (stable: never change if already exists)
    const rssGuid = script.episode.rssGuid || `take-machine:${script.episode.id}:${script.id}`;

    // Update episode
    const updatedEpisode = await db.episode.update({
      where: { id: script.episode.id },
      data: {
        status: "publish_ready",
        audioFileSizeBytes: val.resolvedSize,
        rssGuid,
      },
    });

    const publicRssUrl = process.env.PODCAST_RSS_URL || "";

    const output = {
      episodeId: updatedEpisode.id,
      scriptId: script.id,
      finalStatus: "completed",
      previousEpisodeStatus,
      newEpisodeStatus: "publish_ready",
      rssGuid,
      audioFileSizeBytes: val.resolvedSize,
      audioMimeType: updatedEpisode.audioMimeType,
      publicRssUrl,
      missingConfig: val.missingConfig,
      reasons: ["Episode prepared successfully."],
    };

    await db.jobLog.update({
      where: { id: jobLog.id },
      data: {
        status: "completed",
        output: output as any,
      },
    });

    return output;
  } catch (err: any) {
    console.error("prepareEpisodeForPublishing failed:", err.message);
    await db.jobLog.update({
      where: { id: jobLog.id },
      data: {
        status: "failed",
        error: err.message || "Unknown error",
        output: {
          scriptId,
          finalStatus: "failed",
          reasons: [err.message || "Execution error"],
        } as any,
      },
    });
    throw err;
  }
}

export async function publishEpisode(
  scriptId: string,
  options: { forceRepublish?: boolean } = {}
) {
  const { forceRepublish = false } = options;

  const jobLog = await db.jobLog.create({
    data: {
      jobType: "rss:publish-episode",
      status: "running",
      input: { scriptId, action: "publish", forceRepublish } as any,
      output: {},
    },
  });

  try {
    const script = await db.script.findUnique({
      where: { id: scriptId },
      include: { episode: true },
    });

    if (!script || !script.episode) {
      throw new Error("Script or linked Episode not found.");
    }

    const previousEpisodeStatus = script.episode.status;

    // Run validation
    const val = await validateEpisodeForRss(scriptId, "publish");
    if (!val.eligible) {
      throw new Error(`Publishing failed. Blockers: ${val.errorReasons.join("; ")}`);
    }

    // Determine publishedAt (stable unless forceRepublish is true)
    const publishedAt =
      script.episode.publishedAt && !forceRepublish
        ? script.episode.publishedAt
        : new Date();

    const updatedEpisode = await db.episode.update({
      where: { id: script.episode.id },
      data: {
        status: "published",
        publishedAt,
      },
    });

    const publicRssUrl = process.env.PODCAST_RSS_URL || "";

    const output = {
      episodeId: updatedEpisode.id,
      scriptId: script.id,
      finalStatus: "completed",
      previousEpisodeStatus,
      newEpisodeStatus: "published",
      rssGuid: updatedEpisode.rssGuid,
      audioFileSizeBytes: updatedEpisode.audioFileSizeBytes,
      audioMimeType: updatedEpisode.audioMimeType,
      publicRssUrl,
      missingConfig: val.missingConfig,
      reasons: ["Episode published successfully."],
    };

    await db.jobLog.update({
      where: { id: jobLog.id },
      data: {
        status: "completed",
        output: output as any,
      },
    });

    return output;
  } catch (err: any) {
    console.error("publishEpisode failed:", err.message);
    await db.jobLog.update({
      where: { id: jobLog.id },
      data: {
        status: "failed",
        error: err.message || "Unknown error",
        output: {
          scriptId,
          finalStatus: "failed",
          reasons: [err.message || "Execution error"],
        } as any,
      },
    });
    throw err;
  }
}

export async function unpublishEpisode(scriptId: string) {
  const jobLog = await db.jobLog.create({
    data: {
      jobType: "rss:unpublish-episode",
      status: "running",
      input: { scriptId, action: "unpublish" } as any,
      output: {},
    },
  });

  try {
    const script = await db.script.findUnique({
      where: { id: scriptId },
      include: { episode: true },
    });

    if (!script || !script.episode) {
      throw new Error("Script or linked Episode not found.");
    }

    const previousEpisodeStatus = script.episode.status;

    if (previousEpisodeStatus !== "published") {
      throw new Error(`Episode is not published (status: ${previousEpisodeStatus}).`);
    }

    const updatedEpisode = await db.episode.update({
      where: { id: script.episode.id },
      data: {
        status: "publish_ready",
      },
    });

    const publicRssUrl = process.env.PODCAST_RSS_URL || "";

    const output = {
      episodeId: updatedEpisode.id,
      scriptId: script.id,
      finalStatus: "completed",
      previousEpisodeStatus,
      newEpisodeStatus: "publish_ready",
      rssGuid: updatedEpisode.rssGuid,
      audioFileSizeBytes: updatedEpisode.audioFileSizeBytes,
      audioMimeType: updatedEpisode.audioMimeType,
      publicRssUrl,
      reasons: ["Episode unpublished successfully."],
    };

    await db.jobLog.update({
      where: { id: jobLog.id },
      data: {
        status: "completed",
        output: output as any,
      },
    });

    return output;
  } catch (err: any) {
    console.error("unpublishEpisode failed:", err.message);
    await db.jobLog.update({
      where: { id: jobLog.id },
      data: {
        status: "failed",
        error: err.message || "Unknown error",
        output: {
          scriptId,
          finalStatus: "failed",
          reasons: [err.message || "Execution error"],
        } as any,
      },
    });
    throw err;
  }
}
