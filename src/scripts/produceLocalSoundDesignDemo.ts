// Local sound-design renderer: takes a script's content JSON + its per-line
// audio clips and produces the SAME multi-track mix the production stitcher
// renders (same planners, same ffmpeg graphs, same mastering) — without DB,
// S3, or queue. Used for before/after comparisons and local mix tuning.
//
// Usage:
//   tsx src/scripts/produceLocalSoundDesignDemo.ts \
//     --content <content.json> --segments-dir <dir with line-<n>.mp3> \
//     --out <out.mp3> [--style full] [--density medium] [--dry]
//
// --dry renders the clean (dialogue-only) version for the "before" file.

import fs from "fs";
import os from "os";
import path from "path";
import {
  PlannedLine,
  TimelineClip,
  getFileDurationMs,
  masterToMp3,
  planConversationTimeline,
  renderTimelineToWav,
  standardizeClipToWav,
} from "../lib/audio/assembly";
import {
  SfxCategory,
  SfxLineContext,
  SoundDesignAssetSet,
  emptyAssetSet,
  mixBedUnderForeground,
  pickSfxAsset,
  planReactionSfx,
  planStingers,
} from "../lib/audio/soundDesign";
import { isProductionStyle, isSfxDensity } from "../lib/audio/soundDesignShared";
import { generateStarterPack } from "../lib/audio/soundPackGenerator";

function arg(name: string, fallback?: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx !== -1 ? process.argv[idx + 1] : fallback;
}

async function main() {
  const ffmpegPath = process.env.FFMPEG_PATH || "ffmpeg";
  const ffprobePath = process.env.FFPROBE_PATH || "ffprobe";
  const contentPath = arg("content");
  const segmentsDir = arg("segments-dir");
  const outPath = arg("out");
  const style = arg("style", "full")!;
  const density = arg("density", "medium")!;
  const dry = process.argv.includes("--dry");

  if (!contentPath || !segmentsDir || !outPath) {
    throw new Error("Required: --content <json> --segments-dir <dir> --out <mp3>");
  }
  if (!isProductionStyle(style)) throw new Error(`Bad style '${style}'`);
  if (!isSfxDensity(density)) throw new Error(`Bad density '${density}'`);

  const content = JSON.parse(fs.readFileSync(contentPath, "utf8"));
  const segments = content.segments;
  if (!Array.isArray(segments)) throw new Error("content.segments missing");

  const allLines: any[] = [];
  for (const seg of segments) for (const line of seg.lines || []) allLines.push(line);
  console.log(`Loaded ${allLines.length} lines across ${segments.length} segments.`);

  const work = fs.mkdtempSync(path.join(os.tmpdir(), "take-machine-demo-"));
  const sampleRate = 44100;

  try {
    // 1. Standardize dialogue clips (same as the stitcher).
    const hostIds = [...new Set(allLines.map((l) => l.speakerHostId))];
    const plannedLines: PlannedLine[] = [];
    for (let i = 0; i < allLines.length; i++) {
      const line = allLines[i];
      const src = path.join(segmentsDir, `line-${line.lineIndex}.mp3`);
      if (!fs.existsSync(src)) throw new Error(`Missing clip ${src}`);
      const wav = path.join(work, `std-line-${line.lineIndex}.wav`);
      await standardizeClipToWav(ffmpegPath, src, wav, { sampleRate });
      const durationMs = await getFileDurationMs(ffprobePath, wav);

      let segmentBreak: PlannedLine["segmentBreak"] = "none";
      if (i > 0) {
        const currSeg = segments.findIndex((s: any) => (s.lines || []).some((l: any) => l.lineIndex === line.lineIndex));
        const prevSeg = segments.findIndex((s: any) => (s.lines || []).some((l: any) => l.lineIndex === allLines[i - 1].lineIndex));
        if (currSeg !== prevSeg) segmentBreak = segments[currSeg]?.type === "topic" ? "topic" : "segment";
      }

      plannedLines.push({
        filePath: wav,
        durationMs,
        lineIndex: line.lineIndex,
        hostSlot: line.speakerHostId === hostIds[0] ? 0 : 1,
        pauseBefore: line.pauseBefore,
        isInterruption: line.isInterruption === true,
        segmentBreak,
      });
      if ((i + 1) % 10 === 0) console.log(`  standardized ${i + 1}/${allLines.length} clips`);
    }

    // 2. Assets: synthesize the starter pack locally (identical to seed).
    let assetSet: SoundDesignAssetSet = emptyAssetSet();
    if (!dry && style !== "clean") {
      console.log("Synthesizing starter pack for the mix…");
      const { assets } = await generateStarterPack(ffmpegPath);
      const lufsForKind: Record<string, number> = {
        theme_intro: -17, theme_outro: -17, bed: -18, stinger: -16, sfx: -16,
      };
      for (const a of assets) {
        const wav = path.join(work, `asset-${a.fileName}.wav`);
        await standardizeClipToWav(ffmpegPath, a.filePath, wav, { sampleRate, targetLufs: lufsForKind[a.kind] ?? -17 });
        const durationMs = await getFileDurationMs(ffprobePath, wav);
        const loaded = { id: a.fileName, name: a.name, kind: a.kind, category: a.category, filePath: wav, durationMs };
        if (a.kind === "theme_intro") assetSet.intro = loaded;
        else if (a.kind === "theme_outro") assetSet.outro = loaded;
        else if (a.kind === "bed") assetSet.bed = loaded;
        else if (a.kind === "stinger") assetSet.stingers.push(loaded);
        else if (a.kind === "sfx" && a.category) {
          const pool = assetSet.sfxByCategory.get(a.category as SfxCategory) || [];
          pool.push(loaded);
          assetSet.sfxByCategory.set(a.category as SfxCategory, pool);
        }
      }
    }

    // 3. Timeline (same flow as audioStitchingService).
    const musicCrossfadeMs = 900;
    let introClip: TimelineClip | null = null;
    let dialogueStartMs = 0;
    if (assetSet.intro) {
      introClip = {
        filePath: assetSet.intro.filePath, startMs: 0, durationMs: assetSet.intro.durationMs,
        kind: "music", pan: 0, fadeInMs: 20, fadeOutMs: musicCrossfadeMs, gainDb: -2,
      };
      dialogueStartMs = Math.max(0, assetSet.intro.durationMs - musicCrossfadeMs);
    }

    const stingerDurations = assetSet.stingers.map((s) => s.durationMs);
    const maxStingerMs = stingerDurations.length ? Math.max(...stingerDurations) : 0;
    const planOpts: Parameters<typeof planConversationTimeline>[1] = { startAtMs: dialogueStartMs };
    if (!dry && style !== "clean" && maxStingerMs > 0) {
      planOpts.topicGapMs = Math.max(1200, maxStingerMs + 800);
      if (style === "full") planOpts.segmentGapMs = Math.max(850, maxStingerMs + 700);
    }
    const dialogueClips = planConversationTimeline(plannedLines, planOpts);

    const lineByIndex = new Map<number, any>(allLines.map((l) => [l.lineIndex, l]));
    const slots = plannedLines
      .map((l, i) => ({ l, c: dialogueClips[i] }))
      .filter(({ l }) => l.segmentBreak === "segment" || l.segmentBreak === "topic")
      .map(({ l, c }) => ({ lineIndex: l.lineIndex, breakKind: l.segmentBreak as "segment" | "topic", lineStartMs: c.startMs }));
    const stingerPlacements = dry ? [] : planStingers(slots, style, stingerDurations);
    const stingerClips: TimelineClip[] = stingerPlacements.map((p) => {
      const a = assetSet.stingers[p.stingerIndex];
      return { filePath: a.filePath, startMs: p.atMs, durationMs: a.durationMs, kind: "sfx", pan: 0, fadeInMs: 15, fadeOutMs: 90, gainDb: p.gainDb };
    });

    const reactionClips: TimelineClip[] = [];
    if (!dry && style === "full") {
      const contexts: SfxLineContext[] = plannedLines.map((l, i) => {
        const sl = lineByIndex.get(l.lineIndex) || {};
        return { lineIndex: l.lineIndex, tone: sl.tone, energy: sl.energy, startMs: dialogueClips[i].startMs, durationMs: dialogueClips[i].durationMs };
      });
      const reactions = planReactionSfx(contexts, density, { availableCategories: new Set([...assetSet.sfxByCategory.keys()]) });
      for (const p of reactions) {
        const a = pickSfxAsset(assetSet, p);
        if (!a) continue;
        reactionClips.push({ filePath: a.filePath, startMs: p.atMs, durationMs: a.durationMs, kind: "sfx", pan: 0, fadeInMs: 25, fadeOutMs: 150, gainDb: p.gainDb });
        console.log(`  reaction @line ${p.lineIndex}: ${a.name} (${p.reason})`);
      }
    }

    const clips: TimelineClip[] = [...(introClip ? [introClip] : []), ...dialogueClips, ...stingerClips, ...reactionClips];
    const dialogueEndMs = Math.max(...dialogueClips.map((c) => c.startMs + c.durationMs));
    if (assetSet.outro) {
      clips.push({
        filePath: assetSet.outro.filePath,
        startMs: Math.max(0, dialogueEndMs - Math.round(musicCrossfadeMs / 2)),
        durationMs: assetSet.outro.durationMs,
        kind: "music", pan: 0, fadeInMs: musicCrossfadeMs, fadeOutMs: 400, gainDb: -2,
      });
    }

    console.log(`Rendering ${clips.length} clips (${stingerClips.length} stingers, ${reactionClips.length} reactions)…`);
    const foreground = path.join(work, "foreground.wav");
    await renderTimelineToWav(ffmpegPath, clips, foreground, { sampleRate });

    let mixPath = foreground;
    if (!dry && style === "full" && assetSet.bed) {
      const foregroundMs = await getFileDurationMs(ffprobePath, foreground);
      const bedded = path.join(work, "bedded.wav");
      console.log("Ducking music bed under the mix…");
      await mixBedUnderForeground(ffmpegPath, foreground, assetSet.bed.filePath, bedded, { sampleRate, totalMs: foregroundMs });
      mixPath = bedded;
    }

    console.log("Mastering (two-pass loudnorm to -16 LUFS)…");
    await masterToMp3(ffmpegPath, mixPath, outPath, { targetLufs: -16 });
    const finalMs = await getFileDurationMs(ffprobePath, outPath);
    console.log(`Done: ${outPath} (${(finalMs / 1000 / 60).toFixed(1)} min, ${(fs.statSync(outPath).size / 1048576).toFixed(1)} MB)`);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
