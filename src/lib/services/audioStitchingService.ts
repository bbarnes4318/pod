import { db } from "@/lib/db";
import { getStorageProvider } from "@/lib/providers/storage/factory";
import fs from "fs";
import path from "path";
import os from "os";
import {
  PlannedLine,
  TimelineClip,
  getFileDurationMs,
  masterToMp3,
  planConversationTimeline,
  renderTimelineToWav,
  runFfmpeg,
  standardizeClipToWav,
} from "@/lib/audio/assembly";
import { AudioQaReport, analyzeEpisodeAudio } from "@/lib/audio/audioQa";
import {
  LoadedAsset,
  ProductionStyle,
  SfxCategory,
  SfxDensity,
  SfxLineContext,
  SoundDesignAssetSet,
  SoundDesignSummary,
  emptyAssetSet,
  isProductionStyle,
  isSfxDensity,
  mixBedUnderForeground,
  parseEpisodeSoundDesign,
  pickSfxAsset,
  planReactionSfx,
  planStingers,
  shiftTimelineForInsert,
} from "@/lib/audio/soundDesign";
import { hasLineIndexCollisions } from "@/lib/services/scriptRepetition";

interface StitchInput {
  scriptId: string;
  forceRegenerate?: boolean;
  includeIntro?: boolean;
  includeOutro?: boolean;
  normalizeAudio?: boolean;
  targetLufs?: number;
  /** "clean" | "light" | "full" — post-production depth. Falls back to the
   *  episode's saved setting, then the show config default. */
  productionStyle?: string;
  /** "subtle" | "medium" | "hype" — reaction-SFX density (full style only). */
  sfxDensity?: string;
}

/** Script rubric (70%) + audio human-ness checks (30%) → 0-100. */
function computeEpisodeScore(scriptQuality: any, qaReport: AudioQaReport | null) {
  const scriptScore = typeof scriptQuality?.total === "number" ? scriptQuality.total : null;
  let audioScore: number | null = null;
  if (qaReport && Array.isArray(qaReport.checks) && qaReport.checks.length > 0) {
    const pts = qaReport.checks.reduce(
      (a, c) => a + (c.status === "pass" ? 1 : c.status === "warning" ? 0.5 : 0),
      0
    );
    audioScore = Math.round((pts / qaReport.checks.length) * 100);
  }
  if (scriptScore === null && audioScore === null) return null;
  const total = Math.round((scriptScore ?? 60) * 0.7 + (audioScore ?? 60) * 0.3);
  return { total, scriptScore, audioScore, scriptAxes: scriptQuality?.axes ?? null };
}

/**
 * Download + standardize every sound-design asset this stitch needs.
 * Failures are downgraded to warnings — a missing stinger must never sink an
 * episode render. Highlights are rights-gated: only active `highlight`
 * assets with rightsConfirmed=true are ever loaded.
 */
async function loadSoundDesignAssetSet(opts: {
  style: ProductionStyle;
  config: {
    themeIntroAssetId: string | null;
    themeOutroAssetId: string | null;
    bedAssetId: string | null;
    stingerAssetIds: unknown;
  } | null;
  highlightAssetIds: string[];
  tempDir: string;
  storageProvider: { getObject(i: { url: string }): Promise<{ body: Buffer }> };
  ffmpegPath: string;
  ffprobePath: string;
  sampleRate: number;
  warnings: string[];
}): Promise<SoundDesignAssetSet> {
  const set = emptyAssetSet();
  const cfg = opts.config;
  const stingerIds: string[] = Array.isArray(cfg?.stingerAssetIds)
    ? (cfg!.stingerAssetIds as unknown[]).filter((s): s is string => typeof s === "string")
    : [];

  const configuredIds = [
    cfg?.themeIntroAssetId,
    cfg?.themeOutroAssetId,
    cfg?.bedAssetId,
    ...stingerIds,
    ...opts.highlightAssetIds,
  ].filter((id): id is string => !!id);

  const rows = await db.audioAsset.findMany({
    where: {
      isActive: true,
      OR: [
        { id: { in: configuredIds.length > 0 ? configuredIds : ["-"] } },
        // Reaction SFX are picked by category, so load the whole active pool.
        { kind: "sfx" },
      ],
    },
  });

  // Per-kind loudness targets: themes near speech, bed/SFX prepared for
  // their mix gains, highlights at speech level (they ARE content).
  const lufsForKind: Record<string, number> = {
    theme_intro: -17,
    theme_outro: -17,
    bed: -18,
    stinger: -16,
    sfx: -16,
    highlight: -18,
  };

  const prepared = new Map<string, LoadedAsset>();
  for (const row of rows) {
    // Rights gate: an unconfirmed highlight is never mixed in.
    if (row.kind === "highlight" && !row.rightsConfirmed) {
      opts.warnings.push(`Highlight asset '${row.name}' skipped: rights not confirmed.`);
      continue;
    }
    try {
      const rawPath = path.join(opts.tempDir, `asset-${row.id}-raw`);
      const res = await opts.storageProvider.getObject({ url: row.audioUrl });
      fs.writeFileSync(rawPath, res.body);
      const wavPath = path.join(opts.tempDir, `asset-${row.id}.wav`);
      await standardizeClipToWav(opts.ffmpegPath, rawPath, wavPath, {
        sampleRate: opts.sampleRate,
        targetLufs: lufsForKind[row.kind] ?? -17,
      });
      const durationMs = await getFileDurationMs(opts.ffprobePath, wavPath);
      prepared.set(row.id, {
        id: row.id,
        name: row.name,
        kind: row.kind,
        category: row.category,
        filePath: wavPath,
        durationMs,
      });
    } catch (err: any) {
      opts.warnings.push(`Sound asset '${row.name}' failed to load (${err.message}) — skipped.`);
    }
  }

  if (cfg?.themeIntroAssetId) set.intro = prepared.get(cfg.themeIntroAssetId) ?? null;
  if (cfg?.themeOutroAssetId) set.outro = prepared.get(cfg.themeOutroAssetId) ?? null;
  if (cfg?.bedAssetId) set.bed = prepared.get(cfg.bedAssetId) ?? null;
  set.stingers = stingerIds
    .map((id) => prepared.get(id))
    .filter((a): a is LoadedAsset => !!a);
  for (const asset of prepared.values()) {
    if (asset.kind === "sfx" && asset.category) {
      const cat = asset.category as SfxCategory;
      const pool = set.sfxByCategory.get(cat) || [];
      pool.push(asset);
      set.sfxByCategory.set(cat, pool);
    }
    if (asset.kind === "highlight") set.highlights.set(asset.id, asset);
  }
  return set;
}

export async function stitchFinalEpisodeAudio(input: StitchInput) {
  const {
    scriptId,
    forceRegenerate = false,
    includeIntro = false,
    includeOutro = false,
    normalizeAudio = true,
    targetLufs = -16,
  } = input;

  const ffmpegPath = process.env.FFMPEG_PATH || "ffmpeg";
  const ffprobePath = process.env.FFPROBE_PATH || "ffprobe";

  // Create JobLog in running state
  const jobLog = await db.jobLog.create({
    data: {
      jobType: "audio:stitch-final",
      status: "running",
      input: {
        scriptId,
        forceRegenerate,
        includeIntro,
        includeOutro,
        normalizeAudio,
        targetLufs,
        productionStyle: input.productionStyle,
        sfxDensity: input.sfxDensity,
      } as any,
      output: {},
    },
  });

  let previousStatus = "audio_segments_ready";
  let scriptRecord: any = null;

  try {
    // 1. Script & Episode Existence
    scriptRecord = await db.script.findUnique({
      where: { id: scriptId },
      include: { episode: true },
    });

    if (!scriptRecord) {
      throw new Error(`Script with ID ${scriptId} not found.`);
    }

    const script = scriptRecord;
    const episode = script.episode;

    if (!episode) {
      throw new Error(`Episode not linked to Script ${scriptId}.`);
    }

    previousStatus = episode.status;

    if (episode.status === "audio_stitching") {
      throw new Error("Episode is already audio_stitching. Wait for the current stitch job to finish or manually reset the status.");
    }

    // Skip check if already complete and forceRegenerate is false
    if (episode.status === "audio_ready" && !forceRegenerate) {
      const output = {
        episodeId: episode.id,
        scriptId,
        finalStatus: "skipped",
        finalAudioUrl: episode.audioUrl,
        durationSeconds: episode.durationSeconds || 0,
        lineCount: 0,
        audioSegmentCount: 0,
        missingSegmentCount: 0,
        failedSegmentCount: 0,
        duplicateSegmentCount: 0,
        totalInputDurationMs: 0,
        finalFileSizeBytes: 0,
        ffmpegCommandSummary: "skipped",
        storageKey: "",
        reasons: ["Final audio already exists and forceRegenerate is false."],
      };

      await db.jobLog.update({
        where: { id: jobLog.id },
        data: {
          status: "skipped",
          output: output as any,
        },
      });

      return output;
    }

    // 2. Validate Eligibility Gates
    if (script.status !== "approved") {
      throw new Error(`Script status is '${script.status}'. Stitching is only allowed for approved scripts.`);
    }

    if (!script.content || typeof script.content !== "object") {
      throw new Error("Script content is missing or not structured JSON.");
    }

    if (!script.plainText || !script.plainText.trim()) {
      throw new Error("Script plainText transcript is empty.");
    }

    // Accept fact_checked too: the audio-segments_ready flag only flips inside
    // the TTS job, so it can lag even when every line's audio is ready. The
    // per-line readiness check below is the real gate.
    if (
      episode.status !== "audio_segments_ready" &&
      episode.status !== "fact_checked" &&
      !(episode.status === "audio_ready" && forceRegenerate)
    ) {
      throw new Error(`Episode status is '${episode.status}'. Stitching requires 'audio_segments_ready' (or fact_checked with ready segments).`);
    }

    const latestFactCheck = await db.factCheckResult.findFirst({
      where: { scriptId },
      orderBy: { checkedAt: "desc" },
    });

    if (!latestFactCheck) {
      throw new Error("No fact check result exists for this script.");
    }

    if (latestFactCheck.status !== "passed") {
      throw new Error(`Latest fact check status is '${latestFactCheck.status}'. Fact check must pass to stitch final audio.`);
    }

    const segments = (script.content as any).segments;
    if (!Array.isArray(segments) || segments.length === 0) {
      throw new Error("Script segments are missing or empty.");
    }

    // HARD GUARD against the repeated-clip bug: if the script content has
    // duplicate lineIndex values, one audio clip would be stitched in for
    // every colliding line (same sentence over and over). Refuse and point
    // at the fix — re-running TTS renumbers and regenerates automatically.
    if (hasLineIndexCollisions(segments)) {
      throw new Error(
        "Script has duplicate lineIndex values (would stitch the same clip repeatedly). Re-run TTS generation — it renumbers the script and regenerates segments automatically."
      );
    }

    // Load active host profiles
    const hostA = await db.aiHost.findFirst({ where: { name: "Max Voltage", isActive: true } });
    const hostB = await db.aiHost.findFirst({ where: { name: "Dr. Linebreak", isActive: true } });
    if (!hostA || !hostB) {
      throw new Error("Active host profiles for Max Voltage and Dr. Linebreak must be active.");
    }

    // Flatten script lines
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

        // Not a hard block: stitching runs only on approved, fact-checked
        // scripts (a human has signed off). Approval clears these flags going
        // forward; older approved scripts proceed with a logged warning.
        if (line.needsHumanReview === true) {
          console.warn(`[Stitcher] Line ${line.lineIndex} flagged needsHumanReview but script is approved; proceeding.`);
        }

        if (line.speakerName !== "Max Voltage" && line.speakerName !== "Dr. Linebreak") {
          throw new Error(`Line ${line.lineIndex} has invalid speakerName '${line.speakerName}'. Only Max Voltage and Dr. Linebreak are allowed.`);
        }

        if (line.speakerName === "Max Voltage" && line.speakerHostId !== hostA.id) {
          throw new Error(`Line ${line.lineIndex} host ID does not match Max Voltage active profile.`);
        }
        if (line.speakerName === "Dr. Linebreak" && line.speakerHostId !== hostB.id) {
          throw new Error(`Line ${line.lineIndex} host ID does not match Dr. Linebreak active profile.`);
        }

        allLines.push(line);
      }
    }

    const lineCount = allLines.length;

    // Load and check AudioSegment records
    const audioSegments = await db.audioSegment.findMany({
      where: { scriptId },
    });

    let missingSegmentCount = 0;
    let failedSegmentCount = 0;
    let duplicateSegmentCount = 0;
    const segmentMap = new Map<number, any[]>();

    for (const segment of audioSegments) {
      const list = segmentMap.get(segment.lineIndex) || [];
      list.push(segment);
      segmentMap.set(segment.lineIndex, list);
    }

    const validatedSegments: any[] = [];

    for (const line of allLines) {
      const segmentsForLine = segmentMap.get(line.lineIndex) || [];
      if (segmentsForLine.length > 1) {
        // Duplicate rows are tolerated — we just pick the usable one below.
        duplicateSegmentCount++;
      }

      // Prefer a ready segment with audio among any duplicates for this line.
      const activeSeg =
        segmentsForLine.find((s) => s.status === "ready" && s.audioUrl) || segmentsForLine[0];

      if (!activeSeg) {
        missingSegmentCount++;
      } else if (activeSeg.status !== "ready" || !activeSeg.audioUrl) {
        failedSegmentCount++;
      } else {
        validatedSegments.push(activeSeg);
      }
    }

    // Duplicates are NOT a hard failure; only genuinely missing or unusable
    // (not-ready / no-audio) lines block stitching.
    if (missingSegmentCount > 0 || failedSegmentCount > 0) {
      throw new Error(
        `AudioSegment validation failed. Missing: ${missingSegmentCount}, Failed/Not Ready: ${failedSegmentCount} (duplicates tolerated: ${duplicateSegmentCount}).`
      );
    }

    // Transition Episode status to audio_stitching safely
    await db.episode.update({
      where: { id: episode.id },
      data: { status: "audio_stitching" },
    });

    // 3. Temporary Workspace Setup
    const tempBaseDir = process.env.AUDIO_STITCH_TEMP_DIR || path.join(os.tmpdir(), "take-machine-audio");
    const jobId = jobLog.id;
    const tempDir = path.join(tempBaseDir, episode.id, scriptId, jobId);
    fs.mkdirSync(tempDir, { recursive: true });

    const storageProvider = getStorageProvider();

    // 3b. Sound design resolution: trigger option > episode setting > show
    // config default > "clean" (legacy dialogue-only render). See
    // docs/SOUND_DESIGN.md for the full production model.
    const episodeSound = parseEpisodeSoundDesign(episode.soundDesign);
    const sdConfig = await db.soundDesignConfig.findUnique({ where: { id: "default" } });
    const style: ProductionStyle = isProductionStyle(input.productionStyle)
      ? input.productionStyle
      : episodeSound.style ??
        (sdConfig && isProductionStyle(sdConfig.defaultStyle) ? sdConfig.defaultStyle : "clean");
    const sfxDensity: SfxDensity = isSfxDensity(input.sfxDensity)
      ? input.sfxDensity
      : episodeSound.sfxDensity ??
        (sdConfig && isSfxDensity(sdConfig.defaultSfxDensity) ? sdConfig.defaultSfxDensity : "subtle");
    const highlightPlacements = episodeSound.highlights ?? [];

    const soundWarnings: string[] = [];
    const targetSampleRateEarly = Number(process.env.AUDIO_TARGET_SAMPLE_RATE) || 44100;
    let assetSet: SoundDesignAssetSet = emptyAssetSet();
    if (style !== "clean") {
      assetSet = await loadSoundDesignAssetSet({
        style,
        config: sdConfig,
        highlightAssetIds: highlightPlacements.map((h) => h.assetId),
        tempDir,
        storageProvider,
        ffmpegPath,
        ffprobePath,
        sampleRate: targetSampleRateEarly,
        warnings: soundWarnings,
      });
      console.log(
        `[Stitcher] Sound design: style=${style} density=${sfxDensity} ` +
          `intro=${assetSet.intro?.name || "-"} outro=${assetSet.outro?.name || "-"} bed=${assetSet.bed?.name || "-"} ` +
          `stingers=${assetSet.stingers.length} sfxCategories=${[...assetSet.sfxByCategory.keys()].join("/") || "-"} ` +
          `highlights=${assetSet.highlights.size}/${highlightPlacements.length}`
      );
      for (const w of soundWarnings) console.warn(`[Stitcher] ${w}`);
    } else {
      console.log("[Stitcher] Sound design: style=clean (dialogue-only render).");
    }

    // 4. Intro: configured theme asset wins; AUDIO_INTRO_URL env is the
    // legacy fallback. `includeIntro` still gates both.
    let introFile: string | null = null;
    if (includeIntro && !assetSet.intro) {
      const introUrl = process.env.AUDIO_INTRO_URL;
      if (introUrl) {
        introFile = path.join(tempDir, "intro-raw.mp3");
        console.log(`[Stitcher] Downloading intro from: ${introUrl}`);
        const res = await storageProvider.getObject({ url: introUrl });
        fs.writeFileSync(introFile, res.body);
      } else {
        console.warn("[Stitcher] includeIntro is true but no theme asset or AUDIO_INTRO_URL is configured. Skipping intro.");
      }
    }

    // 5. Outro: same precedence as the intro.
    let outroFile: string | null = null;
    if (includeOutro && !assetSet.outro) {
      const outroUrl = process.env.AUDIO_OUTRO_URL;
      if (outroUrl) {
        outroFile = path.join(tempDir, "outro-raw.mp3");
        console.log(`[Stitcher] Downloading outro from: ${outroUrl}`);
        const res = await storageProvider.getObject({ url: outroUrl });
        fs.writeFileSync(outroFile, res.body);
      } else {
        console.warn("[Stitcher] includeOutro is true but no theme asset or AUDIO_OUTRO_URL is configured. Skipping outro.");
      }
    }

    // 6. Download Dialogue Segments
    const downloadedLines: { filePath: string; line: any }[] = [];
    for (const segment of validatedSegments) {
      const line = allLines.find((l) => l.lineIndex === segment.lineIndex);
      const destFile = path.join(tempDir, `line-${segment.lineIndex}-raw.mp3`);
      console.log(`[Stitcher] Downloading dialogue segment for line #${segment.lineIndex} from: ${segment.audioUrl}`);
      const res = await storageProvider.getObject({ url: segment.audioUrl! });
      fs.writeFileSync(destFile, res.body);

      if (!fs.existsSync(destFile) || fs.statSync(destFile).size === 0) {
        throw new Error(`Downloaded segment for line #${segment.lineIndex} is empty or missing.`);
      }

      downloadedLines.push({ filePath: destFile, line });
    }

    // 7. Standardize every clip to WAV at matched speech loudness.
    // WAV intermediates avoid MP3 encoder padding (the tiny clicks/gaps that
    // plague MP3 concat), and per-clip loudnorm means neither host is louder
    // than the other going into the mix.
    const targetSampleRate = Number(process.env.AUDIO_TARGET_SAMPLE_RATE) || 44100;
    const targetBitrate = process.env.AUDIO_TARGET_BITRATE || "192k";

    const plannedLines: PlannedLine[] = [];
    for (let i = 0; i < downloadedLines.length; i++) {
      const curr = downloadedLines[i];
      const prev = i > 0 ? downloadedLines[i - 1] : null;

      const wavPath = path.join(tempDir, `std-line-${curr.line.lineIndex}.wav`);
      await standardizeClipToWav(ffmpegPath, curr.filePath, wavPath, {
        sampleRate: targetSampleRate,
      });
      const durationMs = await getFileDurationMs(ffprobePath, wavPath);

      // Detect script-segment boundaries for longer topic-change beats
      let segmentBreak: PlannedLine["segmentBreak"] = "none";
      if (prev) {
        const currSegmentIndex = segments.findIndex((s) => s.lines.some((l: any) => l.lineIndex === curr.line.lineIndex));
        const prevSegmentIndex = segments.findIndex((s) => s.lines.some((l: any) => l.lineIndex === prev.line.lineIndex));
        if (currSegmentIndex !== prevSegmentIndex) {
          segmentBreak = segments[currSegmentIndex]?.type === "topic" ? "topic" : "segment";
        }
      }

      plannedLines.push({
        filePath: wavPath,
        durationMs,
        lineIndex: curr.line.lineIndex,
        hostSlot: curr.line.speakerHostId === hostA.id ? 0 : 1,
        pauseBefore: curr.line.pauseBefore,
        isInterruption: curr.line.isInterruption === true,
        segmentBreak,
      });
    }

    // 8. Plan the conversational timeline (variable gaps, jitter, overlaps
    // on interruptions), then splice intro/outro music in with crossfades.
    const musicCrossfadeMs = Number(process.env.AUDIO_MUSIC_CROSSFADE_MS) || 900;

    // Resolve the intro source: standardized theme asset, or env-URL clip.
    let introStd: { filePath: string; durationMs: number } | null = null;
    if (assetSet.intro && includeIntro) {
      introStd = { filePath: assetSet.intro.filePath, durationMs: assetSet.intro.durationMs };
    } else if (introFile) {
      const stdIntro = path.join(tempDir, "std-intro.wav");
      await standardizeClipToWav(ffmpegPath, introFile, stdIntro, {
        sampleRate: targetSampleRate,
        targetLufs: -17,
      });
      introStd = { filePath: stdIntro, durationMs: await getFileDurationMs(ffprobePath, stdIntro) };
    }

    let introClip: TimelineClip | null = null;
    let dialogueStartMs = 0;
    if (introStd) {
      introClip = {
        filePath: introStd.filePath,
        startMs: 0,
        durationMs: introStd.durationMs,
        kind: "music",
        pan: 0,
        fadeInMs: 20,
        fadeOutMs: musicCrossfadeMs,
        gainDb: -2,
      };
      // First line begins while the intro's tail is still fading — a
      // crossfade, not a hard cut into silence.
      dialogueStartMs = Math.max(0, introStd.durationMs - musicCrossfadeMs);
    }

    // Stinger-aware gaps: a 1-3s transition needs room between segments, so
    // widen the planned break gaps to fit the longest configured stinger.
    const stingerDurations = assetSet.stingers.map((s) => s.durationMs);
    const maxStingerMs = stingerDurations.length > 0 ? Math.max(...stingerDurations) : 0;
    const planOpts: Parameters<typeof planConversationTimeline>[1] = { startAtMs: dialogueStartMs };
    if (style !== "clean" && maxStingerMs > 0) {
      planOpts.topicGapMs = Math.max(Number(process.env.AUDIO_TOPIC_GAP_MS) || 1200, maxStingerMs + 800);
      if (style === "full") {
        planOpts.segmentGapMs = Math.max(Number(process.env.AUDIO_SEGMENT_GAP_MS) || 850, maxStingerMs + 700);
      }
    }

    const dialogueClips = planConversationTimeline(plannedLines, planOpts);

    // 8b. Rights-gated game highlights: insert each cleared clip right after
    // its script beat, pushing everything later down the timeline.
    const lineByIndex = new Map<number, any>(allLines.map((l) => [l.lineIndex, l]));
    const highlightClips: TimelineClip[] = [];
    const highlightSummary: SoundDesignSummary["highlights"] = [];
    const sortedHighlights = [...highlightPlacements].sort((a, b) => a.lineIndex - b.lineIndex);
    for (const hl of sortedHighlights) {
      const asset = assetSet.highlights.get(hl.assetId);
      const lineIdx = plannedLines.findIndex((l) => l.lineIndex === hl.lineIndex);
      if (!asset || lineIdx === -1) {
        soundWarnings.push(
          `Highlight at line ${hl.lineIndex} skipped: ${!asset ? "asset unavailable or rights not confirmed" : "line not found"}.`
        );
        continue;
      }
      const lineClip = dialogueClips[lineIdx];
      const afterEndMs = lineClip.startMs + lineClip.durationMs;
      const atMs = shiftTimelineForInsert([...dialogueClips, ...highlightClips], afterEndMs, asset.durationMs);
      highlightClips.push({
        filePath: asset.filePath,
        startMs: atMs,
        durationMs: asset.durationMs,
        kind: "music",
        pan: 0,
        fadeInMs: 120,
        fadeOutMs: 250,
        gainDb: -2,
      });
      highlightSummary.push({ lineIndex: hl.lineIndex, asset: asset.name });
    }

    // 8c. Stingers punctuate segment/topic changes ("light" = topic breaks
    // only, "full" = both), rotating through the configured set.
    const stingerSlots = plannedLines
      .map((l, i) => ({ line: l, clip: dialogueClips[i] }))
      .filter(({ line }) => line.segmentBreak === "segment" || line.segmentBreak === "topic")
      .map(({ line, clip }) => ({
        lineIndex: line.lineIndex,
        breakKind: line.segmentBreak as "segment" | "topic",
        lineStartMs: clip.startMs,
      }));
    const stingerPlacements = planStingers(stingerSlots, style, stingerDurations);
    const stingerClips: TimelineClip[] = stingerPlacements.map((p) => {
      const asset = assetSet.stingers[p.stingerIndex];
      return {
        filePath: asset.filePath,
        startMs: p.atMs,
        durationMs: asset.durationMs,
        kind: "sfx",
        pan: 0,
        fadeInMs: 15,
        fadeOutMs: 90,
        gainDb: p.gainDb,
      };
    });

    // 8d. Reaction SFX on emotional beats (full style only) — placement is
    // driven by the script's own tone/energy metadata, rate-limited by the
    // configured density so reactions land on peaks, never wallpaper.
    const reactionClips: TimelineClip[] = [];
    const reactionSummary: SoundDesignSummary["reactions"] = [];
    if (style === "full") {
      const sfxContexts: SfxLineContext[] = plannedLines.map((l, i) => {
        const scriptLine = lineByIndex.get(l.lineIndex) || {};
        return {
          lineIndex: l.lineIndex,
          tone: scriptLine.tone,
          energy: scriptLine.energy,
          startMs: dialogueClips[i].startMs,
          durationMs: dialogueClips[i].durationMs,
        };
      });
      const availableCategories = new Set<SfxCategory>([...assetSet.sfxByCategory.keys()]);
      const reactions = planReactionSfx(sfxContexts, sfxDensity, { availableCategories });
      for (const placement of reactions) {
        const asset = pickSfxAsset(assetSet, placement);
        if (!asset) continue;
        reactionClips.push({
          filePath: asset.filePath,
          startMs: placement.atMs,
          durationMs: asset.durationMs,
          kind: "sfx",
          pan: 0,
          fadeInMs: 25,
          fadeOutMs: 150,
          gainDb: placement.gainDb,
        });
        reactionSummary.push({
          lineIndex: placement.lineIndex,
          asset: asset.name,
          reason: placement.reason,
          atMs: placement.atMs,
        });
      }
    }

    const clips: TimelineClip[] = [
      ...(introClip ? [introClip] : []),
      ...dialogueClips,
      ...highlightClips,
      ...stingerClips,
      ...reactionClips,
    ];

    const dialogueEndMs = dialogueClips.length
      ? Math.max(...[...dialogueClips, ...highlightClips].map((c) => c.startMs + c.durationMs))
      : dialogueStartMs;

    // Outro: standardized theme asset, or env-URL clip.
    let outroStd: { filePath: string; durationMs: number } | null = null;
    if (assetSet.outro && includeOutro) {
      outroStd = { filePath: assetSet.outro.filePath, durationMs: assetSet.outro.durationMs };
    } else if (outroFile) {
      const stdOutro = path.join(tempDir, "std-outro.wav");
      await standardizeClipToWav(ffmpegPath, outroFile, stdOutro, {
        sampleRate: targetSampleRate,
        targetLufs: -17,
      });
      outroStd = { filePath: stdOutro, durationMs: await getFileDurationMs(ffprobePath, stdOutro) };
    }

    if (outroStd) {
      clips.push({
        filePath: outroStd.filePath,
        startMs: Math.max(0, dialogueEndMs - Math.round(musicCrossfadeMs / 2)),
        durationMs: outroStd.durationMs,
        kind: "music",
        pan: 0,
        fadeInMs: musicCrossfadeMs,
        fadeOutMs: 400,
        gainDb: -2,
      });
    }

    const totalInputDurationMs = clips.length
      ? Math.max(...clips.map((c) => c.startMs + c.durationMs))
      : 0;

    // 9. Render the foreground timeline in one ffmpeg mix (shared room tone,
    // stereo seating, micro-fades, glue compression) — no concat hard cuts.
    console.log(
      `[Stitcher] Rendering ${clips.length} clips (dialogue=${dialogueClips.length}, stingers=${stingerClips.length}, ` +
        `reactions=${reactionClips.length}, highlights=${highlightClips.length}) onto conversational timeline.`
    );
    const foregroundWavPath = path.join(tempDir, "foreground-mix.wav");
    await renderTimelineToWav(ffmpegPath, clips, foregroundWavPath, {
      sampleRate: targetSampleRate,
    });

    // 9b. Music bed under the whole episode (full style): sidechain-ducked
    // by the foreground so dialogue always dominates and the bed swells
    // back in the gaps. Instrumental only, looped to length.
    let mixWavPath = foregroundWavPath;
    const bedUsed = style === "full" && !!assetSet.bed;
    if (bedUsed) {
      const foregroundMs = await getFileDurationMs(ffprobePath, foregroundWavPath);
      const beddedPath = path.join(tempDir, "final-mix-bedded.wav");
      console.log(`[Stitcher] Ducking music bed '${assetSet.bed!.name}' under ${Math.round(foregroundMs / 1000)}s foreground.`);
      await mixBedUnderForeground(ffmpegPath, foregroundWavPath, assetSet.bed!.filePath, beddedPath, {
        sampleRate: targetSampleRate,
        totalMs: foregroundMs,
      });
      mixWavPath = beddedPath;
    }

    // 10. Master: two-pass linear loudnorm to podcast loudness.
    const finalOutputPath = path.join(tempDir, "final.mp3");
    if (normalizeAudio) {
      console.log(`[Stitcher] Mastering to ${targetLufs} LUFS (two-pass loudnorm).`);
      await masterToMp3(ffmpegPath, mixWavPath, finalOutputPath, {
        targetLufs,
        bitrate: targetBitrate,
      });
    } else {
      await runFfmpeg(ffmpegPath, [
        "-y",
        "-i", mixWavPath,
        "-c:a", "libmp3lame",
        "-b:a", targetBitrate,
        finalOutputPath,
      ]);
    }

    // 10b. Automated human-ness QA on the finished master.
    let qaReport: AudioQaReport | null = null;
    try {
      qaReport = await analyzeEpisodeAudio(ffmpegPath, finalOutputPath, { targetLufs });
      for (const c of qaReport.checks) {
        console.log(`[Stitcher][QA] ${c.status.toUpperCase()} — ${c.name}: ${c.value}`);
      }
      if (!qaReport.passed && process.env.AUDIO_QA_STRICT === "true") {
        const failed = qaReport.checks
          .filter((c) => c.status === "fail")
          .map((c) => `${c.name} (${c.value})`)
          .join("; ");
        throw new Error(`Audio QA failed (AUDIO_QA_STRICT=true): ${failed}`);
      }
    } catch (qaErr: unknown) {
      if (process.env.AUDIO_QA_STRICT === "true") throw qaErr;
      const msg = qaErr instanceof Error ? qaErr.message : String(qaErr);
      console.warn(`[Stitcher] Audio QA analysis skipped/failed: ${msg}`);
    }

    if (!fs.existsSync(finalOutputPath) || fs.statSync(finalOutputPath).size === 0) {
      throw new Error("Stitched output file is empty or missing.");
    }

    const finalFileSizeBytes = fs.statSync(finalOutputPath).size;
    const finalDurationSeconds = (await getFileDurationMs(ffprobePath, finalOutputPath)) / 1000;

    // 11. Upload final MP3
    const episodeSlug = episode.slug || "";
    const versionStr = script.version.toString();
    const storageKey = episodeSlug
      ? `episodes/${episode.id}/scripts/${scriptId}/final/take-machine-${episodeSlug}-v${versionStr}.mp3`
      : `episodes/${episode.id}/scripts/${scriptId}/final/final.mp3`;

    console.log(`[Stitcher] Uploading final stitched audio to: ${storageKey}`);
    const uploadResult = await storageProvider.putObject({
      key: storageKey,
      body: fs.readFileSync(finalOutputPath),
      contentType: "audio/mp3",
    });

    // 12. Update Database Records inside a transaction. The style/density
    // used for this render are pinned on the episode so re-runs (and the
    // console) stay consistent with what actually shipped.
    await db.$transaction([
      db.episode.update({
        where: { id: episode.id },
        data: {
          status: "audio_ready",
          audioUrl: uploadResult.url,
          durationSeconds: Math.round(finalDurationSeconds),
          soundDesign: {
            ...episodeSound,
            style,
            sfxDensity,
          } as any,
        },
      }),
    ]);

    // 13. Write Success JobLog
    const successOutput = {
      episodeId: episode.id,
      scriptId,
      finalStatus: "completed",
      finalAudioUrl: uploadResult.url,
      durationSeconds: Math.round(finalDurationSeconds),
      lineCount,
      audioSegmentCount: validatedSegments.length,
      missingSegmentCount: 0,
      failedSegmentCount: 0,
      duplicateSegmentCount: 0,
      totalInputDurationMs,
      finalFileSizeBytes,
      ffmpegCommandSummary:
        `${ffmpegPath} timeline-mix (adelay+amix, room tone, stereo seating)` +
        (bedUsed ? " + sidechain-ducked bed" : "") +
        " + two-pass loudnorm",
      storageKey,
      audioQa: qaReport,
      // Combined episode score: script rubric (70%) + audio human-ness (30%).
      episodeScore: computeEpisodeScore((script.content as any)?.quality, qaReport),
      // What the sound-design stage actually mixed in — the proof layer.
      soundDesign: {
        style,
        sfxDensity,
        introAsset: introClip ? (assetSet.intro?.name ?? "env intro clip") : null,
        outroAsset: outroStd ? (assetSet.outro?.name ?? "env outro clip") : null,
        bedAsset: bedUsed ? assetSet.bed!.name : null,
        bedDucking: bedUsed,
        stingerCount: stingerClips.length,
        reactionCount: reactionClips.length,
        reactions: reactionSummary,
        highlightCount: highlightClips.length,
        highlights: highlightSummary,
      } satisfies SoundDesignSummary,
      reasons: ["Final audio stitched and uploaded successfully.", ...soundWarnings],
    };

    await db.jobLog.update({
      where: { id: jobLog.id },
      data: {
        status: "completed",
        output: successOutput as any,
      },
    });

    // Clean up temp directory
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (e) {
      console.warn(`[Stitcher] Failed to remove temp directory ${tempDir}:`, e);
    }

    return successOutput;
  } catch (err: any) {
    console.error("[Stitcher] Stitching failed:", err.message);

    // Restore previous status of the episode
    if (scriptRecord?.episode) {
      try {
        await db.episode.update({
          where: { id: scriptRecord.episode.id },
          data: { status: previousStatus },
        });
      } catch (e) {
        console.error("[Stitcher] Failed to restore episode status:", e);
      }
    }

    // Write failed JobLog
    await db.jobLog.update({
      where: { id: jobLog.id },
      data: {
        status: "failed",
        error: err.message || "Unknown stitching error",
        output: {
          scriptId,
          finalStatus: "failed",
          reasons: [err.message || "Unknown stitching error"],
        } as any,
      },
    });

    throw err;
  }
}
