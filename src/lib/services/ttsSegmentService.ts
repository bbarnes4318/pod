import { db } from "@/lib/db";
import { getStorageProvider } from "@/lib/providers/storage/factory";
import { StubTTSProvider } from "@/lib/providers/tts/stub";
import { ElevenLabsTTSProvider } from "@/lib/providers/tts/elevenlabs";
import { CartesiaTTSProvider } from "@/lib/providers/tts/cartesia";
import { OpenAITTSProvider } from "@/lib/providers/tts/openai";

interface TtsSegmentInput {
  scriptId: string;
  forceRegenerate?: boolean;
  segmentRange?: {
    startLineIndex: number;
    endLineIndex: number;
  };
  hostId?: string;
  providerOverride?: string;
}

function resolveTTSProvider(name: string) {
  switch (name.toLowerCase()) {
    case "elevenlabs":
      return new ElevenLabsTTSProvider();
    case "cartesia":
      return new CartesiaTTSProvider();
    case "openai":
      return new OpenAITTSProvider();
    case "stub":
    default:
      return new StubTTSProvider();
  }
}

function cleanTextForSpeech(txt: string): string {
  return txt
    .replace(/[*_`#~]/g, "") // remove markdown characters
    .replace(/\s+/g, " ")     // normalize spaces
    .trim();
}

export async function generateTtsSegments(input: TtsSegmentInput) {
  const { scriptId, forceRegenerate = false, segmentRange, hostId, providerOverride } = input;

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
    throw new Error(`Script status is '${script.status}'. TTS generation is only allowed for approved scripts.`);
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

  if (script.episode.status !== "fact_checked") {
    throw new Error(`Episode status is '${script.episode.status}'. TTS can only run after the episode status is 'fact_checked'.`);
  }

  const latestFactCheck = await db.factCheckResult.findFirst({
    where: { scriptId },
    orderBy: { checkedAt: "desc" },
  });

  if (!latestFactCheck) {
    throw new Error("No fact check result exists for this script. Fact check must be completed before TTS.");
  }

  if (latestFactCheck.status !== "passed") {
    throw new Error(`Latest fact check status is '${latestFactCheck.status}'. Script must pass fact check before TTS.`);
  }

  // Validate script segments structure
  const segments = (script.content as any).segments;
  if (!Array.isArray(segments) || segments.length === 0) {
    throw new Error("Script content has no valid segments.");
  }

  // Gather active host records
  const hostA = await db.aiHost.findFirst({ where: { name: "Max Voltage", isActive: true } });
  const hostB = await db.aiHost.findFirst({ where: { name: "Dr. Linebreak", isActive: true } });
  if (!hostA || !hostB) {
    throw new Error("Active host profiles for Max Voltage and Dr. Linebreak must be active.");
  }

  if (hostId && hostId !== hostA.id && hostId !== hostB.id) {
    throw new Error(`The provided hostId '${hostId}' does not match either active host profile.`);
  }

  if (!hostA.ttsVoiceId) {
    throw new Error("Max Voltage host profile has no configured voice ID.");
  }

  if (!hostB.ttsVoiceId) {
    throw new Error("Dr. Linebreak host profile has no configured voice ID.");
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

      if (line.speakerName !== "Max Voltage" && line.speakerName !== "Dr. Linebreak") {
        throw new Error(`Line ${line.lineIndex} has invalid speakerName '${line.speakerName}'. Only Max Voltage and Dr. Linebreak are allowed.`);
      }

      if (line.needsHumanReview === true) {
        throw new Error(`Script contains lines marked as requiring human review (Line index: ${line.lineIndex}).`);
      }

      // Check line host bindings
      if (line.speakerName === "Max Voltage" && line.speakerHostId !== hostA.id) {
        throw new Error(`Line ${line.lineIndex} speaker speakerHostId does not match Max Voltage active profile.`);
      }
      if (line.speakerName === "Dr. Linebreak" && line.speakerHostId !== hostB.id) {
        throw new Error(`Line ${line.lineIndex} speaker speakerHostId does not match Dr. Linebreak active profile.`);
      }

      allLines.push(line);
    }
  }

  const totalLineCount = allLines.length;

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

  const maxConcurrency = Number(process.env.TTS_MAX_CONCURRENT_REQUESTS) || 2;
  const retryAttempts = Number(process.env.TTS_RETRY_ATTEMPTS) || 3;
  const chosenGlobalProvider = providerOverride || process.env.TTS_PROVIDER || "stub";

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

    if (!segment) {
      segment = await db.audioSegment.create({
        data: {
          episodeId,
          scriptId,
          hostId: line.speakerHostId,
          lineIndex: line.lineIndex,
          text: line.text,
          status: "pending",
        },
      });
    }

    await db.audioSegment.update({
      where: { id: segment.id },
      data: { status: "processing" },
    });
    processingCount++;

    let host;
    if (line.speakerName === "Max Voltage") {
      host = hostA;
    } else if (line.speakerName === "Dr. Linebreak") {
      host = hostB;
    } else {
      throw new Error(`Invalid speakerName '${line.speakerName}' on line ${line.lineIndex}.`);
    }

    if (!host) {
      throw new Error(`Host profile not found for speaker: ${line.speakerName}`);
    }
    const hostProviderName = providerOverride || host.ttsProvider || process.env.TTS_PROVIDER || "stub";

    let delay = 1000;
    for (let attempt = 1; attempt <= attemptsLeft; attempt++) {
      try {
        const format = process.env.TTS_AUDIO_FORMAT === "wav" ? "wav" : "mp3";
        const ttsProvider = resolveTTSProvider(hostProviderName);

        const ttsResult = await ttsProvider.synthesizeSpeech({
          text: cleanTextForSpeech(line.text),
          voiceId: host.ttsVoiceId,
          speakerName: line.speakerName,
          tone: line.tone,
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

        await db.audioSegment.update({
          where: { id: segment.id },
          data: {
            status: "ready",
            audioUrl: uploadResult.url,
            durationMs: ttsResult.durationMs || null,
          },
        });

        readyCount++;
        processingCount--;
        totalDurationMs += ttsResult.durationMs || 0;
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

        await new Promise((r) => setTimeout(r, delay));
        delay *= 2;
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

  // 6. Check if all dialogue lines for the script are ready
  const allSegments = await db.audioSegment.findMany({
    where: { scriptId },
  });

  const readySegmentsCount = allSegments.filter((s) => s.status === "ready").length;
  const isEveryLineReady = allSegments.length === totalLineCount && readySegmentsCount === totalLineCount;

  if (isEveryLineReady) {
    await db.episode.update({
      where: { id: script.episodeId },
      data: { status: "audio_segments_ready" },
    });
  }

  return {
    episodeId: script.episodeId,
    scriptId,
    provider: chosenGlobalProvider,
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
