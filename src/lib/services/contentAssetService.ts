import { db } from "../db";
import { formatChapterTime } from "../chapterTime";
import {
  describeChapterViolations,
  rescaleChapterTimeline,
  timelineRescaleFactor,
  validateChapterTimeline,
  type ChapterTiming,
} from "../chapterTimeline";
import { MAX_SONIC_LOGO_MS, resolveOpeningPlan } from "../audio/openingTiming";
import { planConversationTimeline, type PlannedLine, type SegmentBreak } from "../audio/assembly";
import { getStorageProvider } from "../providers/storage/factory";
import { getRoleLLMProvider, roleHasRealProvider, roleProviderLabel } from "../providers/llm/routing";
import { withLlmStage } from "../providers/llm/costLedger";
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

// Cast-NEUTRAL show-notes schema.
//
// These keys used to be `maxVoltageAngle` / `drLinebreakAngle` — the names of
// two retired hosts, baked into the JSON schema the live LLM prompt tells the
// model to emit. The cast is per-episode (Episode.hostIds + resolveEpisodeHosts)
// and has already been replaced twice, so host names must never appear in a
// structural key. `readKeyDebateAngles` keeps reading blobs persisted under the
// old names.
interface KeyDebateEntry {
  topicTitle: string;
  hostAAngle: string;
  hostBAngle: string;
  whatMakesItDebatable: string;
}

interface DeterministicShowNotes {
  episodeSummary: string;
  keyDebates: KeyDebateEntry[];
  bestLines: {
    speakerName: string;
    quote: string;
  }[];
  sourceGroundedNotes: string[];
}

interface LineTiming {
  lineIndex: number;
  startTimeMs: number;
  endTimeMs: number;
  durationMs: number;
}

/** How the published timestamps were derived — recorded in metadata.json so an
 *  operator can tell a measured timeline from a modelled one. */
type LineTimingBasis =
  | "measured_scene_timing_map"   // provider timestamps / alignment at real scene starts
  | "rendered_scene_spans"        // real scene placement + duration, lines split by word share
  | "rendered_timeline_estimate"  // real clip durations through the renderer's own gap math
  | "text_estimate";              // word-count guesses (no per-line audio at all)

/** Absolute per-line timings from scene timing maps placed at the render's REAL
 *  scene starts. Null when the render or the maps are unavailable. Mirrors
 *  socialClipService.sceneAbsoluteLineTimings — same two sources of truth. */
async function measuredSceneLineTimings(
  episodeId: string,
  scriptId: string
): Promise<Map<number, { startMs: number; endMs: number }> | null> {
  try {
    const render = await db.episodeAudioRender.findFirst({
      where: { episodeId, status: "succeeded", renderMode: "scene" },
      orderBy: { renderVersion: "desc" },
      select: { diagnostics: true },
    });
    const timeline = (render?.diagnostics as { sceneTimeline?: Array<{ sceneIndex: number; startMs: number }> } | null)?.sceneTimeline;
    if (!Array.isArray(timeline) || timeline.length === 0) return null;
    const startBySceneIndex = new Map(timeline.map((t) => [t.sceneIndex, t.startMs]));

    const scenes = await db.dialogueSceneAudio.findMany({
      where: { scriptId, status: "ready", selected: true },
      select: { sceneIndex: true, timingStatus: true, timingMap: true },
    });
    const out = new Map<number, { startMs: number; endMs: number }>();
    for (const scene of scenes) {
      const base = startBySceneIndex.get(scene.sceneIndex);
      if (base === undefined) continue;
      if (scene.timingStatus === "timing_unavailable" || !Array.isArray(scene.timingMap)) continue;
      for (const u of scene.timingMap as Array<{ lineIndex: number; startMs: number; endMs: number }>) {
        if (!Number.isFinite(u?.startMs) || !Number.isFinite(u?.endMs)) continue;
        out.set(u.lineIndex, { startMs: base + u.startMs, endMs: base + u.endMs });
      }
    }
    return out.size > 0 ? out : null;
  } catch (err) {
    console.warn("[contentAssets] Could not read measured scene line timings:", err);
    return null;
  }
}

/** Fallback for scene-voiced episodes without timing maps: real scene START and
 *  real scene DURATION bound each scene, and its lines are distributed inside
 *  that real window by word share. Approximate per line, but every line is
 *  provably inside audio that exists. */
async function sceneSpanLineTimings(
  episodeId: string,
  scriptId: string
): Promise<Map<number, { startMs: number; endMs: number }> | null> {
  try {
    const render = await db.episodeAudioRender.findFirst({
      where: { episodeId, status: "succeeded", renderMode: "scene" },
      orderBy: { renderVersion: "desc" },
      select: { diagnostics: true },
    });
    const timeline = (render?.diagnostics as { sceneTimeline?: Array<{ sceneIndex: number; startMs: number }> } | null)?.sceneTimeline;
    if (!Array.isArray(timeline) || timeline.length === 0) return null;
    const startBySceneIndex = new Map(timeline.map((t) => [t.sceneIndex, t.startMs]));

    const scenes = await db.dialogueSceneAudio.findMany({
      where: { scriptId, status: "ready", selected: true },
      select: { sceneIndex: true, durationMs: true, lineIndexes: true },
      orderBy: { sceneIndex: "asc" },
    });
    const script = await db.script.findUnique({ where: { id: scriptId }, select: { content: true } });
    const textByLine = new Map<number, string>();
    for (const seg of ((script?.content as { segments?: Array<{ lines?: Array<{ lineIndex: number; text: string }> }> } | null)?.segments ?? [])) {
      for (const l of seg.lines ?? []) textByLine.set(l.lineIndex, l.text ?? "");
    }

    const out = new Map<number, { startMs: number; endMs: number }>();
    for (const scene of scenes) {
      const base = startBySceneIndex.get(scene.sceneIndex);
      const dur = scene.durationMs ?? 0;
      const idxs = Array.isArray(scene.lineIndexes) ? (scene.lineIndexes as number[]) : [];
      if (base === undefined || dur <= 0 || idxs.length === 0) continue;
      const weights = idxs.map((i) => Math.max(1, (textByLine.get(i) ?? "").split(/\s+/).filter(Boolean).length));
      const total = weights.reduce((a, b) => a + b, 0);
      let cursor = base;
      idxs.forEach((lineIndex, k) => {
        const share = Math.round((weights[k] / total) * dur);
        out.set(lineIndex, { startMs: cursor, endMs: cursor + share });
        cursor += share;
      });
    }
    return out.size > 0 ? out : null;
  } catch (err) {
    console.warn("[contentAssets] Could not read scene span timings:", err);
    return null;
  }
}

/** Backward-compatible read of a keyDebates entry: new cast-neutral keys first,
 *  then the retired-host keys still present in already-persisted show notes. */
function readKeyDebateAngles(kd: Record<string, unknown>): { hostAAngle: string; hostBAngle: string } {
  const pick = (...keys: string[]): string => {
    for (const k of keys) {
      const v = kd?.[k];
      if (typeof v === "string" && v.trim()) return v;
    }
    return "";
  };
  return {
    hostAAngle: pick("hostAAngle", "maxVoltageAngle"),
    hostBAngle: pick("hostBAngle", "drLinebreakAngle"),
  };
}

function buildDeterministicShowNotes(episode: any, script: any, hostA: any, hostB: any): DeterministicShowNotes {
  const summary = episode.description?.trim() || `In this episode of Take Machine, hosts ${hostA.name} and ${hostB.name} deep dive into sports topics. They debate key arguments and statistics.`;

  const keyDebates = episode.topics.map((et: any) => {
    const rb = et.topic.researchBrief;
    return {
      topicTitle: et.topic.title,
      hostAAngle: rb?.argumentForHostA?.trim() || et.topic.summary?.trim() || "No approved source-grounded angle available.",
      hostBAngle: rb?.argumentForHostB?.trim() || et.topic.summary?.trim() || "No approved source-grounded angle available.",
      whatMakesItDebatable: "No approved source-grounded angle available."
    };
  });

  const segments = (script.content as any).segments || [];
  let quoteA = "";
  let quoteB = "";

  for (const seg of segments) {
    if (!seg.lines) continue;
    for (const line of seg.lines) {
      const text = line.text.trim();
      const words = text.split(/\s+/).length;
      if (words >= 5 && words <= 20) {
        if (line.speakerName === hostA.name && !quoteA) quoteA = text;
        if (line.speakerName === hostB.name && !quoteB) quoteB = text;
      }
      if (quoteA && quoteB) break;
    }
    if (quoteA && quoteB) break;
  }

  const bestLines: { speakerName: string; quote: string }[] = [];
  if (quoteA) bestLines.push({ speakerName: hostA.name, quote: quoteA });
  if (quoteB) bestLines.push({ speakerName: hostB.name, quote: quoteB });

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

      // 14. needsHumanReview is NOT a hard block here. Content assets (show
      // notes / transcript / chapters) are metadata for audio that already
      // exists by this stage — refusing to build them strands a finished
      // episode with no way forward. Human-review enforcement lives at the
      // publish gate (validateEpisodeForRss / attemptPublish), which still
      // blocks going live on unresolved claims. Proceed regardless.
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

  // SCENE-VOICED EPISODES HAVE NO PER-LINE AudioSegment ROWS.
  //
  // There are two voicing paths and they write to two different tables: the
  // legacy per-line path writes AudioSegment, and scene mode writes
  // DialogueSceneAudio. The stitcher understands both — which is why the mix
  // succeeds — but this stage only ever read AudioSegment, so a fully voiced,
  // fully mixed, finished episode failed here with "Line 0 does not have a
  // matching AudioSegment" and stopped at the last stage of six.
  //
  // Per-line rows are used for ONE thing below: exact chapter timestamps. The
  // code already estimates a duration from word count when a row is missing and
  // already reports that by leaving timestampsApproximate = true. So the right
  // behaviour for a scene-voiced episode is approximate chapters, not a dead
  // episode — the audio it is describing demonstrably exists.
  const sceneVoiced =
    audioSegments.length === 0 &&
    (await db.dialogueSceneAudio.count({ where: { scriptId, status: "ready" } })) > 0;
  if (sceneVoiced) {
    console.warn(
      `[contentAssets] Script ${scriptId} is scene-voiced (no per-line AudioSegment rows). ` +
        `Chapter timestamps will be estimated and reported as approximate.`
    );
  }

  for (const item of allLines) {
    const lineIndex = item.line.lineIndex;
    const list = segmentMap.get(lineIndex) || [];

    // 11. Matching AudioSegment exists — not applicable to scene-voiced episodes.
    if (list.length === 0) {
      if (sceneVoiced) continue;
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
  // Default to approximate: true. Only REAL MEASURED per-line timings clear it.
  let timestampsApproximate = true;
  let timingBasis: LineTimingBasis = "text_estimate";

  const segmentGapMs = Number(process.env.AUDIO_SEGMENT_GAP_MS) || 850;

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

  // NO 30-SECOND GUESS.
  //
  // This used to be `introDurationMs = 30000` when the asset could not be
  // measured — a pure invention that pushed every downstream chapter 30s late
  // and was a direct contributor to the 638s-chapters-on-a-515s-MP3 defect. The
  // real bound is the capped opening: after openingTiming.ts no render may put
  // more than MAX_SONIC_LOGO_MS of theme in front of the first spoken word.
  if (includeIntro && introDurationMs === 0) {
    introDurationMs = MAX_SONIC_LOGO_MS;
    timestampsApproximate = true;
    console.warn(`[contentAssets] Intro duration unmeasurable; assuming the ${MAX_SONIC_LOGO_MS}ms sonic-logo cap.`);
  }
  if (includeOutro && outroDurationMs === 0) {
    // The outro sits AFTER the last chapter, so an unmeasured outro affects only
    // the fallback total, never a chapter endpoint. Do not invent a length.
    timestampsApproximate = true;
    console.warn("[contentAssets] Outro duration unmeasurable; excluded from the estimated total.");
  }

  // Where speech actually starts, under the same cap the stitcher enforces.
  const dialogueStartMs = includeIntro
    ? resolveOpeningPlan({ introDurationMs }).dialogueStartMs
    : 0;

  // ---- PREFER REAL MEASURED TIMINGS ---------------------------------------
  // Order of preference:
  //   1. Scene timing maps (provider timestamps / forced alignment) placed at
  //      the render's REAL scene starts -> genuinely measured, not approximate.
  //   2. Real scene spans (measured scene durations + real placement), lines
  //      distributed within a scene by word share -> approximate but bounded by
  //      real audio.
  //   3. The actual renderer's timeline math (planConversationTimeline) fed
  //      with real AudioSegment durations -> models jitter and interruption
  //      OVERLAPS, which the old flat 450ms walk ignored entirely.
  const measuredLineTimings = await measuredSceneLineTimings(episode.id, scriptId);
  const sceneSpanTimings = measuredLineTimings ? null : await sceneSpanLineTimings(episode.id, scriptId);

  let lineTimings: LineTiming[] = [];
  if (measuredLineTimings && allLines.every((it) => measuredLineTimings.has(it.line.lineIndex))) {
    timingBasis = "measured_scene_timing_map";
    lineTimings = allLines.map((it) => {
      const m = measuredLineTimings.get(it.line.lineIndex)!;
      return { lineIndex: it.line.lineIndex, startTimeMs: m.startMs, endTimeMs: m.endMs, durationMs: Math.max(0, m.endMs - m.startMs) };
    });
  } else if (sceneSpanTimings && allLines.every((it) => sceneSpanTimings.has(it.line.lineIndex))) {
    timingBasis = "rendered_scene_spans";
    lineTimings = allLines.map((it) => {
      const m = sceneSpanTimings.get(it.line.lineIndex)!;
      return { lineIndex: it.line.lineIndex, startTimeMs: m.startMs, endTimeMs: m.endMs, durationMs: Math.max(0, m.endMs - m.startMs) };
    });
  } else {
    timingBasis = allLines.every((it) => (segmentMap.get(it.line.lineIndex) || [])[0]?.durationMs > 0)
      ? "rendered_timeline_estimate"
      : "text_estimate";
    const plannedLines: PlannedLine[] = allLines.map((curr, i) => {
      const prev = i > 0 ? allLines[i - 1] : null;
      const as = (segmentMap.get(curr.line.lineIndex) || [])[0];
      let dur = as?.durationMs || 0;
      if (dur <= 0) {
        // Last-resort estimate: 150 wpm => 400ms per word.
        const wordCount = curr.line.text.split(/\s+/).filter(Boolean).length;
        dur = Math.max(1000, wordCount * 400);
      }
      const segmentBreak: SegmentBreak = !prev || curr.segmentIndex === prev.segmentIndex
        ? "none"
        : curr.segmentType === "topic" ? "topic" : "segment";
      return {
        filePath: "",
        durationMs: dur,
        lineIndex: curr.line.lineIndex,
        hostSlot: 0,
        pauseBefore: curr.line.pauseBefore,
        isInterruption: curr.line.isInterruption === true,
        segmentBreak,
      };
    });
    // The renderer's own math: jittered gaps and NEGATIVE gaps on interruptions
    // (up to 40% of the previous line). The old walk added a flat 450ms between
    // every pair and ignored interruptions, so it drifted long on every episode.
    const clips = planConversationTimeline(plannedLines, { startAtMs: dialogueStartMs });
    lineTimings = plannedLines.map((pl, i) => ({
      lineIndex: pl.lineIndex,
      startTimeMs: clips[i].startMs,
      endTimeMs: clips[i].startMs + clips[i].durationMs,
      durationMs: clips[i].durationMs,
    }));
  }

  let currentTimeMs = lineTimings.length ? Math.max(...lineTimings.map((t) => t.endTimeMs)) : dialogueStartMs;
  if (includeOutro && outroDurationMs > 0) {
    currentTimeMs += segmentGapMs; // gap before outro
    currentTimeMs += outroDurationMs;
  }

  // ONLY measured per-line timings are exact. A timeline assembled from real
  // clip durations but MODELLED gaps is still an estimate: it does not know the
  // per-break stinger room the stitcher may have opened, nor the exact jitter
  // seed state of the shipped render. Keeping the flag honest here is the point
  // — it used to be cleared to false whenever every AudioSegment merely had a
  // duration, which is how impossible timestamps shipped labelled as exact.
  timestampsApproximate = timingBasis !== "measured_scene_timing_map" || timestampsApproximate;

  const calculatedDurationSeconds = Math.round(currentTimeMs / 1000);
  const finalDurationSeconds = episode.durationSeconds || calculatedDurationSeconds;

  // ---- RECONCILE ESTIMATE AGAINST THE REAL AUDIO --------------------------
  // These two numbers were computed independently and never compared. If the
  // walk overruns the measured master, compress it proportionally onto the real
  // duration: the SHAPE of the episode is the part we know, the absolute scale
  // is the part the master already settled.
  const finalDurationMs = finalDurationSeconds * 1000;
  const rescaleFactor = timelineRescaleFactor(currentTimeMs, finalDurationMs);
  if (rescaleFactor !== 1) {
    console.warn(
      `[contentAssets] Estimated timeline (${Math.round(currentTimeMs)}ms, basis=${timingBasis}) overruns the real ` +
        `audio (${finalDurationMs}ms). Rescaling chapter timings by ${rescaleFactor.toFixed(4)}.`
    );
    lineTimings = lineTimings.map((t) => ({
      lineIndex: t.lineIndex,
      startTimeMs: Math.round(t.startTimeMs * rescaleFactor),
      endTimeMs: Math.round(t.endTimeMs * rescaleFactor),
      durationMs: Math.round(t.durationMs * rescaleFactor),
    }));
    currentTimeMs = Math.round(currentTimeMs * rescaleFactor);
    timestampsApproximate = true;
  }

  // Chapter/duration stamps live in lib/chapterTime so they can be tested
  // against real values instead of a copy — see testPublishedArtifacts.
  const formatTime = formatChapterTime;

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
        // Null on a scene-voiced episode: those have no per-line AudioSegment
        // rows at all (the audio lives in DialogueSceneAudio). The transcript
        // JSON is still complete and correctly timed — this field is a
        // provenance pointer, not content — so it is omitted rather than
        // crashing the stage on a finished episode.
        audioSegmentId: matchingSeg ? matchingSeg.id : null,
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

  let chapters: ChapterTiming[] = jsonSegments.map((js) => {
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

  // ---- HARD CHAPTER GATE ---------------------------------------------------
  // Nothing used to compare chapters[last].endTimeSeconds to the real audio
  // duration, which is how a 638s chapter list shipped against a 515s MP3.
  // Chapters must be monotonic and must fit inside the audio they describe.
  // A second-pass rescale catches residual overhang from per-segment rounding;
  // anything still invalid is a REJECT, not a warning — impossible timestamps
  // must never reach the feed.
  let chapterValidation = validateChapterTimeline(chapters, finalDurationSeconds);
  if (!chapterValidation.ok && chapterValidation.violations.some((v) => v.code === "exceeds_audio_duration")) {
    const factor = timelineRescaleFactor(chapterValidation.timelineEndSeconds, finalDurationSeconds);
    const scale = (v: number) => Math.round(Number(v) * factor * 10) / 10;
    chapters = rescaleChapterTimeline(chapters, finalDurationSeconds);
    // Keep transcript + topic views consistent with the published chapters —
    // one timeline, scaled once, everywhere it is quoted.
    for (const js of jsonSegments) {
      js.startTimeSeconds = scale(js.startTimeSeconds);
      js.endTimeSeconds = scale(js.endTimeSeconds);
      for (const jl of js.lines) {
        jl.startTimeSeconds = scale(jl.startTimeSeconds);
        jl.endTimeSeconds = scale(jl.endTimeSeconds);
        jl.durationMs = Math.round(jl.durationMs * factor);
      }
    }
    transcriptJson.segments = jsonSegments;
    timestampsApproximate = true;
    chapterValidation = validateChapterTimeline(chapters, finalDurationSeconds);
    console.warn(
      `[contentAssets] Chapter timeline overran the final audio and was rescaled onto ${finalDurationSeconds}s (factor ${factor.toFixed(4)}).`
    );
  }
  if (!chapterValidation.ok) {
    throw new Error(
      `Refusing to publish an impossible chapter timeline for episode ${episode.id} ` +
        `(basis=${timingBasis}, final audio ${finalDurationSeconds}s, timeline ends ${chapterValidation.timelineEndSeconds}s): ` +
        describeChapterViolations(chapterValidation)
    );
  }

  // Generate show notes from the FINAL persisted script (script.plainText below
  // is the approved, self-verified, antithesis-passed text — not the draft).
  //
  // An explicit providerOverride still wins, because callers use it to force the
  // deterministic builder. Otherwise ask ROUTING whether the show_notes role has
  // a real model: reading LLM_PROVIDER directly would silently fall back to the
  // deterministic notes whenever a profile routes this role elsewhere.
  let showNotesJson: DeterministicShowNotes;
  const useDeterministic = providerOverride
    ? providerOverride.toLowerCase() === "stub"
    : !roleHasRealProvider("show_notes");

  if (useDeterministic) {
    showNotesJson = buildDeterministicShowNotes(episode, script, hostA, hostB);
  } else {
    try {
      const llm = getRoleLLMProvider("show_notes");

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
      "hostAAngle": "${hostA.name}'s argument/angle.",
      "hostBAngle": "${hostB.name}'s argument/angle.",
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

      const res = await withLlmStage("content-assets:show-notes", () =>
        llm.generateStructuredOutput<any>({
          prompt,
          systemPrompt,
          temperature: 0.2,
        })
      );

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

      // Normalize the model's reply onto the cast-neutral keys, accepting the
      // retired-host keys it may still emit from an older prompt/cache.
      const normalizedDebates: KeyDebateEntry[] = (Array.isArray(res.keyDebates) ? res.keyDebates : []).map((kd: Record<string, unknown>) => {
        const angles = readKeyDebateAngles(kd);
        return {
          topicTitle: typeof kd?.topicTitle === "string" ? kd.topicTitle : "",
          hostAAngle: angles.hostAAngle,
          hostBAngle: angles.hostBAngle,
          whatMakesItDebatable: typeof kd?.whatMakesItDebatable === "string" ? kd.whatMakesItDebatable : "",
        };
      });

      showNotesJson = {
        episodeSummary: res.episodeSummary || "",
        keyDebates: normalizedDebates,
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
    // Tolerant read: a model reply (or a blob persisted before the rename) may
    // still carry the retired-host keys.
    const angles = readKeyDebateAngles(kd as unknown as Record<string, unknown>);
    showNotesMarkdown += `### ${kd.topicTitle}\n\n`;
    showNotesMarkdown += `* ${hostA.name} angle: ${angles.hostAAngle}\n`;
    showNotesMarkdown += `* ${hostB.name} angle: ${angles.hostBAngle}\n`;
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
      // How the timestamps above were derived, so "approximate" is auditable
      // rather than a bare boolean.
      timingBasis,
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
      timingBasis,
      // Report what actually produced the notes, including the routed chain, so
      // the artifact records the real provider rather than a global variable.
      generatedWithProvider: useDeterministic
        ? providerOverride || "stub"
        : roleProviderLabel("show_notes"),
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
