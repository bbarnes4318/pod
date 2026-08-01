// Final-episode assembly for SCENE-mode episodes.
//
// The prime directive here: a scene file is ONE foreground object. The
// dialogue model already performed the turn-taking, reactions, pauses and
// interruptions INSIDE the scene — we never cut a scene into lines, never
// insert per-line gaps or overlaps into it, and never pan "speakers" of a
// mixed mono scene apart. Assembly only places whole scenes, music and
// stingers on the timeline, then masters exactly like the legacy path
// (room tone, edge fades, two-pass loudnorm, peak protection).
//
// The legacy per-line path (audioStitchingService) is untouched and remains
// the renderer for legacy_line episodes, the post-TTS director, and the
// production planner. Scene mode uses this dedicated, simpler assembler.

import { db } from "@/lib/db";
import { PRODUCED_OR_LATER } from "@/lib/episodeStatus";
import { getStorageProvider } from "@/lib/providers/storage/factory";
import fs from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";
import {
  TimelineClip,
  getFileDurationMs,
  masterToMp3,
  renderTimelineToWav,
  runFfmpeg,
} from "@/lib/audio/assembly";
import { DEFAULT_SEGMENT_GAP_MS, DEFAULT_TOPIC_GAP_MS, DEFAULT_PAUSE_MS } from "@/lib/audio/pauseTiming";
import { analyzeEpisodeAudio, type AudioQaReport, type ScriptedPause } from "@/lib/audio/audioQa";
import { analyzeSceneAudioRows, type SceneQaReport } from "@/lib/audio/sceneAudioQa";
import { runAudioSemanticQa, type AudioSemanticQaReport } from "@/lib/audio/audioSemanticQa";
import { loadSoundDesignAssetSet } from "@/lib/services/audioStitchingService";
import { parseEpisodeSoundDesign, isProductionStyle, type ProductionStyle, emptyAssetSet, type SoundDesignAssetSet, mixBedUnderForeground } from "@/lib/audio/soundDesign";
import { loadScenePlanForScript } from "@/lib/services/ttsSceneService";

// Deterministic per-scene jitter (same PRNG family as the legacy assembler).
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Two-pass LINEAR loudnorm to WAV: matches scenes to one another WITHOUT
 *  dynamic gain riding (which would squash the scene's own internal dynamics
 *  — the whole point of scene generation). */
async function standardizeSceneToWav(
  ffmpegPath: string,
  inPath: string,
  outPath: string,
  opts: { sampleRate: number; targetLufs?: number }
): Promise<string> {
  const targetLufs = opts.targetLufs ?? -18;
  const nullSink = process.platform === "win32" ? "NUL" : "/dev/null";
  const measureOut = await runFfmpeg(ffmpegPath, [
    "-i", inPath,
    "-af", `loudnorm=I=${targetLufs}:TP=-2:LRA=11:print_format=json`,
    "-f", "null", nullSink,
  ]);
  const jsonMatch = measureOut.match(/\{[\s\S]*?"input_i"[\s\S]*?\}/);
  let filter = `loudnorm=I=${targetLufs}:TP=-2:LRA=11`;
  if (jsonMatch) {
    try {
      const m = JSON.parse(jsonMatch[0]);
      filter =
        `loudnorm=I=${targetLufs}:TP=-2:LRA=11:` +
        `measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:` +
        `measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true`;
    } catch { /* fall back to single-pass for this scene */ }
  }
  await runFfmpeg(ffmpegPath, [
    "-y", "-i", inPath,
    "-af", `${filter},aresample=${opts.sampleRate}`,
    "-ar", String(opts.sampleRate), "-ac", "2", "-c:a", "pcm_s16le",
    outPath,
  ]);
  return outPath;
}

export interface SceneTimelineEntry {
  sceneIndex: number;
  dialogueSceneAudioId: string;
  startMs: number;
  durationMs: number;
  timingStatus: string;
}

interface SceneStitchInput {
  scriptId: string;
  forceRegenerate?: boolean;
  includeIntro?: boolean;
  includeOutro?: boolean;
  normalizeAudio?: boolean;
  targetLufs?: number;
  productionStyle?: string;
}

/** Gap entering a scene, by why the planner opened it there. */
export function sceneGapMs(openedBy: string, sceneIndex: number, opts?: { segmentGapMs?: number; topicGapMs?: number; jitterFraction?: number }): { gapMs: number; pause: ScriptedPause } {
  const segmentGap = opts?.segmentGapMs ?? DEFAULT_SEGMENT_GAP_MS;
  const topicGap = opts?.topicGapMs ?? DEFAULT_TOPIC_GAP_MS;
  const jitterFraction = opts?.jitterFraction ?? 0.25;
  const rand = mulberry32(0x51c0ffee ^ (sceneIndex + 1));
  const jitter = 1 + (rand() * 2 - 1) * jitterFraction;
  switch (openedBy) {
    case "topic":
      return { gapMs: Math.max(200, Math.round(topicGap * jitter)), pause: "long" };
    case "segment":
      return { gapMs: Math.max(150, Math.round(segmentGap * jitter)), pause: "breath" };
    case "emotional_shift":
      return { gapMs: Math.max(120, Math.round(DEFAULT_PAUSE_MS.breath * jitter)), pause: "breath" };
    default: // budget cuts inside one movement: a small beat only
      return { gapMs: Math.max(80, Math.round(DEFAULT_PAUSE_MS.beat * jitter)), pause: "beat" };
  }
}

export async function stitchSceneEpisodeAudio(input: SceneStitchInput) {
  const {
    scriptId,
    forceRegenerate = false,
    includeIntro = true,
    includeOutro = true,
    normalizeAudio = true,
    targetLufs = -16,
  } = input;

  const ffmpegPath = process.env.FFMPEG_PATH || "ffmpeg";
  const ffprobePath = process.env.FFPROBE_PATH || "ffprobe";

  const jobLog = await db.jobLog.create({
    data: {
      jobType: "audio:stitch-final",
      status: "running",
      input: { scriptId, forceRegenerate, includeIntro, includeOutro, normalizeAudio, targetLufs, mode: "scene" } as never,
      output: {},
    },
  });

  let previousStatus = "audio_segments_ready";
  let episodeIdForRestore: string | null = null;
  let renderRecordId: string | null = null;

  try {
    const { plan, script, eligibility, resolvedByHostId } = await loadScenePlanForScript(scriptId);
    const episodeRow = await db.episode.findUnique({ where: { id: script.episodeId } });
    if (!episodeRow) throw new Error(`Episode ${script.episodeId} not found.`);
    previousStatus = episodeRow.status;
    episodeIdForRestore = episodeRow.id;

    if (episodeRow.status === "audio_stitching") {
      throw new Error("Episode is already audio_stitching.");
    }
    if (episodeRow.status === "audio_ready" && !forceRegenerate) {
      const output = { episodeId: episodeRow.id, scriptId, finalStatus: "skipped", finalAudioUrl: episodeRow.audioUrl, reasons: ["Final audio already exists and forceRegenerate is false."] };
      await db.jobLog.update({ where: { id: jobLog.id }, data: { status: "skipped", output: output as never } });
      return output;
    }

    // Selected ready scenes must exist and cover the plan exactly.
    const sceneRows = await db.dialogueSceneAudio.findMany({
      where: { scriptId, status: "ready", selected: true },
      orderBy: { sceneIndex: "asc" },
    });
    const sceneQa: SceneQaReport = analyzeSceneAudioRows({
      scenes: sceneRows.map((r) => ({
        sceneIndex: r.sceneIndex,
        status: r.status,
        selected: r.selected,
        renderUnit: r.renderUnit,
        provider: r.provider,
        model: r.model,
        requestFingerprint: r.requestFingerprint,
        lineIndexes: (r.lineIndexes as number[]) ?? [],
        durationMs: r.durationMs,
        audioUrl: r.audioUrl,
        timingStatus: r.timingStatus,
        voiceMap: (r.voiceMap as Record<string, string>) ?? {},
        characterCount: plan.scenes.find((s) => s.sceneIndex === r.sceneIndex)?.characterCount,
      })),
      expectedLineIndexes: plan.scenes.flatMap((s) => s.lineIndexes),
      expectedProvider: eligibility.provider,
      timingRequired: false,
      transcriptQaEnabled: process.env.TTS_TRANSCRIPT_QA_ENABLED === "true",
    });
    for (const c of sceneQa.checks) console.log(`[SceneStitcher][SceneQA:${c.kind}] ${c.status.toUpperCase()} — ${c.name}: ${c.value}`);
    if (!sceneQa.passed) {
      throw new Error(
        `Scene QA failed before assembly: ${sceneQa.checks.filter((c) => c.status === "fail").map((c) => `${c.name} (${c.value})`).join("; ")}`
      );
    }

    await db.episode.update({ where: { id: episodeRow.id }, data: { status: "audio_stitching" } });

    const tempBaseDir = process.env.AUDIO_STITCH_TEMP_DIR || path.join(os.tmpdir(), "take-machine-audio");
    const tempDir = path.join(tempBaseDir, episodeRow.id, scriptId, jobLog.id);
    fs.mkdirSync(tempDir, { recursive: true });
    const storageProvider = getStorageProvider();
    const targetSampleRate = Number(process.env.AUDIO_TARGET_SAMPLE_RATE) || 44100;
    const targetBitrate = process.env.AUDIO_TARGET_BITRATE || "192k";
    const musicCrossfadeMs = Number(process.env.AUDIO_MUSIC_CROSSFADE_MS) || 900;

    // Render-version record (same table as legacy renders; renderMode "scene").
    const priorVersion = await db.episodeAudioRender.aggregate({ where: { episodeId: episodeRow.id }, _max: { renderVersion: true } });
    const renderRecord = await db.episodeAudioRender.create({
      data: {
        episodeId: episodeRow.id,
        scriptId,
        renderVersion: (priorVersion._max.renderVersion ?? 0) + 1,
        status: "running",
        renderMode: "scene",
        configurationFingerprint: episodeRow.configurationFingerprint ?? null,
      },
    });
    renderRecordId = renderRecord.id;

    // Sound design (simplified for scene mode): intro/outro/stingers/bed from
    // the show config; rights validation + hash checks ride along in the
    // shared loader. The production planner and post-TTS director remain
    // legacy-line-only engines (documented limitation).
    const episodeSound = parseEpisodeSoundDesign(episodeRow.soundDesign);
    const sdConfig = await db.soundDesignConfig.findUnique({ where: { id: "default" } });
    const style: ProductionStyle = isProductionStyle(input.productionStyle)
      ? input.productionStyle
      : episodeSound.style ?? (sdConfig && isProductionStyle(sdConfig.defaultStyle) ? sdConfig.defaultStyle : "clean");
    const soundWarnings: string[] = [];
    let assetSet: SoundDesignAssetSet = emptyAssetSet();
    if (style !== "clean") {
      assetSet = await loadSoundDesignAssetSet({
        style,
        config: sdConfig,
        highlightAssetIds: [],
        tempDir,
        storageProvider,
        ffmpegPath,
        ffprobePath,
        sampleRate: targetSampleRate,
        warnings: soundWarnings,
      });
    }

    // 1. Download + standardize each scene (linear loudness match only).
    const sceneFiles: Array<{ row: (typeof sceneRows)[number]; filePath: string; durationMs: number }> = [];
    for (const row of sceneRows) {
      const raw = path.join(tempDir, `scene-${row.sceneIndex}-raw`);
      const res = await storageProvider.getObject({ url: row.audioUrl! });
      fs.writeFileSync(raw, res.body);
      const wav = path.join(tempDir, `scene-${row.sceneIndex}.wav`);
      await standardizeSceneToWav(ffmpegPath, raw, wav, { sampleRate: targetSampleRate });
      const durationMs = await getFileDurationMs(ffprobePath, wav);
      sceneFiles.push({ row, filePath: wav, durationMs });
    }

    // 1b. Meaning-aware QA listens to the standardized scene, transcribes it
    // with diarization, maps anonymous labels back to cast ids, and verifies
    // the actual words, critical names/numbers, speaker ownership and cut-ins.
    // Results live beside the provider audition metadata for postmortems.
    const semanticQaReports: Array<{ sceneIndex: number; report: AudioSemanticQaReport }> = [];
    if (process.env.TTS_TRANSCRIPT_QA_ENABLED === "true") {
      const strictSemanticQa = process.env.TTS_TRANSCRIPT_QA_STRICT === "true" ||
        (process.env.TTS_TRANSCRIPT_QA_STRICT !== "false" && process.env.NODE_ENV === "production");
      for (const sf of sceneFiles) {
        const planned = plan.scenes.find((scene) => scene.sceneIndex === sf.row.sceneIndex);
        if (!planned) throw new Error(`No planned scene for semantic QA index ${sf.row.sceneIndex}.`);
        try {
          const report = await runAudioSemanticQa({
            audio: fs.readFileSync(sf.filePath),
            mimeType: "audio/wav",
            expected: planned.lines.map((line) => ({
              lineIndex: line.lineIndex,
              speakerHostId: line.speakerHostId,
              speakerName: line.speakerName,
              text: line.text,
              isInterruption: line.isInterruption,
            })),
          });
          semanticQaReports.push({ sceneIndex: sf.row.sceneIndex, report });
          await db.dialogueSceneAudio.update({
            where: { id: sf.row.id },
            data: { providerMetadata: { ...((sf.row.providerMetadata as Record<string, unknown> | null) || {}), semanticQa: report } as never },
          });
          console.log(
            `[SceneStitcher][SemanticQA] ${report.status.toUpperCase()} scene ${sf.row.sceneIndex}: ` +
            `WER=${report.wordErrorRate == null ? "n/a" : `${(report.wordErrorRate * 100).toFixed(1)}%`}, ` +
            `speaker=${report.speakerAttributionErrorRate == null ? "n/a" : `${(report.speakerAttributionErrorRate * 100).toFixed(1)}%`}`
          );
          if (report.status === "fail" && strictSemanticQa) {
            throw new Error(report.failures.join(" "));
          }
        } catch (error) {
          if (strictSemanticQa) throw new Error(`Scene ${sf.row.sceneIndex} semantic audio QA failed: ${(error as Error).message}`);
          console.warn(`[SceneStitcher][SemanticQA] scene ${sf.row.sceneIndex} not gated: ${(error as Error).message}`);
        }
      }
    }

    // 2. Intro resolution (theme asset, else legacy env URL).
    let introStd: { filePath: string; durationMs: number } | null = null;
    if (includeIntro && assetSet.intro) {
      introStd = { filePath: assetSet.intro.filePath, durationMs: assetSet.intro.durationMs };
    } else if (includeIntro && process.env.AUDIO_INTRO_URL) {
      const rawIntro = path.join(tempDir, "intro-raw");
      const res = await storageProvider.getObject({ url: process.env.AUDIO_INTRO_URL });
      fs.writeFileSync(rawIntro, res.body);
      const wav = path.join(tempDir, "intro.wav");
      await standardizeSceneToWav(ffmpegPath, rawIntro, wav, { sampleRate: targetSampleRate, targetLufs: -17 });
      introStd = { filePath: wav, durationMs: await getFileDurationMs(ffprobePath, wav) };
    }
    let outroStd: { filePath: string; durationMs: number } | null = null;
    if (includeOutro && assetSet.outro) {
      outroStd = { filePath: assetSet.outro.filePath, durationMs: assetSet.outro.durationMs };
    } else if (includeOutro && process.env.AUDIO_OUTRO_URL) {
      const rawOutro = path.join(tempDir, "outro-raw");
      const res = await storageProvider.getObject({ url: process.env.AUDIO_OUTRO_URL });
      fs.writeFileSync(rawOutro, res.body);
      const wav = path.join(tempDir, "outro.wav");
      await standardizeSceneToWav(ffmpegPath, rawOutro, wav, { sampleRate: targetSampleRate, targetLufs: -17 });
      outroStd = { filePath: wav, durationMs: await getFileDurationMs(ffprobePath, wav) };
    }

    // 3. Place whole scenes on the timeline. NO intra-scene edits: each scene
    // is one clip at pan 0 (mixed multi-speaker output must not be re-panned),
    // tiny edge fades only (click protection), native internal timing intact.
    const clips: TimelineClip[] = [];
    const sceneTimeline: SceneTimelineEntry[] = [];
    const gapPauses: ScriptedPause[] = [];
    let cursorMs = 0;
    let introClip: TimelineClip | null = null;
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
      cursorMs = Math.max(0, introStd.durationMs - musicCrossfadeMs);
    }

    const stingerClips: TimelineClip[] = [];
    let stingerRotation = 0;
    const openedByOf = (sceneIndex: number) => plan.scenes.find((s) => s.sceneIndex === sceneIndex)?.openedBy ?? "budget";

    for (let i = 0; i < sceneFiles.length; i++) {
      const sf = sceneFiles[i];
      if (i > 0) {
        const openedBy = openedByOf(sf.row.sceneIndex);
        const { gapMs, pause } = sceneGapMs(openedBy, sf.row.sceneIndex);
        gapPauses.push(pause);
        // A stinger may play INSIDE the scene gap on structural breaks.
        if ((openedBy === "topic" || openedBy === "segment") && assetSet.stingers.length > 0 && style !== "clean") {
          const asset = assetSet.stingers[stingerRotation % assetSet.stingers.length];
          stingerRotation++;
          const room = Math.min(asset.durationMs, Math.max(gapMs, 900));
          const startMs = cursorMs + Math.max(0, gapMs - room) + Math.max(0, room - asset.durationMs);
          stingerClips.push({
            filePath: asset.filePath,
            startMs,
            durationMs: asset.durationMs,
            kind: "sfx",
            pan: 0,
            fadeInMs: 15,
            fadeOutMs: 90,
            gainDb: -6,
          });
        }
        cursorMs += gapMs;
      }
      clips.push({
        filePath: sf.filePath,
        startMs: cursorMs,
        durationMs: sf.durationMs,
        kind: "speech",
        pan: 0, // one mixed scene — never fake per-speaker seating
        fadeInMs: 6,
        fadeOutMs: 10,
        gainDb: 0,
      });
      sceneTimeline.push({
        sceneIndex: sf.row.sceneIndex,
        dialogueSceneAudioId: sf.row.id,
        startMs: cursorMs,
        durationMs: sf.durationMs,
        timingStatus: sf.row.timingStatus,
      });
      cursorMs += sf.durationMs;
    }

    const speechEndMs = cursorMs;
    let outroClip: TimelineClip | null = null;
    if (outroStd) {
      outroClip = {
        filePath: outroStd.filePath,
        startMs: Math.max(0, speechEndMs - Math.round(musicCrossfadeMs / 2)),
        durationMs: outroStd.durationMs,
        kind: "music",
        pan: 0,
        fadeInMs: musicCrossfadeMs,
        fadeOutMs: 400,
        gainDb: -2,
      };
    }

    const allClips: TimelineClip[] = [
      ...(introClip ? [introClip] : []),
      ...clips,
      ...stingerClips,
      ...(outroClip ? [outroClip] : []),
    ];

    // 4. One mix render (room tone, glue compression) + optional ducked bed.
    console.log(`[SceneStitcher] Rendering ${clips.length} scene(s), ${stingerClips.length} stinger(s), intro=${!!introClip}, outro=${!!outroClip}.`);
    const foregroundWav = path.join(tempDir, "foreground-mix.wav");
    await renderTimelineToWav(ffmpegPath, allClips, foregroundWav, { sampleRate: targetSampleRate });

    let mixWav = foregroundWav;
    if (style === "full" && assetSet.bed) {
      const fgMs = await getFileDurationMs(ffprobePath, foregroundWav);
      const bedded = path.join(tempDir, "final-mix-bedded.wav");
      const keyClips = [...(introClip ? [introClip] : []), ...clips, ...(outroClip ? [outroClip] : [])];
      const duckKey = path.join(tempDir, "duck-key.wav");
      await renderTimelineToWav(ffmpegPath, keyClips, duckKey, { sampleRate: targetSampleRate });
      await mixBedUnderForeground(ffmpegPath, foregroundWav, assetSet.bed.filePath, bedded, {
        sampleRate: targetSampleRate,
        totalMs: fgMs,
        keyWavPath: duckKey,
      });
      mixWav = bedded;
    }

    // 5. Master.
    const finalOutputPath = path.join(tempDir, "final.mp3");
    if (normalizeAudio) {
      await masterToMp3(ffmpegPath, mixWav, finalOutputPath, { targetLufs, bitrate: targetBitrate });
    } else {
      await runFfmpeg(ffmpegPath, ["-y", "-i", mixWav, "-c:a", "libmp3lame", "-b:a", targetBitrate, finalOutputPath]);
    }
    if (!fs.existsSync(finalOutputPath) || fs.statSync(finalOutputPath).size === 0) {
      throw new Error("Scene-stitched output file is empty or missing.");
    }

    // 6. Technical QA on the master. Pause variety is graded ONLY on the
    // scene-boundary gaps this assembler authored — intra-scene pacing is the
    // dialogue model's own and is NOT scored (that judgment is human).
    let qaReport: AudioQaReport | null = null;
    try {
      qaReport = await analyzeEpisodeAudio(ffmpegPath, finalOutputPath, {
        targetLufs,
        scriptedPauses: gapPauses,
      });
      for (const c of qaReport.checks) console.log(`[SceneStitcher][QA] ${c.status.toUpperCase()} — ${c.name}: ${c.value}`);
    } catch (qaErr) {
      console.warn(`[SceneStitcher] Audio QA analysis skipped/failed: ${(qaErr as Error).message}`);
    }

    const finalFileSizeBytes = fs.statSync(finalOutputPath).size;
    const finalDurationSeconds = (await getFileDurationMs(ffprobePath, finalOutputPath)) / 1000;

    // 7. Upload + persist.
    const storageKey = `episodes/${episodeRow.id}/scripts/${scriptId}/final/scene-final-v${renderRecord.renderVersion}.mp3`;
    const uploadResult = await storageProvider.putObject({
      key: storageKey,
      body: fs.readFileSync(finalOutputPath),
      contentType: "audio/mp3",
    });

    const finalEpisodeStatus = PRODUCED_OR_LATER.has(previousStatus) ? previousStatus : "audio_ready";
    await db.episode.update({
      where: { id: episodeRow.id },
      data: {
        status: finalEpisodeStatus,
        audioUrl: uploadResult.url,
        durationSeconds: Math.round(finalDurationSeconds),
      },
    });

    const diagnostics = {
      version: 1,
      mode: "scene",
      sceneTimeline,
      provider: eligibility.provider,
      voices: Object.fromEntries([...resolvedByHostId.entries()].map(([hostId, r]) => [hostId, { provider: r.provider, voiceId: r.voiceId }])),
      sceneQa,
      style,
      warnings: soundWarnings,
    };
    await db.episodeAudioRender.update({
      where: { id: renderRecord.id },
      data: {
        status: "succeeded",
        completedAt: new Date(),
        productionStyle: style,
        diagnostics: diagnostics as never,
        outputAudioUrl: uploadResult.url,
      },
    });

    const successOutput = {
      episodeId: episodeRow.id,
      scriptId,
      finalStatus: "completed",
      finalAudioUrl: uploadResult.url,
      durationSeconds: Math.round(finalDurationSeconds),
      renderMode: "scene",
      sceneCount: sceneFiles.length,
      sceneTimeline,
      finalFileSizeBytes,
      audioQa: qaReport,
      sceneQa,
      storageKey,
      ffmpegCommandSummary: `${ffmpegPath} scene-timeline-mix (whole-scene clips, native internal timing preserved) + two-pass loudnorm`,
      reasons: ["Final audio stitched from native dialogue scenes.", ...soundWarnings],
    };
    await db.jobLog.update({ where: { id: jobLog.id }, data: { status: "completed", output: successOutput as never } });

    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch { /* best effort */ }

    return successOutput;
  } catch (err) {
    const message = (err as Error).message || "Unknown scene stitching error";
    console.error("[SceneStitcher] Stitching failed:", message);
    if (renderRecordId) {
      try {
        await db.episodeAudioRender.update({
          where: { id: renderRecordId },
          data: { status: "failed", completedAt: new Date(), failureReason: message.slice(0, 500) },
        });
      } catch { /* best effort */ }
    }
    if (episodeIdForRestore) {
      try {
        await db.episode.update({ where: { id: episodeIdForRestore }, data: { status: previousStatus } });
      } catch { /* best effort */ }
    }
    await db.jobLog.update({
      where: { id: jobLog.id },
      data: { status: "failed", error: message, output: { scriptId, finalStatus: "failed", reasons: [message] } as never },
    });
    throw err;
  }
}

/** Is this episode a scene-mode episode with a stitched scene render? */
export function isSceneRenderMode(mode: string | null | undefined): boolean {
  return mode === "scene" || mode === "mixed_fallback";
}

/** sha256 of a file (used by the audition harness / diagnostics). */
export function fileSha256(p: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
}
