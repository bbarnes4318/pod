import { db } from "../db";
import { evaluateBusinessRelease } from "../business/businessVerification";
import { getStorageProvider } from "../providers/storage/factory";
import { episodeHasBettingContent, checkGamblingCompliance } from "./compliance";
import { evaluateArtifactIntegrity, uncheckedLineIndexes, type ArtifactIntegrity } from "./artifactProvenance";
import { getEpisodeTranscriptVM } from "./transcriptView";
import { isBusinessPodcast } from "../business/intelligenceType";

/** Matches the seed's placeholder sentinel for a host whose real cloned voice
 *  does not exist yet. Deliberately broad (any PLACEHOLDER_* id) so a future
 *  host using the same convention is caught without touching this file. */
const PLACEHOLDER_VOICE_ID_RE = /^PLACEHOLDER[_-]/i;

/** Seed-time voice env vars are keyed by host IDENTITY, and the key is not
 *  derivable from the slug (slug `cal-red-eye-mercer` is read from
 *  FISH_CAL_MERCER_VOICE_ID). Rather than guess a name that does not exist, the
 *  blocker points at the seat-keyed overrides, which ARE positional and always
 *  correct, plus the doc that lists the identity vars. */
const VOICE_ENV_HELP =
  "Set the seat-keyed override (FISH_HOST_A_VOICE_ID for seat A, FISH_HOST_B_VOICE_ID for seat B) to fix this " +
  "without a reseed, or set the host's identity-keyed seed var listed in docs/PRODUCTION_ENV.md and reseed.";

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
    factCheckCurrent: false, // the check read today's words and left no claim open
    allAudioSegmentsReady: false,
    audioMatchesScript: false, // every recording says what the script says now
    finalMixCurrent: false, // the master was mixed from this script and these recordings
    audioFileSizeResolved: false,
    audioMimeTypeValid: false,
    podcastConfigValid: false,
    rssGuidValid: false,
    noPlaceholderMetadata: true,
    noPlaceholderVoice: true, // stays true unless a cast host has no real voice
    gamblingComplianceOk: true, // stays true for non-betting content
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
          podcast: { select: { verticals: true, intelligenceType: true } },
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
    return { eligible: false, checks, errorReasons, resolvedSize: 0, missingConfig: [], integrity: null as ArtifactIntegrity | null };
  }
  checks.scriptExists = true;

  // 2. Script approved
  if (script.status === "approved") {
    checks.scriptApproved = true;
  } else {
    errorReasons.push(`Script status is '${script.status}', must be 'approved'.`);
  }

  // 2b. Business factual rule (no-op for sports). Unpublishing is always allowed.
  if (action !== "unpublish") {
    const business = evaluateBusinessRelease(script.content, "publish");
    if (!business.allowed) errorReasons.push(`Business fact-check: ${business.state}. ${business.reasons.join(" ")}`);
  }

  // 3. Episode linked
  const episode = script.episode;
  if (!episode) {
    errorReasons.push("Episode is not linked to script.");
    return { eligible: false, checks, errorReasons, resolvedSize: 0, missingConfig: [], integrity: null as ArtifactIntegrity | null };
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

  // 6a. The fact check must be about TODAY's words, and leave nothing open.
  // Unpublishing is always allowed, so none of this can trap a live episode.
  if (action === "unpublish") {
    checks.factCheckCurrent = true;
  } else {
    const factReasons: string[] = [];
    const unchecked = uncheckedLineIndexes(script.content, (latestFactCheck?.summary as { checkedLines?: unknown } | null)?.checkedLines);
    if (unchecked.length > 0) {
      factReasons.push(`${unchecked.length} line${unchecked.length === 1 ? " was" : "s were"} edited after the last fact check. Run the fact check again.`);
    }
    // Sports claims: the same claim-by-claim rule the transcript shows.
    // Business claims are judged by evaluateBusinessRelease above.
    if (!isBusinessPodcast(episode.podcast)) {
      const vm = await getEpisodeTranscriptVM(episode.id);
      if (!vm.ok) factReasons.push(`Claims could not be read: ${vm.error || "unknown error"}.`);
      else if (vm.scriptId !== script.id) factReasons.push("A newer version of this script exists. Release works on the latest version only.");
      else if (vm.gate.unresolvedCount > 0) factReasons.push(`${vm.gate.unresolvedCount} claim${vm.gate.unresolvedCount === 1 ? " is" : "s are"} not verified. Review or correct ${vm.gate.unresolvedCount === 1 ? "it" : "them"} in the script.`);
    }
    if (factReasons.length === 0) checks.factCheckCurrent = true;
    else errorReasons.push(...factReasons);
  }

  // 6b. Gambling responsible-marketing gate — HARD requirement for betting
  // content. A betting episode cannot publish without the disclaimer/helpline
  // in its show notes, and its published-facing text must be free of
  // profit-promise language. Non-betting episodes pass through untouched.
  {
    const ep = script.episode;
    const topics = (ep?.topics || []).map((et: any) => ({
      title: et.topic?.title ?? "",
      summary: et.topic?.summary ?? null,
      leagueId: et.topic?.leagueId ?? null,
      bettingRelevanceScore: et.topic?.bettingRelevanceScore ?? null,
    }));
    const betting = episodeHasBettingContent({ podcastVerticals: ep?.podcast?.verticals ?? null, topics });
    const marketingText = [ep?.title, ep?.rssSummary, ep?.description, ep?.longShowNotes].filter(Boolean).join("\n");
    const compliance = checkGamblingCompliance({ betting, showNotes: ep?.longShowNotes ?? null, marketingText });
    if (!compliance.compliant) {
      checks.gamblingComplianceOk = false;
      for (const r of compliance.reasons) errorReasons.push(r);
    }
  }

  // 6c. Artifact provenance: recordings and the final mix must be OF this
  // script. One evaluation, shared with the quality inspector.
  const [sceneAudio, renders] = await Promise.all([
    db.dialogueSceneAudio.findMany({ where: { scriptId: script.id } }),
    db.episodeAudioRender.findMany({ where: { episodeId: episode.id }, orderBy: { renderVersion: "desc" }, take: 5 }),
  ]);
  const integrity = evaluateArtifactIntegrity({
    scriptId: script.id,
    content: script.content,
    ttsRenderMode: episode.ttsRenderMode ?? null,
    episodeAudioUrl: episode.audioUrl,
    lineAudio: script.audioSegments,
    sceneAudio,
    renders,
  });
  if (action === "unpublish") {
    checks.audioMatchesScript = true;
    checks.finalMixCurrent = true;
  } else {
    checks.audioMatchesScript = integrity.staleLines.length === 0 && integrity.staleScenes.length === 0;
    checks.finalMixCurrent = integrity.master === "current";
    errorReasons.push(...integrity.blockers);
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

          // Scene-voiced episodes have no per-line AudioSegment rows (the two
          // voicing paths write two tables). Their readiness is judged from the
          // SELECTED scene per stretch of script, in the integrity check above:
          // an old failed candidate must not block, and a missing or outdated
          // scene must.
          const sceneVoiced = integrity.mode === "scene";

          if (sceneVoiced) {
            if (integrity.unvoicedLines.length > 0) segmentsValidationPassed = false;
          } else {
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

  // 13. No host is still sitting on a placeholder voice.
  //
  // A host seeded without its real cloned voice carries a sentinel id that is
  // deliberately not a valid provider reference. Reaching publish on one means
  // the episode was voiced by a fallback (or a shared default), which is a
  // wrong-voice release — the one failure a listener notices immediately and
  // that cannot be walked back once the RSS item is out. Named env var in the
  // message so the fix is obvious without reading the seed.
  const castHostIds = Array.isArray(episode.hostIds) ? episode.hostIds.filter(Boolean) : [];
  if (castHostIds.length > 0) {
    const castHosts = await db.aiHost.findMany({
      where: { id: { in: castHostIds } },
      select: { name: true, slug: true, ttsVoiceId: true },
    });
    const unvoiced = castHosts.filter((h) => PLACEHOLDER_VOICE_ID_RE.test(h.ttsVoiceId || ""));
    if (unvoiced.length > 0) {
      checks.noPlaceholderVoice = false;
      for (const h of unvoiced) {
        errorReasons.push(
          `${h.name} (${h.slug}) has no real voice yet — ttsVoiceId is the '${h.ttsVoiceId}' placeholder. ` +
            `Create the cloned voice first. ${VOICE_ENV_HELP}`
        );
      }
    }
  }

  const eligible = Object.values(checks).every((v) => v === true);
  return {
    eligible,
    checks,
    errorReasons,
    resolvedSize,
    missingConfig,
    integrity,
  };
}

/**
 * Which lines to re-voice so the recordings say what the script says again.
 * Line-voiced: every recorded line whose words changed. Scene-voiced: ONE line
 * per outdated scene, because re-voicing a line re-performs its whole scene
 * (and re-mixes) - so only the affected scenes are redone.
 */
export async function staleAudioLineIndexes(scriptId: string): Promise<number[]> {
  const script = await db.script.findUnique({
    where: { id: scriptId },
    select: { content: true, audioSegments: true, episode: { select: { ttsRenderMode: true } } },
  });
  if (!script) return [];
  const sceneAudio = await db.dialogueSceneAudio.findMany({ where: { scriptId } });
  const integrity = evaluateArtifactIntegrity({
    scriptId, content: script.content, ttsRenderMode: script.episode?.ttsRenderMode ?? null,
    episodeAudioUrl: null, lineAudio: script.audioSegments, sceneAudio, renders: [],
  });
  if (integrity.mode !== "scene") return integrity.staleLines;
  const stale = new Set(integrity.staleScenes);
  return sceneAudio
    .filter((s) => s.selected && s.status === "ready" && stale.has(s.sceneIndex))
    .map((s) => s.firstLineIndex)
    .sort((a, b) => a - b);
}

/**
 * Read-modify-write a script's content with the row locked, so two editors
 * (or an edit and a release) cannot interleave: the second waits and then
 * reads the first one's result instead of overwriting it. `change` returns the
 * new content, or null to write nothing.
 */
export async function editScriptContent<T>(
  scriptId: string,
  change: (content: any) => { content: any; plainText?: string; result: T } | { content: null; result: T }
): Promise<T | null> {
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "Script" WHERE "id" = ${scriptId} FOR UPDATE`;
    const script = await tx.script.findUnique({ where: { id: scriptId }, select: { content: true } });
    if (!script) return null;
    const out = change((script.content as any) || {});
    if (out.content !== null) {
      await tx.script.update({ where: { id: scriptId }, data: { content: out.content, ...("plainText" in out && out.plainText !== undefined ? { plainText: out.plainText } : {}) } });
    }
    return out.result;
  // A release may hold this row for up to 60s (withReleaseLock). The client's
  // default 5s limit would fail a waiting edit instead of letting it land.
  }, { timeout: 75_000, maxWait: 15_000 });
}

/**
 * Validate and write as ONE step. The script and episode rows are locked for
 * the duration, so a line edit, a new script save or a finishing re-mix cannot
 * land between "the gate said yes" and "the episode went out": they wait, and
 * the next gate read sees them. The gate itself reads committed data on other
 * connections, which is exactly the state being locked.
 */
async function withReleaseLock<T>(scriptId: string, episodeId: string, fn: (tx: Parameters<Parameters<typeof db.$transaction>[0]>[0]) => Promise<T>): Promise<T> {
  return db.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Episode" WHERE "id" = ${episodeId} FOR UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "Script" WHERE "id" = ${scriptId} FOR UPDATE`;
      return fn(tx);
    },
    { timeout: 60_000, maxWait: 15_000 }
  );
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

    // Determine GUID (stable: never change if already exists)
    const episodeId = script.episode.id;
    const rssGuid = script.episode.rssGuid || `take-machine:${episodeId}:${script.id}`;

    const { val, updatedEpisode } = await withReleaseLock(scriptId, episodeId, async (tx) => {
      const val = await validateEpisodeForRss(scriptId, "prepare");
      if (!val.eligible) {
        throw new Error(`Publishing preparation failed. Blockers: ${val.errorReasons.join("; ")}`);
      }
      const updatedEpisode = await tx.episode.update({
        where: { id: episodeId },
        data: {
          status: "publish_ready",
          audioFileSizeBytes: val.resolvedSize,
          rssGuid,
        },
      });
      return { val, updatedEpisode };
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

    // Determine publishedAt (stable unless forceRepublish is true)
    const episodeId = script.episode.id;
    const publishedAt =
      script.episode.publishedAt && !forceRepublish
        ? script.episode.publishedAt
        : new Date();

    const { val, updatedEpisode } = await withReleaseLock(scriptId, episodeId, async (tx) => {
      const val = await validateEpisodeForRss(scriptId, "publish");
      if (!val.eligible) {
        throw new Error(`Publishing failed. Blockers: ${val.errorReasons.join("; ")}`);
      }
      const updatedEpisode = await tx.episode.update({
        where: { id: episodeId },
        data: {
          status: "published",
          publishedAt,
        },
      });
      return { val, updatedEpisode };
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
      // What exactly went out: the published artifact's own provenance record.
      released: {
        audioUrl: updatedEpisode.audioUrl,
        scriptFingerprint: val.integrity?.scriptFingerprint ?? null,
        masterProof: val.integrity?.masterProof ?? null,
      },
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
