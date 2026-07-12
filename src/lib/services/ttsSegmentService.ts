import { db } from "@/lib/db";
import { getStorageProvider } from "@/lib/providers/storage/factory";
import { getTTSProvider } from "@/lib/providers/tts/factory";
import { sanitizeForBosonTts, sanitizeForGenericTts } from "@/lib/providers/tts/sanitizer";
import {
  ResolvedTtsVoice,
  TtsVoiceOverrides,
  getTtsModelId,
  resolveTtsProviderAndVoice,
} from "@/lib/providers/tts/voiceResolution";
import { hasLineIndexCollisions, normalizeLineIndexes } from "@/lib/services/scriptRepetition";
import { resolveEpisodeHosts, makeSpeakerMatchers } from "@/lib/services/hostCasting";

// Episode statuses in which (re)generating audio segments is allowed: from
// the moment the episode passes fact check all the way through published.
// Re-voicing after a stitch or a voice-engine change is a normal operation —
// requiring exactly "fact_checked" made the TTS console vanish forever the
// moment a generation succeeded.
export const TTS_ELIGIBLE_EPISODE_STATUSES = [
  "fact_checked",
  "audio_segments_ready",
  "audio_stitching",
  "audio_ready",
  "content_ready",
  "publish_ready",
  "published",
];

interface TtsSegmentInput {
  scriptId: string;
  forceRegenerate?: boolean;
  segmentRange?: {
    startLineIndex: number;
    endLineIndex: number;
  };
  hostId?: string;
  providerOverride?: string;
  /** Per-run voice picks keyed by host slug (or id); provider-tagged so they
   *  only apply when they match the resolved engine. */
  voiceOverrides?: TtsVoiceOverrides;
}

function cleanTextForSpeech(txt: string): string {
  // Strip markdown noise but keep [audio tags] and em dashes — both carry
  // delivery information for the TTS engines.
  return txt
    .replace(/[*_`#~]/g, "") // remove markdown characters
    .replace(/\s+/g, " ")     // normalize spaces
    .trim();
}

function buildVoiceDirection(host: { name: string; role: string; speakingStyle: string; intensityLevel: number }): string {
  return `You are "${host.name}", a sports debate podcast host mid-episode, talking to your co-host. ${host.role}. Delivery style: ${host.speakingStyle} Overall intensity ${host.intensityLevel}/10.`;
}

export async function generateTtsSegments(input: TtsSegmentInput) {
  const { scriptId, forceRegenerate = false, segmentRange, hostId, providerOverride, voiceOverrides } = input;

  // 1. Load Script, Episode, latest passed FactCheckResult
  const script = await db.script.findUnique({
    where: { id: scriptId },
    include: {
      episode: true,
    },
  });

  if (!script) {
    throw new Error(`Script with ID ${scriptId} not found.`);
  }

  if (script.status !== "approved") {
    console.warn(`[TTS Service] Script ${scriptId} status is '${script.status}' (not approved) — generating anyway on operator request.`);
  }

  if (!script.content || typeof script.content !== "object") {
    throw new Error("Script content is missing or not a structured JSON object.");
  }

  if (!script.plainText || !script.plainText.trim()) {
    throw new Error("Script plainText transcript is empty.");
  }

  if (!script.episode) {
    throw new Error(`Episode with ID ${script.episodeId} not found.`);
  }

  if (!TTS_ELIGIBLE_EPISODE_STATUSES.includes(script.episode.status)) {
    console.warn(`[TTS Service] Episode status is '${script.episode.status}' (has not passed fact check) — generating anyway on operator request.`);
  }

  const latestFactCheck = await db.factCheckResult.findFirst({
    where: { scriptId },
    orderBy: { checkedAt: "desc" },
  });

  if (!latestFactCheck) {
    console.warn(`[TTS Service] No fact check result exists for script ${scriptId} — generating anyway on operator request.`);
  } else if (latestFactCheck.status !== "passed") {
    console.warn(`[TTS Service] Latest fact check status is '${latestFactCheck.status}' — generating anyway on operator request.`);
  }

  // Validate script segments structure
  const segments = (script.content as any).segments;
  if (!Array.isArray(segments) || segments.length === 0) {
    throw new Error("Script content has no valid segments.");
  }

  // SELF-HEAL: older scripts stored the model's own lineIndex numbering,
  // which restarts per segment. AudioSegments are keyed (scriptId, lineIndex),
  // so colliding indexes make one clip serve many lines — the same sentence
  // repeated over and over in the stitched episode. If collisions exist,
  // renumber globally, persist the fix, and wipe the ambiguous audio rows so
  // every line gets its own clip.
  if (hasLineIndexCollisions(segments)) {
    console.warn(`[TTS Service] Script ${scriptId} has duplicate lineIndex values — renumbering globally and resetting its audio segments (repetition-bug repair).`);
    normalizeLineIndexes(segments);
    const updatedContent = { ...(script.content as any), segments };
    await db.$transaction([
      db.script.update({ where: { id: scriptId }, data: { content: updatedContent as any } }),
      db.audioSegment.deleteMany({ where: { scriptId } }),
    ]);
    (script.content as any).segments = segments;
  }

  // Resolve the two hosts this episode was cast with (no hardcoded names).
  const { hostA, hostB } = await resolveEpisodeHosts({ hostIds: script.episode.hostIds });
  const speakers = makeSpeakerMatchers({ hostA, hostB });

  if (hostId && hostId !== hostA.id && hostId !== hostB.id) {
    throw new Error(`Invalid hostId '${hostId}'. Host filter must match one of this episode's cast host IDs (${hostA.name}, ${hostB.name}).`);
  }

  // 2. Flatten and validate dialogue lines
  const allLines: any[] = [];
  for (let sIdx = 0; sIdx < segments.length; sIdx++) {
    const seg = segments[sIdx];
    if (!seg || !Array.isArray(seg.lines)) {
      throw new Error(`Segment at index ${sIdx} is invalid.`);
    }

    for (let lIdx = 0; lIdx < seg.lines.length; lIdx++) {
      const line = seg.lines[lIdx];
      if (
        line.lineIndex === undefined ||
        line.speakerName === undefined ||
        line.speakerHostId === undefined ||
        line.text === undefined ||
        line.tone === undefined ||
        line.isFactualClaim === undefined ||
        line.needsHumanReview === undefined ||
        !Array.isArray(line.evidenceRefs)
      ) {
        throw new Error(`Script line at segment ${sIdx}, index ${lIdx} is missing required fields.`);
      }

      const lineHost = speakers.hostForSpeaker(line.speakerName);
      if (!lineHost) {
        throw new Error(`Line ${line.lineIndex} has invalid speakerName '${line.speakerName}'. Only ${hostA.name} and ${hostB.name} are allowed for this episode.`);
      }

      // Note: a per-line needsHumanReview flag is NOT a hard block here. TTS
      // only runs on scripts whose status is already "approved" (gated above)
      // and whose fact check passed — i.e. a human has already reviewed and
      // signed off. Approval clears these flags going forward; for any script
      // approved before that change, we proceed and just log the flag.
      if (line.needsHumanReview === true) {
        console.warn(`[TTS Service] Line ${line.lineIndex} was flagged needsHumanReview but the script is approved; proceeding.`);
      }

      // Check line host binding matches the host its speakerName resolves to.
      if (line.speakerHostId !== lineHost.id) {
        throw new Error(`Line ${line.lineIndex} speakerHostId does not match the cast profile for ${lineHost.name}.`);
      }

      allLines.push(line);
    }
  }

  const totalLineCount = allLines.length;

  // Same-speaker neighbor lines, used as previous_text/next_text conditioning
  // so an engine keeps the speaker's intonation flowing across the episode
  // instead of resetting on every isolated request.
  const speakerContext = new Map<number, { previousText?: string; nextText?: string }>();
  for (let i = 0; i < allLines.length; i++) {
    const ctx: { previousText?: string; nextText?: string } = {};
    for (let p = i - 1; p >= 0; p--) {
      if (allLines[p].speakerHostId === allLines[i].speakerHostId) {
        ctx.previousText = allLines[p].text;
        break;
      }
    }
    for (let n = i + 1; n < allLines.length; n++) {
      if (allLines[n].speakerHostId === allLines[i].speakerHostId) {
        ctx.nextText = allLines[n].text;
        break;
      }
    }
    speakerContext.set(allLines[i].lineIndex, ctx);
  }

  // 3. Filter lines based on range and host
  let selectedLines = [...allLines];
  if (segmentRange) {
    const { startLineIndex, endLineIndex } = segmentRange;
    selectedLines = selectedLines.filter(
      (line) => line.lineIndex >= startLineIndex && line.lineIndex <= endLineIndex
    );
  }
  if (hostId) {
    selectedLines = selectedLines.filter((line) => line.speakerHostId === hostId);
  }

  if (selectedLines.length === 0) {
    throw new Error("No script lines matched the requested TTS generation filters.");
  }

  const selectedLineCount = selectedLines.length;

  // 4. Initialize metrics
  let skippedReadyCount = 0;
  let createdSegmentCount = 0;
  let updatedSegmentCount = 0;
  let readyCount = 0;
  let failedCount = 0;
  let processingCount = 0;
  let totalDurationMs = 0;
  const failedLines: any[] = [];
  const reasons: string[] = [];
  const providerLineCounts: Record<string, number> = {};

  const maxConcurrency = Number(process.env.TTS_MAX_CONCURRENT_REQUESTS) || 2;
  const retryAttempts = Number(process.env.TTS_RETRY_ATTEMPTS) || 3;

  // Provider resolution (documented in docs/TTS_PROVIDERS.md):
  //   1. providerOverride — explicit choice on THIS trigger (admin console)
  //   2. episode.ttsProvider — engine pinned at build time (create-flow picker)
  //   3. host.ttsProvider — per-host default (resolved per line, below)
  //   4. TTS_PROVIDER env — global default
  // An explicit trigger override re-pins the episode so later re-runs keep
  // using the same engine.
  let episodeProvider = script.episode.ttsProvider || null;
  if (providerOverride && providerOverride !== episodeProvider) {
    await db.episode.update({
      where: { id: script.episodeId },
      data: { ttsProvider: providerOverride },
    });
    episodeProvider = providerOverride;
  }
  const chosenGlobalProvider = providerOverride || episodeProvider || process.env.TTS_PROVIDER || "stub";
  console.log(`[TTS Service] Provider resolution for script ${scriptId}: override=${providerOverride || "-"} episode=${episodeProvider || "-"} env=${process.env.TTS_PROVIDER || "-"} → default '${chosenGlobalProvider}' (per-host settings may apply when no override/episode engine is set).`);

  // Provider-AWARE voice resolution, once per host (documented in
  // docs/TTS_PROVIDERS.md): run override > episode override > host voice
  // (only when the host's own engine matches) > per-provider env fallback >
  // provider safe default. Guarantees a voice id never crosses engines.
  const episodeVoiceOverrides = (script.episode.ttsVoiceOverrides as TtsVoiceOverrides | null) || null;
  const resolvedByHostId = new Map<string, ResolvedTtsVoice>();
  for (const host of [hostA, hostB]) {
    if (!selectedLines.some((line) => line.speakerHostId === host.id)) continue;
    const resolved = resolveTtsProviderAndVoice({
      providerOverride,
      runVoiceOverrides: voiceOverrides,
      episodeProvider,
      episodeVoiceOverrides,
      host: {
        id: host.id,
        slug: host.slug,
        name: host.name,
        ttsProvider: host.ttsProvider,
        ttsVoiceId: host.ttsVoiceId,
      },
      envProvider: process.env.TTS_PROVIDER,
    });
    resolvedByHostId.set(host.id, resolved);
    console.log(`[TTS Service] Voice resolution for ${host.name}: provider=${resolved.provider} voiceId=${resolved.voiceId || "(engine default)"} source=${resolved.voiceSource}`);
  }

  // 5. Worker queue controller
  const queue = [...selectedLines];
  const episodeId = script.episodeId;

  async function processLineWithRetry(line: any, attemptsLeft: number) {
    let segment = await db.audioSegment.findFirst({
      where: { scriptId, lineIndex: line.lineIndex },
    });

    if (segment) {
      if (segment.status === "ready" && !forceRegenerate) {
        skippedReadyCount++;
        readyCount++;
        totalDurationMs += segment.durationMs || 0;
        return;
      }
      updatedSegmentCount++;
    } else {
      createdSegmentCount++;
    }

    const host = speakers.hostForSpeaker(line.speakerName);
    if (!host) {
      throw new Error(`Invalid speakerName '${line.speakerName}' on line ${line.lineIndex}.`);
    }

    const resolved = resolvedByHostId.get(host.id);
    if (!resolved) {
      throw new Error(`No TTS voice resolution computed for host ${host.name}.`);
    }
    const hostProviderName = resolved.provider;

    if (!segment) {
      segment = await db.audioSegment.create({
        data: {
          episodeId,
          scriptId,
          hostId: line.speakerHostId,
          lineIndex: line.lineIndex,
          text: line.text,
          status: "pending",
          provider: hostProviderName,
        },
      });
    }

    await db.audioSegment.update({
      where: { id: segment.id },
      data: { status: "processing" },
    });
    processingCount++;

    let delay = 1000;
    for (let attempt = 1; attempt <= attemptsLeft; attempt++) {
      try {
        const format = process.env.TTS_AUDIO_FORMAT === "wav" ? "wav" : "mp3";
        const ttsProvider = getTTSProvider(hostProviderName);

        // Boson uses <|emotion:...|> tags; the generic sanitizer strips those
        // and markdown/URLs but leaves our [laughs]-style audio tags intact so
        // ElevenLabs v3 / Cartesia can still perform them.
        const sanitizedText = ttsProvider.name === "boson" && process.env.BOSON_TTS_ENABLE_TAGS === "true"
          ? sanitizeForBosonTts(line.text)
          : sanitizeForGenericTts(line.text);

        // Same-speaker neighbor lines for prosody continuity conditioning.
        const context = speakerContext.get(line.lineIndex) || {};
        const ttsResult = await ttsProvider.synthesizeSpeech({
          text: sanitizedText,
          voiceId: resolved.voiceId,
          speakerName: line.speakerName,
          tone: line.tone,
          energy: line.energy,
          isInterruption: line.isInterruption === true,
          previousText: context.previousText ? cleanTextForSpeech(context.previousText) : undefined,
          nextText: context.nextText ? cleanTextForSpeech(context.nextText) : undefined,
          voiceDirection: buildVoiceDirection(host),
          format,
        });

        if (!ttsResult.audioBuffer || ttsResult.audioBuffer.length === 0) {
          throw new Error("TTS provider returned empty audio buffer.");
        }

        const speakerSlug = line.speakerName.toLowerCase().replace(/\s+/g, "-");
        const storageKey = `episodes/${episodeId}/scripts/${scriptId}/segments/${line.lineIndex}-${speakerSlug}.${format}`;

        const storageProvider = getStorageProvider();
        const uploadResult = await storageProvider.putObject({
          key: storageKey,
          body: ttsResult.audioBuffer,
          contentType: ttsResult.contentType || `audio/${format}`,
        });

        // Record exactly which voice produced this clip (never API keys).
        const model = getTtsModelId(resolved.provider);
        await db.audioSegment.update({
          where: { id: segment.id },
          data: {
            status: "ready",
            audioUrl: uploadResult.url,
            durationMs: ttsResult.durationMs || null,
            provider: hostProviderName,
            providerMetadata: {
              provider: resolved.provider,
              voiceId: resolved.voiceId,
              ...(resolved.voiceName ? { voiceName: resolved.voiceName } : {}),
              voiceSource: resolved.voiceSource,
              ...(model ? { model } : {}),
              ...(ttsResult.providerAudioId ? { providerAudioId: ttsResult.providerAudioId } : {}),
              // Fish returns the delivery-cued text it actually synthesized
              // ([angry], [cutting in], ...); persist it so tone/energy
              // reaching the engine is auditable per line.
              ...(typeof (ttsResult.raw as any)?.cuedText === "string"
                ? { cuedText: (ttsResult.raw as any).cuedText }
                : {}),
            },
          },
        });

        readyCount++;
        processingCount--;
        totalDurationMs += ttsResult.durationMs || 0;
        providerLineCounts[hostProviderName] = (providerLineCounts[hostProviderName] || 0) + 1;
        return; // Success!
      } catch (err: any) {
        console.error(`[TTS Service] Attempt ${attempt} failed for Line ${line.lineIndex}: ${err.message}`);

        const isTransient =
          !err.message.includes("is not configured") &&
          !err.message.includes("is stub") &&
          !err.message.includes("voice ID is missing");

        if (attempt === attemptsLeft || !isTransient) {
          await db.audioSegment.update({
            where: { id: segment.id },
            data: { status: "failed" },
          });
          failedCount++;
          processingCount--;
          failedLines.push({ lineIndex: line.lineIndex, reason: err.message });
          reasons.push(`Line #${line.lineIndex + 1} failed: ${err.message}`);
          return;
        }

        let waitTime = delay;
        if (err.message.includes("429") || err.message.includes("rate_limit")) {
          waitTime = Math.max(waitTime, 3000);
        }
        await new Promise((r) => setTimeout(r, waitTime));
        delay *= 2.5;
      }
    }
  }

  async function worker() {
    while (queue.length > 0) {
      const line = queue.shift();
      if (!line) break;
      await processLineWithRetry(line, retryAttempts);
    }
  }

  const workers = Array.from({ length: Math.min(maxConcurrency, queue.length) }, () => worker());
  await Promise.all(workers);

  // 6. Check if EVERY dialogue line has a ready segment with audio. Use
  // per-line readiness (tolerant of duplicate rows) rather than an exact
  // record-count match, which would silently never fire if any duplicate
  // segment rows existed — leaving the episode stuck at fact_checked.
  const allSegments = await db.audioSegment.findMany({
    where: { scriptId },
  });

  const readyLineIndexes = new Set(
    allSegments.filter((s) => s.status === "ready" && s.audioUrl).map((s) => s.lineIndex)
  );
  const isEveryLineReady = allLines.every((l) => readyLineIndexes.has(l.lineIndex));

  if (isEveryLineReady) {
    // Only advance from fact_checked; never clobber a later audio_* status.
    await db.episode.updateMany({
      where: { id: script.episodeId, status: "fact_checked" },
      data: { status: "audio_segments_ready" },
    });
  }

  return {
    episodeId: script.episodeId,
    scriptId,
    provider: chosenGlobalProvider,
    providerLineCounts,
    selectedLineCount,
    skippedReadyCount,
    createdSegmentCount,
    updatedSegmentCount,
    readyCount,
    failedCount,
    processingCount,
    totalDurationMs,
    failedLines,
    reasons,
  };
}
