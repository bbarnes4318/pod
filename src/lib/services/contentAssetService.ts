import { db } from "../db";
import { getStorageProvider } from "../providers/storage/factory";
import { getLLMProvider } from "../providers/llm/factory";
import { resolveEpisodeHosts, makeSpeakerMatchers } from "./hostCasting";
import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";

// Helper to run ffprobe and get duration
function runFfprobe(ffprobePath: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffprobePath, args);
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (data) => (stdout += data.toString()));
    proc.stderr.on("data", (data) => (stderr += data.toString()));
    proc.on("close", (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`FFprobe exited with code ${code}. Error: ${stderr}`));
    });
  });
}

async function getFileDuration(ffprobePath: string, filePath: string): Promise<number> {
  try {
    const output = await runFfprobe(ffprobePath, [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      filePath,
    ]);
    const sec = parseFloat(output);
    if (!isNaN(sec)) {
      return sec;
    }
  } catch (err) {
    console.warn(`[FFprobe] Failed to get duration for ${filePath}:`, err);
  }
  return 0;
}

interface DeterministicShowNotes {
  episodeSummary: string;
  keyDebates: {
    topicTitle: string;
    maxVoltageAngle: string;
    drLinebreakAngle: string;
    whatMakesItDebatable: string;
  }[];
  bestLines: {
    speakerName: string;
    quote: string;
  }[];
  sourceGroundedNotes: string[];
}

function buildDeterministicShowNotes(episode: any, script: any, hostA: any, hostB: any): DeterministicShowNotes {
  const summary = episode.description?.trim() || `In this episode of Take Machine, hosts Max Voltage and Dr. Linebreak deep dive into sports topics. They debate key arguments and statistics.`;

  const keyDebates = episode.topics.map((et: any) => {
    const rb = et.topic.researchBrief;
    return {
      topicTitle: et.topic.title,
      maxVoltageAngle: rb?.argumentForHostA?.trim() || et.topic.summary?.trim() || "No approved source-grounded angle available.",
      drLinebreakAngle: rb?.argumentForHostB?.trim() || et.topic.summary?.trim() || "No approved source-grounded angle available.",
      whatMakesItDebatable: "No approved source-grounded angle available."
    };
  });

  const segments = (script.content as any).segments || [];
  let maxVoltageQuote = "";
  let drLinebreakQuote = "";

  for (const seg of segments) {
    if (!seg.lines) continue;
    for (const line of seg.lines) {
      const text = line.text.trim();
      const words = text.split(/\s+/).length;
      if (words >= 5 && words <= 20) {
        if (line.speakerName === "Max Voltage" && !maxVoltageQuote) {
          maxVoltageQuote = text;
        }
        if (line.speakerName === "Dr. Linebreak" && !drLinebreakQuote) {
          drLinebreakQuote = text;
        }
      }
      if (maxVoltageQuote && drLinebreakQuote) break;
    }
    if (maxVoltageQuote && drLinebreakQuote) break;
  }

  const bestLines: { speakerName: string; quote: string }[] = [];
  if (maxVoltageQuote) {
    bestLines.push({ speakerName: "Max Voltage", quote: maxVoltageQuote });
  }
  if (drLinebreakQuote) {
    bestLines.push({ speakerName: "Dr. Linebreak", quote: drLinebreakQuote });
  }

  const sourceNotes: string[] = [];
  for (const et of episode.topics) {
    const rb = et.topic.researchBrief;
    if (rb) {
      const facts = Array.isArray(rb.facts) ? rb.facts : [];
      facts.slice(0, 2).forEach((f: any) => {
        if (f?.text) sourceNotes.push(f.text);
      });
      const stats = Array.isArray(rb.stats) ? rb.stats : [];
      stats.slice(0, 1).forEach((s: any) => {
        if (s?.text) sourceNotes.push(s.text);
      });
      if (rb.injuryContext) sourceNotes.push(rb.injuryContext);
      if (rb.oddsContext) sourceNotes.push(rb.oddsContext);
    }
  }

  return {
    episodeSummary: summary,
    keyDebates,
    bestLines,
    sourceGroundedNotes: sourceNotes.slice(0, 8),
  };
}

export async function generateEpisodeContentAssets(input: {
  scriptId: string;
  forceRegenerate?: boolean;
  includeChapters?: boolean;
  includeMarkdown?: boolean;
  includeJson?: boolean;
  providerOverride?: string;
}) {
  const {
    scriptId,
    forceRegenerate = false,
    providerOverride,
  } = input;

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
    throw new Error(`Script with ID ${scriptId} not found.`);
  }

  // 2. Script status must be approved
  if (script.status !== "approved") {
    throw new Error(`Script status is '${script.status}'. Content generation is allowed only for approved scripts.`);
  }

  // 3. Script.content structured JSON
  if (!script.content || typeof script.content !== "object") {
    throw new Error("Script content is missing or is not structured JSON.");
  }

  // 4. Script.plainText exists and not empty
  if (!script.plainText || !script.plainText.trim()) {
    throw new Error("Script plainText transcript is empty.");
  }

  // 5. Linked Episode exists
  const episode = script.episode;
  if (!episode) {
    throw new Error(`Episode not linked to Script ${scriptId}.`);
  }

  // 6. Episode status check
  if (episode.status === "content_generating") {
    throw new Error("Episode is already content_generating. Wait for the current content job to finish or manually reset the status.");
  }

  const isContentReady = episode.status === "content_ready";
  if (isContentReady) {
    if (!forceRegenerate) {
      // skip generation and return existing content metadata
      const storageProvider = getStorageProvider();
      const metadataKey = `episodes/${episode.id}/scripts/${script.id}/content/metadata.json`;
      try {
        const res = await storageProvider.getObject({ key: metadataKey });
        const existingMetadata = JSON.parse(res.body.toString("utf-8"));
        return {
          success: true,
          skipped: true,
          episodeId: episode.id,
          scriptId,
          finalStatus: "skipped",
          transcriptMarkdownUrl: existingMetadata.assets?.transcriptMarkdownUrl || episode.transcriptUrl,
          transcriptJsonUrl: existingMetadata.assets?.transcriptJsonUrl,
          showNotesMarkdownUrl: existingMetadata.assets?.showNotesMarkdownUrl,
          metadataJsonUrl: existingMetadata.assets?.metadataJsonUrl,
          transcriptLineCount: existingMetadata.segments?.reduce((acc: number, s: any) => acc + (s.lines?.length || 0), 0) || 0,
          chapterCount: existingMetadata.chapters?.length || 0,
          topicCount: existingMetadata.topics?.length || 0,
          durationSeconds: existingMetadata.durationSeconds || episode.durationSeconds || 0,
          timestampsApproximate: existingMetadata.timestampsApproximate ?? true,
          generatedWithProvider: existingMetadata.generatedWithProvider || "stub",
          reasons: ["Episode is already content_ready and forceRegenerate is false."],
        };
      } catch (err) {
        console.log("Could not fetch existing metadata JSON from storage, returning skipped response from Episode fields...");
        return {
          success: true,
          skipped: true,
          episodeId: episode.id,
          scriptId,
          finalStatus: "skipped",
          transcriptMarkdownUrl: episode.transcriptUrl,
          transcriptJsonUrl: null,
          showNotesMarkdownUrl: null,
          metadataJsonUrl: null,
          transcriptLineCount: 0,
          chapterCount: 0,
          topicCount: episode.topics?.length || 0,
          durationSeconds: episode.durationSeconds || 0,
          timestampsApproximate: true,
          generatedWithProvider: "stub",
          reasons: ["Episode is already content_ready and forceRegenerate is false."],
        };
      }
    }
  } else if (episode.status !== "audio_ready") {
    throw new Error(`Episode status is '${episode.status}'. Content generation is allowed only when status is 'audio_ready'.`);
  }

  // 7. Episode.audioUrl exists and not empty
  if (!episode.audioUrl || !episode.audioUrl.trim()) {
    throw new Error("Episode final audioUrl is missing or empty.");
  }

  // 9 & 10. Latest FactCheckResult exists and status = passed
  const latestFactCheck = script.factCheckResults[0];
  if (!latestFactCheck) {
    throw new Error("No fact check result exists for this script.");
  }
  if (latestFactCheck.status !== "passed") {
    throw new Error(`Latest fact check status is '${latestFactCheck.status}'. Fact check must pass to generate content assets.`);
  }

  // Resolve the two hosts this episode was cast with (no hardcoded names).
  const { hostA, hostB } = await resolveEpisodeHosts({ hostIds: episode.hostIds });
  const speakers = makeSpeakerMatchers({ hostA, hostB });

  // Flatten lines and perform validations
  const segments = (script.content as any).segments;
  if (!Array.isArray(segments) || segments.length === 0) {
    throw new Error("Script segments are missing or empty.");
  }

  const allLines: any[] = [];
  for (let sIdx = 0; sIdx < segments.length; sIdx++) {
    const seg = segments[sIdx];
    if (!seg || !Array.isArray(seg.lines)) {
      throw new Error(`Segment at index ${sIdx} is invalid.`);
    }
    for (let lIdx = 0; lIdx < seg.lines.length; lIdx++) {
      const line = seg.lines[lIdx];
      
      // Full line schema validation
      if (
        line === null ||
        typeof line !== "object" ||
        line.lineIndex === undefined ||
        line.speakerName === undefined ||
        line.speakerHostId === undefined ||
        line.text === undefined ||
        line.tone === undefined ||
        line.isFactualClaim === undefined ||
        line.needsHumanReview === undefined ||
        !Array.isArray(line.evidenceRefs)
      ) {
        throw new Error(`Script line validation failed at segment ${sIdx}, index ${lIdx}. Missing required fields.`);
      }

      // 14. needsHumanReview = true check
      if (line.needsHumanReview === true) {
        throw new Error(`Script contains lines marked as requiring human review.`);
      }
      // 16 & 17. speakerName is one of the cast hosts, and speakerHostId matches.
      const lineHost = speakers.hostForSpeaker(line.speakerName);
      if (!lineHost) {
        throw new Error(`Line ${line.lineIndex} has invalid speakerName '${line.speakerName}'. Only ${hostA.name} and ${hostB.name} are allowed for this episode.`);
      }
      if (line.speakerHostId !== lineHost.id) {
        throw new Error(`Line ${line.lineIndex} host ID does not match the cast profile for ${lineHost.name}.`);
      }
      allLines.push({
        line,
        segmentIndex: sIdx,
        segmentType: seg.type,
        segmentTitle: seg.title,
      });
    }
  }

  // Check matching AudioSegments
  const audioSegments = script.audioSegments;
  const segmentMap = new Map<number, any[]>();
  for (const as of audioSegments) {
    const list = segmentMap.get(as.lineIndex) || [];
    list.push(as);
    segmentMap.set(as.lineIndex, list);
  }

  for (const item of allLines) {
    const lineIndex = item.line.lineIndex;
    const list = segmentMap.get(lineIndex) || [];
    
    // 11. Matching AudioSegment exists
    if (list.length === 0) {
      throw new Error(`Line ${lineIndex} does not have a matching AudioSegment.`);
    }
    // Detect duplicate AudioSegments
    if (list.length > 1) {
      throw new Error(`Line ${lineIndex} has duplicate AudioSegments (count: ${list.length}).`);
    }

    const as = list[0];
    // 12. AudioSegment.status = ready
    if (as.status !== "ready") {
      throw new Error(`AudioSegment for line ${lineIndex} is not ready (status: ${as.status}).`);
    }
    // 13. AudioSegment.audioUrl exists
    if (!as.audioUrl) {
      throw new Error(`AudioSegment for line ${lineIndex} has missing audioUrl.`);
    }
  }

  // 18, 19, 20. EpisodeTopics, TopicCandidates, ResearchBriefs checks
  if (episode.topics.length === 0) {
    throw new Error("Episode has no linked topics.");
  }

  for (const et of episode.topics) {
    if (!et.topic) {
      throw new Error(`EpisodeTopic ${et.id} is missing its TopicCandidate.`);
    }
    const brief = et.topic.researchBrief;
    if (!brief) {
      throw new Error(`TopicCandidate '${et.topic.title}' is missing its ResearchBrief.`);
    }
    const facts = Array.isArray(brief.facts) ? brief.facts : [];
    const sourceIds = Array.isArray(brief.sourceIds) ? brief.sourceIds : [];
    if (facts.length === 0) {
      throw new Error(`ResearchBrief for topic '${et.topic.title}' has empty facts.`);
    }
    if (sourceIds.length === 0) {
      throw new Error(`ResearchBrief for topic '${et.topic.title}' has empty sourceIds.`);
    }
  }

  // 8. Timestamps walk
  // Default to approximate: true. We only clear it if we are fully deterministic.
  let timestampsApproximate = true;

  const lineGapMs = Number(process.env.AUDIO_LINE_GAP_MS) || 450;
  const segmentGapMs = Number(process.env.AUDIO_SEGMENT_GAP_MS) || 850;
  const topicGapMs = Number(process.env.AUDIO_TOPIC_GAP_MS) || 1200;

  // Query latest successful stitch job log to verify if intro/outro was used
  let includeIntro = false;
  let includeOutro = false;
  try {
    const recentStitchJobs = await db.jobLog.findMany({
      where: {
        jobType: "audio:stitch-final",
        status: "completed",
      },
      orderBy: { createdAt: "desc" },
      take: 10,
    });
    const stitchJob = recentStitchJobs.find(
      (job) => (job.input as any)?.scriptId === scriptId
    );
    if (stitchJob) {
      const inputData = stitchJob.input as any;
      includeIntro = !!inputData.includeIntro;
      includeOutro = !!inputData.includeOutro;
    }
  } catch (err) {
    console.warn("Failed to find stitch job log:", err);
  }

  const ffprobePath = process.env.FFPROBE_PATH || "ffprobe";
  const storageProvider = getStorageProvider();

  // Try to measure intro/outro durations if they were used
  let introDurationMs = 0;
  if (includeIntro && process.env.AUDIO_INTRO_URL) {
    const tempDir = path.join(os.tmpdir(), "take-machine-content");
    fs.mkdirSync(tempDir, { recursive: true });
    const tempPath = path.join(tempDir, `intro-${Date.now()}.mp3`);
    try {
      const res = await storageProvider.getObject({ url: process.env.AUDIO_INTRO_URL });
      fs.writeFileSync(tempPath, res.body);
      const durSec = await getFileDuration(ffprobePath, tempPath);
      introDurationMs = Math.round(durSec * 1000);
      fs.rmSync(tempPath, { force: true });
    } catch (e) {
      console.warn("Failed to measure intro duration:", e);
      timestampsApproximate = true;
    }
  }

  let outroDurationMs = 0;
  if (includeOutro && process.env.AUDIO_OUTRO_URL) {
    const tempDir = path.join(os.tmpdir(), "take-machine-content");
    fs.mkdirSync(tempDir, { recursive: true });
    const tempPath = path.join(tempDir, `outro-${Date.now()}.mp3`);
    try {
      const res = await storageProvider.getObject({ url: process.env.AUDIO_OUTRO_URL });
      fs.writeFileSync(tempPath, res.body);
      const durSec = await getFileDuration(ffprobePath, tempPath);
      outroDurationMs = Math.round(durSec * 1000);
      fs.rmSync(tempPath, { force: true });
    } catch (e) {
      console.warn("Failed to measure outro duration:", e);
      timestampsApproximate = true;
    }
  }

  // Default to approximate if intro/outro is used but duration was not safely measured
  if (includeIntro && introDurationMs === 0) {
    introDurationMs = 30000; // 30s fallback
    timestampsApproximate = true;
  }
  if (includeOutro && outroDurationMs === 0) {
    outroDurationMs = 30000; // 30s fallback
    timestampsApproximate = true;
  }

  let currentTimeMs = 0;
  if (includeIntro) {
    currentTimeMs += introDurationMs;
    currentTimeMs += segmentGapMs; // gap after intro
  }

  const lineTimings: {
    lineIndex: number;
    startTimeMs: number;
    endTimeMs: number;
    durationMs: number;
  }[] = [];

  for (let i = 0; i < allLines.length; i++) {
    const curr = allLines[i];
    const prev = i > 0 ? allLines[i - 1] : null;

    if (prev) {
      if (curr.segmentIndex !== prev.segmentIndex) {
        const isTopic = curr.segmentType === "topic";
        const gap = isTopic ? topicGapMs : segmentGapMs;
        currentTimeMs += gap;
      } else {
        currentTimeMs += lineGapMs;
      }
    }

    const list = segmentMap.get(curr.line.lineIndex) || [];
    const as = list[0];
    let dur = as?.durationMs || 0;
    if (dur <= 0) {
      // Fallback estimate: 150 words per minute => 2.5 words per second => 400ms per word
      const wordCount = curr.line.text.split(/\s+/).filter(Boolean).length;
      dur = Math.max(1000, wordCount * 400);
    }

    const startTimeMs = currentTimeMs;
    const endTimeMs = startTimeMs + dur;
    currentTimeMs = endTimeMs;

    lineTimings.push({
      lineIndex: curr.line.lineIndex,
      startTimeMs,
      endTimeMs,
      durationMs: dur,
    });
  }

  if (includeOutro) {
    currentTimeMs += segmentGapMs; // gap before outro
    currentTimeMs += outroDurationMs;
  }

  // Determine if we can set timestampsApproximate to false
  const allSegmentsHaveDuration = allLines.every(item => {
    const list = segmentMap.get(item.line.lineIndex) || [];
    const as = list[0];
    return as && as.durationMs && as.durationMs > 0;
  });
  const introOk = !includeIntro || (includeIntro && introDurationMs > 0);
  const outroOk = !includeOutro || (includeOutro && outroDurationMs > 0);

  if (allSegmentsHaveDuration && introOk && outroOk) {
    timestampsApproximate = false;
  }

  const calculatedDurationSeconds = Math.round(currentTimeMs / 1000);
  const finalDurationSeconds = episode.durationSeconds || calculatedDurationSeconds;

  function formatTime(sec: number): string {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    if (h > 0) {
      return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    }
    return `${m}:${s.toString().padStart(2, '0')}`;
  }

  const durationStr = formatTime(finalDurationSeconds);

  let transcriptMarkdown = `# ${episode.title}\n\n`;
  transcriptMarkdown += `**Take Machine**\n`;
  transcriptMarkdown += `**Duration:** ${durationStr}\n`;
  transcriptMarkdown += `**Hosts:** ${hostA.name} and ${hostB.name}\n\n`;
  transcriptMarkdown += `## Transcript\n\n`;

  let topicCounter = 0;
  const jsonSegments: any[] = [];

  for (let sIdx = 0; sIdx < segments.length; sIdx++) {
    const seg = segments[sIdx];
    const segLinesTimings = lineTimings.filter(t => 
      seg.lines.some((l: any) => l.lineIndex === t.lineIndex)
    );
    if (segLinesTimings.length === 0) continue;

    const segStartSec = Math.round(segLinesTimings[0].startTimeMs / 100) / 10;
    const segEndSec = Math.round(segLinesTimings[segLinesTimings.length - 1].endTimeMs / 100) / 10;

    let segmentHeader = "";
    if (seg.type === "cold_open") {
      segmentHeader = "Cold Open";
    } else if (seg.type === "closing") {
      segmentHeader = "Closing";
    } else if (seg.type === "topic") {
      topicCounter++;
      segmentHeader = `Topic ${topicCounter}: ${seg.title || "Untitled Topic"}`;
    } else {
      segmentHeader = seg.title || seg.type;
    }

    transcriptMarkdown += `### ${segmentHeader}\n\n`;

    const jsonLines: any[] = [];

    for (const line of seg.lines) {
      const timing = segLinesTimings.find(t => t.lineIndex === line.lineIndex)!;
      // Safe formatting cleanup
      const cleanedText = line.text.trim().replace(/\s+/g, " ");

      transcriptMarkdown += `**${line.speakerName}:** ${cleanedText}\n\n`;

      const matchingSeg = (segmentMap.get(line.lineIndex) || [])[0];

      jsonLines.push({
        lineIndex: line.lineIndex,
        speakerName: line.speakerName,
        speakerHostId: line.speakerHostId,
        text: cleanedText,
        tone: line.tone,
        startTimeSeconds: Math.round(timing.startTimeMs / 100) / 10,
        endTimeSeconds: Math.round(timing.endTimeMs / 100) / 10,
        audioSegmentId: matchingSeg.id,
        durationMs: timing.durationMs,
      });
    }

    jsonSegments.push({
      segmentIndex: sIdx,
      type: seg.type,
      title: seg.title || segmentHeader,
      startTimeSeconds: segStartSec,
      endTimeSeconds: segEndSec,
      lines: jsonLines,
      topicId: seg.topicId,
    });
  }

  const transcriptJson = {
    episodeId: episode.id,
    scriptId: script.id,
    episodeTitle: episode.title,
    durationSeconds: finalDurationSeconds,
    generatedAt: new Date().toISOString(),
    segments: jsonSegments,
  };

  const chapters = jsonSegments.map((js) => {
    let title = js.title;
    if (js.type === "cold_open") title = "Cold Open";
    else if (js.type === "closing") title = "Closing";
    return {
      title,
      startTimeSeconds: js.startTimeSeconds,
      endTimeSeconds: js.endTimeSeconds,
      type: js.type,
    };
  });

  // Generate show notes
  let showNotesJson: DeterministicShowNotes;
  const llmProviderType = providerOverride || process.env.LLM_PROVIDER || "stub";

  if (llmProviderType.toLowerCase() === "stub") {
    showNotesJson = buildDeterministicShowNotes(episode, script, hostA, hostB);
  } else {
    try {
      const llm = getLLMProvider();
      
      const topicsEvidence = episode.topics.map((et: any) => {
        const rb = et.topic.researchBrief!;
        return {
          topicTitle: et.topic.title,
          summary: et.topic.summary,
          facts: rb.facts,
          stats: rb.stats,
          injuryContext: rb.injuryContext,
          oddsContext: rb.oddsContext,
          argumentForHostA: rb.argumentForHostA,
          argumentForHostB: rb.argumentForHostB,
          counterArguments: rb.counterArguments,
          sourceIds: rb.sourceIds,
        };
      });

      const evidencePacket = {
        episodeTitle: episode.title,
        episodeDescription: episode.description,
        topics: topicsEvidence,
        chapterTimestamps: chapters.map(c => `${formatTime(c.startTimeSeconds)} — ${c.title}`),
        transcriptText: script.plainText,
      };

      const systemPrompt = `You are a show notes generator for the sports debate podcast 'Take Machine'.
Your task is to generate show notes grounded ONLY in the provided input evidence packet.
Rules:
1. Do not use outside knowledge or web browsing.
2. Do not invent any new facts, stats, injuries, odds, or quotes.
3. Every claim in the show notes must be grounded in the transcript text or ResearchBrief facts.
4. Quotes in 'bestLines' must be short and verbatim from the transcript text.
5. Do not include any sponsor or ad copy.
6. Do not include any source links unless they are already stored in the ResearchBrief/source records.
7. Return your response as a JSON object matching the requested schema.`;

      const prompt = `Here is the evidence packet:\n${JSON.stringify(evidencePacket, null, 2)}\n\nGenerate the show notes. Output must be a valid JSON object matching this schema:
{
  "episodeSummary": "Short 2-4 sentence summary of the episode.",
  "keyDebates": [
    {
      "topicTitle": "Topic Title",
      "maxVoltageAngle": "${hostA.name}'s argument/angle.",
      "drLinebreakAngle": "${hostB.name}'s argument/angle.",
      "whatMakesItDebatable": "What makes this controversial or debatable."
    }
  ],
  "bestLines": [
    {
      "speakerName": "${hostA.name} or ${hostB.name}",
      "quote": "Short verbatim quote from the transcript."
    }
  ],
  "sourceGroundedNotes": [
    "Fact or stat summary grounded in ResearchBrief evidence"
  ]
}`;

      const res = await llm.generateStructuredOutput<any>({
        prompt,
        systemPrompt,
        temperature: 0.2,
      });

      // Validate bestLines quotes verbatim
      const cleanBestLines: any[] = [];
      const externalTexts: string[] = [];
      for (const et of episode.topics) {
        if (et.topic?.summary) externalTexts.push(et.topic.summary.toLowerCase());
        const rb = et.topic?.researchBrief;
        if (rb) {
          if (rb.argumentForHostA) externalTexts.push(rb.argumentForHostA.toLowerCase());
          if (rb.argumentForHostB) externalTexts.push(rb.argumentForHostB.toLowerCase());
          if (rb.injuryContext) externalTexts.push(rb.injuryContext.toLowerCase());
          if (rb.oddsContext) externalTexts.push(rb.oddsContext.toLowerCase());
          const facts = Array.isArray(rb.facts) ? rb.facts : [];
          facts.forEach((f: any) => {
            if (f?.text) externalTexts.push(f.text.toLowerCase());
          });
          const stats = Array.isArray(rb.stats) ? rb.stats : [];
          stats.forEach((s: any) => {
            if (s?.text) externalTexts.push(s.text.toLowerCase());
          });
          const counterArgs = Array.isArray(rb.counterArguments) ? rb.counterArguments : [];
          counterArgs.forEach((c: any) => {
            if (c?.text) externalTexts.push(c.text.toLowerCase());
          });
        }
      }

      if (res && Array.isArray(res.bestLines)) {
        for (const bl of res.bestLines) {
          if (!bl.quote || !bl.speakerName) continue;
          
          // Must be short (<= 25 words)
          const wordCount = bl.quote.trim().split(/\s+/).length;
          if (wordCount === 0 || wordCount > 25) {
            console.warn(`Quote too long or empty (${wordCount} words): "${bl.quote}". Removing.`);
            continue;
          }

          // Must appear verbatim as a substring of a script line
          const matchedLine = allLines.find(item => 
            item.line.speakerName === bl.speakerName && item.line.text.includes(bl.quote)
          );

          if (!matchedLine) {
            console.warn(`Quote not found verbatim in script: "${bl.quote}" by ${bl.speakerName}. Removing.`);
            continue;
          }

          // Quote is not from ResearchBrief or external source text
          const isNotFromResearchBrief = !externalTexts.some(extText => extText.includes(bl.quote.toLowerCase()));
          if (!isNotFromResearchBrief) {
            console.warn(`Quote is present in ResearchBrief/external text: "${bl.quote}". Removing.`);
            continue;
          }

          cleanBestLines.push({
            speakerName: bl.speakerName,
            quote: bl.quote,
          });
        }
      }

      showNotesJson = {
        episodeSummary: res.episodeSummary || "",
        keyDebates: res.keyDebates || [],
        bestLines: cleanBestLines,
        sourceGroundedNotes: res.sourceGroundedNotes || [],
      };
    } catch (err: any) {
      console.error("LLM show notes generation failed, falling back to deterministic:", err.message);
      showNotesJson = buildDeterministicShowNotes(episode, script, hostA, hostB);
    }
  }

  // Format show notes markdown
  let showNotesMarkdown = `# ${episode.title}\n\n`;
  showNotesMarkdown += `## Episode Summary\n\n`;
  showNotesMarkdown += `${showNotesJson.episodeSummary}\n\n`;
  
  showNotesMarkdown += `## In This Episode\n\n`;
  for (const et of episode.topics) {
    showNotesMarkdown += `* ${et.topic.title}\n`;
  }
  showNotesMarkdown += `\n`;

  showNotesMarkdown += `## Chapters\n\n`;
  for (const c of chapters) {
    showNotesMarkdown += `* ${formatTime(c.startTimeSeconds)} — ${c.title}\n`;
  }
  showNotesMarkdown += `\n`;

  showNotesMarkdown += `## Key Debates\n\n`;
  for (const kd of showNotesJson.keyDebates) {
    showNotesMarkdown += `### ${kd.topicTitle}\n\n`;
    showNotesMarkdown += `* ${hostA.name} angle: ${kd.maxVoltageAngle}\n`;
    showNotesMarkdown += `* ${hostB.name} angle: ${kd.drLinebreakAngle}\n`;
    showNotesMarkdown += `* What makes it debatable: ${kd.whatMakesItDebatable}\n\n`;
  }

  showNotesMarkdown += `## Best Lines\n\n`;
  for (const bl of showNotesJson.bestLines) {
    showNotesMarkdown += `* “${bl.quote}”\n`;
  }
  showNotesMarkdown += `\n`;

  showNotesMarkdown += `## Source-Grounded Notes\n\n`;
  for (const sgn of showNotesJson.sourceGroundedNotes) {
    showNotesMarkdown += `* ${sgn}\n`;
  }
  showNotesMarkdown += `\n`;

  showNotesMarkdown += `## Production Notes\n\n`;
  showNotesMarkdown += `Generated by Take Machine from approved, fact-checked script assets.\n`;

  const previousStatus = episode.status;
  const previousTranscriptUrl = episode.transcriptUrl;
  const previousLongShowNotes = episode.longShowNotes;

  try {
    // 8. Update episode status to content_generating
    await db.episode.update({
      where: { id: episode.id },
      data: { status: "content_generating" },
    });

    const transcriptMdKey = `episodes/${episode.id}/scripts/${script.id}/content/transcript.md`;
    const transcriptJsonKey = `episodes/${episode.id}/scripts/${script.id}/content/transcript.json`;
    const showNotesMdKey = `episodes/${episode.id}/scripts/${script.id}/content/show-notes.md`;
    const metadataJsonKey = `episodes/${episode.id}/scripts/${script.id}/content/metadata.json`;

    // Upload generated files first (All-or-nothing check)
    // 1. put transcript.md
    const uploadTranscriptMd = await storageProvider.putObject({
      key: transcriptMdKey,
      body: Buffer.from(transcriptMarkdown, "utf-8"),
      contentType: "text/markdown",
    });

    // 2. put transcript.json
    const uploadTranscriptJson = await storageProvider.putObject({
      key: transcriptJsonKey,
      body: Buffer.from(JSON.stringify(transcriptJson, null, 2), "utf-8"),
      contentType: "application/json",
    });

    // 3. put show-notes.md
    const uploadShowNotesMd = await storageProvider.putObject({
      key: showNotesMdKey,
      body: Buffer.from(showNotesMarkdown, "utf-8"),
      contentType: "text/markdown",
    });

    // Create final metadata json including URLs
    const metadataJson = {
      episodeId: episode.id,
      scriptId: script.id,
      episodeTitle: episode.title,
      episodeSlug: episode.slug,
      durationSeconds: finalDurationSeconds,
      generatedAt: new Date().toISOString(),
      status: "content_ready",
      summary: showNotesJson.episodeSummary,
      chapters,
      topics: episode.topics.map((et: any) => ({
        topicId: et.topic.id,
        title: et.topic.title,
        summary: et.topic.summary,
        startTimeSeconds: jsonSegments.find(js => js.topicId === et.topicId)?.startTimeSeconds || 0,
        endTimeSeconds: jsonSegments.find(js => js.topicId === et.topicId)?.endTimeSeconds || 0,
      })),
      hosts: [hostA.name, hostB.name],
      assets: {
        transcriptMarkdownUrl: uploadTranscriptMd.url,
        transcriptJsonUrl: uploadTranscriptJson.url,
        showNotesMarkdownUrl: uploadShowNotesMd.url,
        metadataJsonUrl: "", // placeholder
      },
      timestampsApproximate,
    };

    // Predict/upload metadata.json first
    const uploadMetadataJsonFirst = await storageProvider.putObject({
      key: metadataJsonKey,
      body: Buffer.from(JSON.stringify(metadataJson, null, 2), "utf-8"),
      contentType: "application/json",
    });

    metadataJson.assets.metadataJsonUrl = uploadMetadataJsonFirst.url;

    // Final upload of metadata.json
    const uploadMetadataJsonFinal = await storageProvider.putObject({
      key: metadataJsonKey,
      body: Buffer.from(JSON.stringify(metadataJson, null, 2), "utf-8"),
      contentType: "application/json",
    });

    // Only after ALL uploads succeed, update Episode fields in DB
    await db.episode.update({
      where: { id: episode.id },
      data: {
        status: "content_ready",
        transcriptUrl: uploadTranscriptMd.url,
        longShowNotes: showNotesMarkdown,
        durationSeconds: episode.durationSeconds || calculatedDurationSeconds,
      },
    });

    return {
      episodeId: episode.id,
      scriptId: script.id,
      finalStatus: "completed",
      transcriptMarkdownUrl: uploadTranscriptMd.url,
      transcriptJsonUrl: uploadTranscriptJson.url,
      showNotesMarkdownUrl: uploadShowNotesMd.url,
      metadataJsonUrl: uploadMetadataJsonFinal.url,
      transcriptLineCount: allLines.length,
      chapterCount: chapters.length,
      topicCount: episode.topics.length,
      durationSeconds: finalDurationSeconds,
      timestampsApproximate,
      generatedWithProvider: llmProviderType,
      reasons: ["Transcript and show notes generated and stored successfully."],
    };
  } catch (err: any) {
    console.error("Content asset generation failed, restoring previous status:", err.message);
    // Restore previous episode status & existing values on failure
    await db.episode.update({
      where: { id: episode.id },
      data: {
        status: previousStatus,
        transcriptUrl: previousTranscriptUrl,
        longShowNotes: previousLongShowNotes,
      },
    });
    throw err;
  }
}
