import { db } from "@/lib/db";
import { getStorageProvider } from "@/lib/providers/storage/factory";
import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";

interface StitchInput {
  scriptId: string;
  forceRegenerate?: boolean;
  includeIntro?: boolean;
  includeOutro?: boolean;
  normalizeAudio?: boolean;
  targetLufs?: number;
}

function runFfmpeg(ffmpegPath: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    console.log(`[FFmpeg] Running: ${ffmpegPath} ${args.join(" ")}`);
    const proc = spawn(ffmpegPath, args);
    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data) => (stdout += data.toString()));
    proc.stderr.on("data", (data) => (stderr += data.toString()));

    proc.on("close", (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`FFmpeg exited with code ${code}. Error: ${stderr}`));
      }
    });
  });
}

function runFfprobe(ffprobePath: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffprobePath, args);
    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data) => (stdout += data.toString()));
    proc.stderr.on("data", (data) => (stderr += data.toString()));

    proc.on("close", (code) => {
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(`FFprobe exited with code ${code}. Error: ${stderr}`));
      }
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

        if (line.needsHumanReview === true) {
          throw new Error(`Script contains lines marked as requiring human review.`);
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

    // 7. Intermediate Standardization & Silence Generation
    const stdFiles: string[] = [];
    const targetSampleRate = process.env.AUDIO_TARGET_SAMPLE_RATE || "44100";
    const targetChannels = process.env.AUDIO_TARGET_CHANNELS || "2";
    const targetBitrate = process.env.AUDIO_TARGET_BITRATE || "192k";

    const lineGapMs = Number(process.env.AUDIO_LINE_GAP_MS) || 450;
    const segmentGapMs = Number(process.env.AUDIO_SEGMENT_GAP_MS) || 850;
    const topicGapMs = Number(process.env.AUDIO_TOPIC_GAP_MS) || 1200;

    let silenceCounter = 0;

    async function makeSilence(durationMs: number): Promise<string> {
      const durSec = durationMs / 1000;
      const silPath = path.join(tempDir, `silence-${silenceCounter++}.mp3`);
      await runFfmpeg(ffmpegPath, [
        "-y",
        "-f",
        "lavfi",
        "-i",
        `anullsrc=r=${targetSampleRate}:cl=stereo`,
        "-t",
        durSec.toString(),
        "-c:a",
        "libmp3lame",
        "-b:a",
        targetBitrate,
        silPath,
      ]);
      return silPath;
    }

    async function standardizeFile(inPath: string, name: string): Promise<string> {
      const outPath = path.join(tempDir, `std-${name}.mp3`);
      await runFfmpeg(ffmpegPath, [
        "-y",
        "-i",
        inPath,
        "-ar",
        targetSampleRate,
        "-ac",
        targetChannels,
        "-b:a",
        targetBitrate,
        outPath,
      ]);
      return outPath;
    }

    // Add Intro standard
    if (introFile) {
      const stdIntro = await standardizeFile(introFile, "intro");
      stdFiles.push(stdIntro);
      // Gap after intro
      const sil = await makeSilence(segmentGapMs);
      stdFiles.push(sil);
    }

    // Add Dialogue Lines & Silences
    let totalInputDurationMs = 0;

    for (let i = 0; i < downloadedLines.length; i++) {
      const curr = downloadedLines[i];
      const prev = i > 0 ? downloadedLines[i - 1] : null;

      // Determine appropriate gap before this line
      if (prev) {
        // If this line starts a new segment
        const currSegmentIndex = segments.findIndex((s) => s.lines.some((l: any) => l.lineIndex === curr.line.lineIndex));
        const prevSegmentIndex = segments.findIndex((s) => s.lines.some((l: any) => l.lineIndex === prev.line.lineIndex));

        if (currSegmentIndex !== prevSegmentIndex) {
          const nextSeg = segments[currSegmentIndex];
          const isTopic = nextSeg?.type === "topic";
          const gap = isTopic ? topicGapMs : segmentGapMs;
          const sil = await makeSilence(gap);
          stdFiles.push(sil);
          totalInputDurationMs += gap;
        } else {
          // Same segment line-to-line gap
          const sil = await makeSilence(lineGapMs);
          stdFiles.push(sil);
          totalInputDurationMs += lineGapMs;
        }
      }

      const stdLine = await standardizeFile(curr.filePath, `line-${curr.line.lineIndex}`);
      stdFiles.push(stdLine);

      // Add to estimated duration
      const fileSec = await getFileDuration(ffprobePath, stdLine);
      totalInputDurationMs += fileSec * 1000;
    }

    // Add Outro standard
    if (outroFile) {
      // Gap before outro
      const sil = await makeSilence(segmentGapMs);
      stdFiles.push(sil);

      const stdOutro = await standardizeFile(outroFile, "outro");
      stdFiles.push(stdOutro);
    }

    // 8. Build FFmpeg Concat List
    const concatTxtPath = path.join(tempDir, "concat.txt");
    const concatContent = stdFiles.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join("\n");
    fs.writeFileSync(concatTxtPath, concatContent);

    // 9. Concatenate intermediate files
    const finalRawPath = path.join(tempDir, "final-raw.mp3");
    await runFfmpeg(ffmpegPath, [
      "-y",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      concatTxtPath,
      "-c",
      "copy",
      finalRawPath,
    ]);

    // 10. Normalization (Loudness check)
    const finalOutputPath = path.join(tempDir, "final.mp3");
    if (normalizeAudio) {
      console.log(`[Stitcher] Normalizing output loudness to ${targetLufs} LUFS.`);
      await runFfmpeg(ffmpegPath, [
        "-y",
        "-i",
        finalRawPath,
        "-af",
        `loudnorm=I=${targetLufs}:TP=-1.5:LRA=11`,
        "-c:a",
        "libmp3lame",
        "-b:a",
        targetBitrate,
        finalOutputPath,
      ]);
    } else {
      fs.copyFileSync(finalRawPath, finalOutputPath);
    }

    if (!fs.existsSync(finalOutputPath) || fs.statSync(finalOutputPath).size === 0) {
      throw new Error("Stitched output file is empty or missing.");
    }

    const finalFileSizeBytes = fs.statSync(finalOutputPath).size;
    const finalDurationSeconds = await getFileDuration(ffprobePath, finalOutputPath);

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
      ffmpegCommandSummary: `${ffmpegPath} concat loudnorm`,
      storageKey,
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
