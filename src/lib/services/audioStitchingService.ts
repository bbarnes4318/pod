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

interface StitchInput {
  scriptId: string;
  forceRegenerate?: boolean;
  includeIntro?: boolean;
  includeOutro?: boolean;
  normalizeAudio?: boolean;
  targetLufs?: number;
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
      input: { scriptId, forceRegenerate, includeIntro, includeOutro, normalizeAudio, targetLufs } as any,
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

    if (episode.status !== "audio_segments_ready" && !(episode.status === "audio_ready" && forceRegenerate)) {
      throw new Error(`Episode status is '${episode.status}'. Stitching requires 'audio_segments_ready' or forceRegenerate from 'audio_ready'.`);
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
      if (segmentsForLine.length === 0) {
        missingSegmentCount++;
      } else if (segmentsForLine.length > 1) {
        duplicateSegmentCount++;
      }

      const activeSeg = segmentsForLine[0];
      if (activeSeg) {
        if (activeSeg.status !== "ready") {
          failedSegmentCount++;
        }
        if (!activeSeg.audioUrl) {
          failedSegmentCount++;
        }
        validatedSegments.push(activeSeg);
      }
    }

    if (missingSegmentCount > 0 || failedSegmentCount > 0 || duplicateSegmentCount > 0) {
      throw new Error(
        `AudioSegment validation failed. Missing: ${missingSegmentCount}, Failed/Not Ready: ${failedSegmentCount}, Duplicates: ${duplicateSegmentCount}.`
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

    // 4. Download Intro (if requested)
    let introFile: string | null = null;
    if (includeIntro) {
      const introUrl = process.env.AUDIO_INTRO_URL;
      if (introUrl) {
        introFile = path.join(tempDir, "intro-raw.mp3");
        console.log(`[Stitcher] Downloading intro from: ${introUrl}`);
        const res = await storageProvider.getObject({ url: introUrl });
        fs.writeFileSync(introFile, res.body);
      } else {
        console.warn("[Stitcher] includeIntro is true but AUDIO_INTRO_URL is not configured. Skipping intro.");
      }
    }

    // 5. Download Outro (if requested)
    let outroFile: string | null = null;
    if (includeOutro) {
      const outroUrl = process.env.AUDIO_OUTRO_URL;
      if (outroUrl) {
        outroFile = path.join(tempDir, "outro-raw.mp3");
        console.log(`[Stitcher] Downloading outro from: ${outroUrl}`);
        const res = await storageProvider.getObject({ url: outroUrl });
        fs.writeFileSync(outroFile, res.body);
      } else {
        console.warn("[Stitcher] includeOutro is true but AUDIO_OUTRO_URL is not configured. Skipping outro.");
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

    let introClip: TimelineClip | null = null;
    let dialogueStartMs = 0;
    if (introFile) {
      const stdIntro = path.join(tempDir, "std-intro.wav");
      await standardizeClipToWav(ffmpegPath, introFile, stdIntro, {
        sampleRate: targetSampleRate,
        targetLufs: -17,
      });
      const introDurMs = await getFileDurationMs(ffprobePath, stdIntro);
      introClip = {
        filePath: stdIntro,
        startMs: 0,
        durationMs: introDurMs,
        kind: "music",
        pan: 0,
        fadeInMs: 20,
        fadeOutMs: musicCrossfadeMs,
        gainDb: -2,
      };
      // First line begins while the intro's tail is still fading — a
      // crossfade, not a hard cut into silence.
      dialogueStartMs = Math.max(0, introDurMs - musicCrossfadeMs);
    }

    const dialogueClips = planConversationTimeline(plannedLines, { startAtMs: dialogueStartMs });

    const clips: TimelineClip[] = [...(introClip ? [introClip] : []), ...dialogueClips];

    const dialogueEndMs = dialogueClips.length
      ? Math.max(...dialogueClips.map((c) => c.startMs + c.durationMs))
      : dialogueStartMs;

    if (outroFile) {
      const stdOutro = path.join(tempDir, "std-outro.wav");
      await standardizeClipToWav(ffmpegPath, outroFile, stdOutro, {
        sampleRate: targetSampleRate,
        targetLufs: -17,
      });
      const outroDurMs = await getFileDurationMs(ffprobePath, stdOutro);
      clips.push({
        filePath: stdOutro,
        startMs: Math.max(0, dialogueEndMs - Math.round(musicCrossfadeMs / 2)),
        durationMs: outroDurMs,
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

    // 9. Render the whole timeline in one ffmpeg mix (shared room tone,
    // stereo seating, micro-fades, glue compression) — no concat hard cuts.
    console.log(`[Stitcher] Rendering ${clips.length} clips onto conversational timeline.`);
    const mixWavPath = path.join(tempDir, "final-mix.wav");
    await renderTimelineToWav(ffmpegPath, clips, mixWavPath, {
      sampleRate: targetSampleRate,
    });

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

    // 12. Update Database Records inside a transaction
    await db.$transaction([
      db.episode.update({
        where: { id: episode.id },
        data: {
          status: "audio_ready",
          audioUrl: uploadResult.url,
          durationSeconds: Math.round(finalDurationSeconds),
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
      ffmpegCommandSummary: `${ffmpegPath} timeline-mix (adelay+amix, room tone, stereo seating) + two-pass loudnorm`,
      storageKey,
      audioQa: qaReport,
      reasons: ["Final audio stitched and uploaded successfully."],
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
