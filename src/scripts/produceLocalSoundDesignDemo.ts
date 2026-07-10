// Local sound-design renderer + variety harness.
//
// SINGLE MODE (original): takes a script's content JSON + its per-line audio
// clips and produces the SAME multi-track mix the production stitcher renders
// (same planners, same ffmpeg graphs, same mastering) — without DB, S3, or
// queue. Used for before/after comparisons and local mix tuning.
//
//   tsx src/scripts/produceLocalSoundDesignDemo.ts \
//     --content <content.json> --segments-dir <dir with line-<n>.mp3> \
//     --out <out.mp3> [--style full] [--density medium] [--dry]
//
//   --dry renders the clean (dialogue-only) version for the "before" file.
//
// VARIETY MODE (--variety): the ProductionPlanner acceptance harness. Renders
// the four fixture episodes (blowout / rivalry / betting-line / injury-news)
// twice each — "before" via the legacy rotation renderer, "after" from a
// generated ProductionPlan — with a cooldown ledger threaded across the run,
// then ASSERTS that:
//   1. the four cue sheets measurably differ (pairwise similarity bound),
//   2. cooldown suppressed stinger/bed repeats across consecutive episodes,
//   3. a hot script out-cues a calm one, silence cues exist, plans replay
//      deterministically.
// Dialogue is synthesized (band-limited noise per line) so the harness needs
// no TTS. Outputs land in samples/planner-variety/ (cue-sheet JSONs, a
// variety-report.json, and the eight mp3 renders).
//
//   npm run demo:sound-variety     (tsx src/scripts/produceLocalSoundDesignDemo.ts --variety)

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
  runFfmpeg,
  standardizeClipToWav,
} from "../lib/audio/assembly";
import {
  LoadedAsset,
  ProductionStyle,
  SfxCategory,
  SfxDensity,
  SfxLineContext,
  SoundDesignAssetSet,
  emptyAssetSet,
  mixBedUnderForeground,
  pickSfxAsset,
  planReactionSfx,
  planStingers,
} from "../lib/audio/soundDesign";
import { isProductionStyle, isSfxDensity } from "../lib/audio/soundDesignShared";
import { GeneratedAssetSpec, STARTER_PACK, generatePackAsset } from "../lib/audio/soundPackGenerator";
import type { ProductionPlan } from "../lib/audio/productionPlan";
import {
  CooldownSnapshot,
  DEFAULT_PLANNER_CONFIG,
  PlannerAsset,
  generateProductionPlan,
  planAssetUsage,
  plannerLinesFromScriptContent,
} from "../lib/audio/productionPlanner";
import {
  PlanTimelineResult,
  executePlanOnTimeline,
  plannedStingerDurations,
  resolveIntroFromPlan,
} from "../lib/audio/planExecution";
import { parseAssetMetadata } from "../lib/audio/assetMetadata";

// Synth catalog metadata so the harness exercises MUSICAL-FIT selection (the
// seed pack carries no Epidemic tags of its own). Beds span energy families;
// stingers/sfx carry descriptive character words. This is test setup — it maps
// synth assets to the same tag shape the real crate uses.
const DEMO_BED_META: Record<string, { family: string; bpm: number; moods: string[] }> = {
  "Fast Break": { family: "urgent/driving", bpm: 140, moods: ["action", "restless", "drive"] },
  "Crunch Time": { family: "urgent/driving", bpm: 128, moods: ["intense", "aggressive"] },
  "Victory Lap": { family: "upbeat", bpm: 120, moods: ["happy", "bright", "euphoric"] },
  "Film Room": { family: "neutral", bpm: 100, moods: ["analytical", "clean", "corporate"] },
  "Slow Burn": { family: "dark/tense", bpm: 80, moods: ["suspense", "dark", "sneaking"] },
};
const DEMO_STINGER_MOODS: Record<string, string[]> = {
  "Slam Riser": ["riser", "epic", "build"],
  "Drum Hit": ["impact", "hit"],
  "Whoosh Cut": ["whoosh", "swish"],
  "Power Chord Stab": ["impact", "aggressive"],
  "Laser Sweep Down": ["whoosh", "dark"],
  "Bell Rise": ["riser", "bright"],
  "Sub Drop": ["impact", "dark", "boom"],
  "Snare Rush": ["build", "urgent"],
  "Horn Fall": ["horns", "fall"],
  "Glitch Zap": ["glitch", "tech"],
};
function demoBaseName(name: string): string {
  return name
    .replace(/ \((music bed|stinger|intro theme|outro theme|sfx)\)/, "")
    .trim()
    .replace(/ II$/, "");
}
function demoTagsFor(name: string, kind: string, category: string | null): string[] {
  const base = demoBaseName(name);
  if (kind === "bed") {
    const m = DEMO_BED_META[base];
    return m ? [`energy:${m.family}`, `bpm:${m.bpm}`, ...m.moods, "no vocals"] : ["no vocals"];
  }
  if (kind === "stinger") return DEMO_STINGER_MOODS[base] ?? ["transition"];
  if (kind === "theme_intro") return ["arena", "charge", "broadcast"];
  if (kind === "theme_outro") return ["arena", "final", "whistle", "sport"];
  if (kind === "sfx" && category) return [category];
  return [];
}

function arg(name: string, fallback?: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx !== -1 ? process.argv[idx + 1] : fallback;
}

const ffmpegPath = process.env.FFMPEG_PATH || "ffmpeg";
const ffprobePath = process.env.FFPROBE_PATH || "ffprobe";
const SAMPLE_RATE = 44100;

// ---------------------------------------------------------------------------
// Asset loading (starter pack synthesized locally, identical to the seed)
// ---------------------------------------------------------------------------

interface DemoAssets {
  set: SoundDesignAssetSet;
  catalog: PlannerAsset[];
}

const LUFS_FOR_KIND: Record<string, number> = {
  theme_intro: -17,
  theme_outro: -17,
  bed: -18,
  stinger: -16,
  sfx: -16,
};

/** Pitch-shifted variants deepen the library so the cooldown has room to
 *  rotate (prod grows the same way: operators upload more assets). */
function variantSpecs(): GeneratedAssetSpec[] {
  const out: GeneratedAssetSpec[] = [];
  for (const spec of STARTER_PACK) {
    if (spec.kind !== "stinger" && spec.kind !== "bed") continue;
    const rate = spec.kind === "bed" ? 0.92 : 1.12;
    out.push({
      ...spec,
      name: `${spec.name.replace(/ \((stinger|music bed)\)/, "")} II (${spec.kind === "bed" ? "music bed" : "stinger"})`,
      fileName: spec.fileName.replace(/\.mp3$/, "-ii.mp3"),
      post: [spec.post, `asetrate=${Math.round(44100 * rate)},aresample=44100`].filter(Boolean).join(","),
    });
  }
  return out;
}

async function loadDemoAssets(work: string, opts: { withVariants: boolean }): Promise<DemoAssets> {
  const set = emptyAssetSet();
  const catalog: PlannerAsset[] = [];
  const specs = opts.withVariants ? [...STARTER_PACK, ...variantSpecs()] : STARTER_PACK;
  const packDir = path.join(work, "pack");
  fs.mkdirSync(packDir, { recursive: true });
  for (const spec of specs) {
    const { filePath } = await generatePackAsset(ffmpegPath, spec, packDir);
    const wav = path.join(work, `asset-${spec.fileName}.wav`);
    await standardizeClipToWav(ffmpegPath, filePath, wav, {
      sampleRate: SAMPLE_RATE,
      targetLufs: LUFS_FOR_KIND[spec.kind] ?? -17,
    });
    const durationMs = await getFileDurationMs(ffprobePath, wav);
    const loaded: LoadedAsset = {
      id: spec.fileName,
      name: spec.name,
      kind: spec.kind,
      category: spec.category,
      filePath: wav,
      durationMs,
    };
    set.byId.set(loaded.id, loaded);
    catalog.push({
      id: loaded.id,
      name: loaded.name,
      kind: loaded.kind,
      category: loaded.category,
      durationMs,
      tags: demoTagsFor(loaded.name, loaded.kind, loaded.category),
    });
    if (spec.kind === "theme_intro") set.intro = loaded;
    else if (spec.kind === "theme_outro") set.outro = loaded;
    else if (spec.kind === "bed") set.bed = set.bed ?? loaded;
    else if (spec.kind === "stinger") set.stingers.push(loaded);
    else if (spec.kind === "sfx" && spec.category) {
      const pool = set.sfxByCategory.get(spec.category as SfxCategory) || [];
      pool.push(loaded);
      set.sfxByCategory.set(spec.category as SfxCategory, pool);
    }
  }
  return { set, catalog };
}

// ---------------------------------------------------------------------------
// Shared episode rendering
// ---------------------------------------------------------------------------

interface EpisodeInput {
  allLines: DemoScriptLine[];
  segments: DemoScriptSegment[];
  plannedLines: PlannedLine[];
  assets: DemoAssets;
  style: ProductionStyle;
  density: SfxDensity;
  dry: boolean;
  work: string;
}

async function mixAndMaster(
  clips: TimelineClip[],
  bedAsset: LoadedAsset | null,
  work: string,
  outPath: string,
  bitrate: string
): Promise<void> {
  const tag = path.basename(outPath, ".mp3");
  const foreground = path.join(work, `${tag}-foreground.wav`);
  await renderTimelineToWav(ffmpegPath, clips, foreground, { sampleRate: SAMPLE_RATE });
  let mixPath = foreground;
  if (bedAsset) {
    const foregroundMs = await getFileDurationMs(ffprobePath, foreground);
    const bedded = path.join(work, `${tag}-bedded.wav`);
    await mixBedUnderForeground(ffmpegPath, foreground, bedAsset.filePath, bedded, {
      sampleRate: SAMPLE_RATE,
      totalMs: foregroundMs,
    });
    mixPath = bedded;
  }
  await masterToMp3(ffmpegPath, mixPath, outPath, { targetLufs: -16, bitrate });
}

/** The legacy renderer: rotation stingers + fixed tone→SFX mapping. This is
 *  exactly what production runs with SOUND_DESIGN_PLANNER off. */
async function renderLegacyMix(
  input: EpisodeInput,
  outPath: string,
  bitrate = "192k"
): Promise<{ stingerCount: number; reactionCount: number }> {
  const { allLines, plannedLines, assets, style, density, dry, work } = input;
  const assetSet = dry || style === "clean" ? emptyAssetSet() : assets.set;

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

  const lineByIndex = new Map<number, DemoScriptLine>(allLines.map((l) => [l.lineIndex, l]));
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
      const sl = lineByIndex.get(l.lineIndex);
      return { lineIndex: l.lineIndex, tone: sl?.tone, energy: sl?.energy, startMs: dialogueClips[i].startMs, durationMs: dialogueClips[i].durationMs };
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
  const bedAsset = !dry && style === "full" ? assetSet.bed : null;
  if (bedAsset) console.log("Ducking music bed under the mix…");
  await mixAndMaster(clips, bedAsset, work, outPath, bitrate);
  return { stingerCount: stingerClips.length, reactionCount: reactionClips.length };
}

/** The planner renderer: executes a ProductionPlan — what production runs
 *  with SOUND_DESIGN_PLANNER=true. */
async function renderPlannedMix(
  input: EpisodeInput,
  plan: ProductionPlan,
  outPath: string,
  bitrate = "96k"
): Promise<PlanTimelineResult> {
  const { plannedLines, assets, work } = input;
  const warnings: string[] = [];
  const musicCrossfadeMs = 900;

  const { introClip, dialogueStartMs } = resolveIntroFromPlan({
    plan, assetsById: assets.set.byId, musicCrossfadeMs, warnings,
  });

  const stingerDurations = plannedStingerDurations(plan, assets.set.byId);
  const maxStingerMs = stingerDurations.length ? Math.max(...stingerDurations) : 0;
  const planOpts: Parameters<typeof planConversationTimeline>[1] = { startAtMs: dialogueStartMs };
  if (maxStingerMs > 0) {
    planOpts.topicGapMs = Math.max(1200, maxStingerMs + 800);
    if (plan.style === "full") planOpts.segmentGapMs = Math.max(850, maxStingerMs + 700);
  }
  const dialogueClips = planConversationTimeline(plannedLines, planOpts);

  const executed = executePlanOnTimeline({
    plan, plannedLines, dialogueClips, assetsById: assets.set.byId,
    musicCrossfadeMs, dialogueStartMs, warnings,
  });
  for (const w of warnings) console.warn(`  [plan] ${w}`);
  for (const s of executed.silenceSummary) console.log(`  silence @line ${s.lineIndex}: ${s.reason}`);
  for (const s of executed.stingerSummary) console.log(`  stinger @line ${s.lineIndex}: ${s.asset} (${s.reason})`);
  for (const r of executed.reactionSummary) console.log(`  reaction @line ${r.lineIndex}: ${r.asset} (${r.reason})`);

  const clips: TimelineClip[] = [
    ...(introClip ? [introClip] : []),
    ...dialogueClips,
    ...executed.highlightClips,
    ...executed.stingerClips,
    ...executed.reactionClips,
    ...(executed.outroClip ? [executed.outroClip] : []),
  ];
  console.log(`Rendering ${clips.length} clips from the plan…`);
  if (executed.bedAsset) console.log(`Ducking planned bed '${executed.bedAsset.name}' under the mix…`);
  await mixAndMaster(clips, executed.bedAsset, work, outPath, bitrate);
  return executed;
}

// ---------------------------------------------------------------------------
// Fixture plumbing
// ---------------------------------------------------------------------------

/** Script-content-shaped line/segment as the demo needs them. */
interface DemoScriptLine {
  lineIndex: number;
  speakerHostId?: string;
  text?: string;
  tone?: string;
  energy?: string;
  pauseBefore?: PlannedLine["pauseBefore"];
  isInterruption?: boolean;
}
interface DemoScriptSegment {
  type?: string;
  title?: string;
  lines?: DemoScriptLine[];
}

function flattenSegments(segments: DemoScriptSegment[]): DemoScriptLine[] {
  const allLines: DemoScriptLine[] = [];
  for (const seg of segments) for (const line of seg.lines || []) allLines.push(line);
  return allLines;
}

function segmentBreakFor(
  segments: DemoScriptSegment[],
  allLines: DemoScriptLine[],
  i: number
): PlannedLine["segmentBreak"] {
  if (i === 0) return "none";
  const line = allLines[i];
  const currSeg = segments.findIndex((s) => (s.lines || []).some((l) => l.lineIndex === line.lineIndex));
  const prevSeg = segments.findIndex((s) => (s.lines || []).some((l) => l.lineIndex === allLines[i - 1].lineIndex));
  if (currSeg === prevSeg) return "none";
  return segments[currSeg]?.type === "topic" ? "topic" : "segment";
}

/** Synthesize a deterministic "speech" clip for a line: band-limited pink
 *  noise, host-specific band, duration scaled to the text length. */
async function synthesizeLineClip(work: string, line: DemoScriptLine, hostSlot: 0 | 1): Promise<string> {
  const durationSec = Math.min(4.2, Math.max(1.4, 0.7 + (line.text?.length ?? 60) * 0.018)).toFixed(2);
  const band = hostSlot === 0 ? 700 : 1100;
  const raw = path.join(work, `raw-line-${line.lineIndex}.wav`);
  await runFfmpeg(ffmpegPath, [
    "-y", "-f", "lavfi",
    "-i", `anoisesrc=color=pink:amplitude=0.25:seed=${line.lineIndex + 1}:duration=${durationSec}`,
    "-af", `bandpass=f=${band}:width_type=h:w=1200,volume=12dB,aformat=channel_layouts=stereo`,
    "-ar", String(SAMPLE_RATE), "-c:a", "pcm_s16le", raw,
  ]);
  const wav = path.join(work, `std-line-${line.lineIndex}.wav`);
  await standardizeClipToWav(ffmpegPath, raw, wav, { sampleRate: SAMPLE_RATE });
  return wav;
}

async function buildPlannedLines(
  work: string,
  segments: DemoScriptSegment[],
  synthesize: boolean,
  segmentsDir?: string
): Promise<{ allLines: DemoScriptLine[]; plannedLines: PlannedLine[] }> {
  const allLines = flattenSegments(segments);
  const hostIds = [...new Set(allLines.map((l) => l.speakerHostId))];
  const plannedLines: PlannedLine[] = [];
  for (let i = 0; i < allLines.length; i++) {
    const line = allLines[i];
    const hostSlot = (line.speakerHostId === hostIds[0] ? 0 : 1) as 0 | 1;
    let wav: string;
    if (synthesize) {
      wav = await synthesizeLineClip(work, line, hostSlot);
    } else {
      const src = path.join(segmentsDir!, `line-${line.lineIndex}.mp3`);
      if (!fs.existsSync(src)) throw new Error(`Missing clip ${src}`);
      wav = path.join(work, `std-line-${line.lineIndex}.wav`);
      await standardizeClipToWav(ffmpegPath, src, wav, { sampleRate: SAMPLE_RATE });
    }
    const durationMs = await getFileDurationMs(ffprobePath, wav);
    plannedLines.push({
      filePath: wav,
      durationMs,
      lineIndex: line.lineIndex,
      hostSlot,
      pauseBefore: line.pauseBefore,
      isInterruption: line.isInterruption === true,
      segmentBreak: segmentBreakFor(segments, allLines, i),
    });
    if ((i + 1) % 10 === 0) console.log(`  prepared ${i + 1}/${allLines.length} clips`);
  }
  return { allLines, plannedLines };
}

// ---------------------------------------------------------------------------
// Variety harness (--variety)
// ---------------------------------------------------------------------------

const VARIETY_FIXTURES = ["blowout", "rivalry", "betting-line", "injury-news"] as const;

/** Cue-sheet signature: what plays, where in the episode (thirds), from what
 *  family — the basis of the "measurably differ" assertion. */
function planSignature(plan: ProductionPlan): Set<string> {
  const lineCount = Math.max(1, plan.stats.lineCount);
  return new Set(
    plan.cues.map((c) => {
      const bucket = Math.min(2, Math.floor((3 * c.lineIndex) / lineCount));
      return `${c.type}:${c.assetName ?? "-"}:${bucket}`;
    })
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  const inter = [...a].filter((x) => b.has(x)).length;
  const union = new Set([...a, ...b]).size;
  return union === 0 ? 1 : inter / union;
}

async function runVariety(): Promise<void> {
  const outDir = arg("out-dir", path.join("samples", "planner-variety"))!;
  const style: ProductionStyle = "full";
  const density: SfxDensity = "medium";
  fs.mkdirSync(outDir, { recursive: true });
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "take-machine-variety-"));

  const failures: string[] = [];
  const assertOk = (cond: boolean, msg: string) => {
    if (cond) console.log(`  ✓ ${msg}`);
    else {
      failures.push(msg);
      console.error(`  ✗ ${msg}`);
    }
  };

  try {
    console.log("Synthesizing asset library (starter pack + variants)…");
    const assets = await loadDemoAssets(work, { withVariants: true });
    console.log(
      `  ${assets.catalog.length} assets: ` +
        `${assets.catalog.filter((a) => a.kind === "stinger").length} stingers, ` +
        `${assets.catalog.filter((a) => a.kind === "bed").length} beds, ` +
        `${assets.catalog.filter((a) => a.kind === "sfx").length} sfx`
    );

    const cooldown: CooldownSnapshot = { episodes: [] };
    const results: Array<{
      name: string;
      plan: ProductionPlan;
      executed: PlanTimelineResult;
      legacy: { stingerCount: number; reactionCount: number };
    }> = [];

    for (const name of VARIETY_FIXTURES) {
      console.log(`\n=== Episode: ${name} ===`);
      const fixturePath = path.join("src", "scripts", "fixtures", "varietyEpisodes", `${name}.json`);
      const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
      const epWork = path.join(work, name);
      fs.mkdirSync(epWork, { recursive: true });

      console.log("Synthesizing dialogue…");
      const { allLines, plannedLines } = await buildPlannedLines(epWork, fixture.segments, true);

      const input: EpisodeInput = {
        allLines,
        segments: fixture.segments,
        plannedLines,
        assets,
        style,
        density,
        dry: false,
        work: epWork,
      };

      console.log("BEFORE (legacy rotation renderer):");
      const legacy = await renderLegacyMix(input, path.join(outDir, `${name}.before.mp3`), "96k");

      console.log("AFTER (ProductionPlan renderer):");
      const plan = generateProductionPlan({
        episodeId: `variety-${name}`,
        scriptId: `variety-script-${name}`,
        style,
        sfxDensity: density,
        lines: plannerLinesFromScriptContent(fixture.segments),
        assets: assets.catalog,
        cooldown: { episodes: [...cooldown.episodes] },
        includeIntro: true,
        includeOutro: true,
        introAssetId: assets.set.intro?.id ?? null,
        outroAssetId: assets.set.outro?.id ?? null,
      });
      const executed = await renderPlannedMix(input, plan, path.join(outDir, `${name}.after.mp3`));

      fs.writeFileSync(
        path.join(outDir, `${name}.cuesheet.json`),
        JSON.stringify(
          {
            fixture: name,
            title: fixture.title,
            arc: fixture.arc,
            plan,
            executed: {
              bedAsset: executed.bedAsset?.name ?? null,
              stingers: executed.stingerSummary,
              reactions: executed.reactionSummary,
              silences: executed.silenceSummary,
            },
            legacyForComparison: legacy,
          },
          null,
          2
        )
      );

      // Feed the ledger exactly like the stitcher does after a shipped render.
      cooldown.episodes.unshift({
        episodeId: plan.episodeId,
        assetIds: [...new Set(planAssetUsage(plan).map((u) => u.assetId))],
      });
      results.push({ name, plan, executed, legacy });
    }

    console.log("\n=== Assertions ===");

    // 1. Cue sheets measurably differ, pairwise.
    for (let i = 0; i < results.length; i++) {
      for (let j = i + 1; j < results.length; j++) {
        const sim = jaccard(planSignature(results[i].plan), planSignature(results[j].plan));
        assertOk(
          sim < 0.85,
          `cue sheets differ: ${results[i].name} vs ${results[j].name} (similarity ${sim.toFixed(2)})`
        );
      }
    }

    // 2. Cooldown suppressed repeats: no stinger/bed asset recurs within the
    //    cooldown window across the run, and suppression actually fired.
    const windowN = DEFAULT_PLANNER_CONFIG.cooldownEpisodes;
    for (let i = 1; i < results.length; i++) {
      const recent = new Set(
        results
          .slice(Math.max(0, i - windowN), i)
          .flatMap((r) => planAssetUsage(r.plan))
          .filter((u) => u.cueType === "stinger" || u.cueType === "bed_change")
          .map((u) => u.assetId)
      );
      const repeats = planAssetUsage(results[i].plan)
        .filter((u) => u.cueType === "stinger" || u.cueType === "bed_change")
        .filter((u) => recent.has(u.assetId));
      assertOk(
        repeats.length === 0,
        `no stinger/bed repeat within ${windowN}-episode cooldown at '${results[i].name}'` +
          (repeats.length ? ` — repeated: ${repeats.map((r) => r.assetId).join(", ")}` : "")
      );
    }
    const totalSuppressions = results.reduce((a, r) => a + r.plan.stats.cooldownSuppressions, 0);
    assertOk(totalSuppressions > 0, `cooldown suppressions occurred across the run (${totalSuppressions})`);

    // 3. Episode awareness: the hot script out-cues the calm one.
    const byName = new Map(results.map((r) => [r.name, r]));
    const rivalry = byName.get("rivalry")!.plan.stats;
    const betting = byName.get("betting-line")!.plan.stats;
    assertOk(
      rivalry.reactionCues > betting.reactionCues,
      `rivalry (${rivalry.reactionCues} reactions) out-cues betting-line (${betting.reactionCues})`
    );

    // 4. Silence is real: at least one deliberate hold across the run.
    const totalSilences = results.reduce((a, r) => a + r.plan.stats.silenceCues, 0);
    assertOk(totalSilences > 0, `silence cues planned across the run (${totalSilences})`);

    // 5. Determinism: episode 1's plan replays byte-identically from the
    //    same inputs (empty ledger at that point in the run).
    const replay = generateProductionPlan({
      episodeId: `variety-${results[0].name}`,
      scriptId: `variety-script-${results[0].name}`,
      style,
      sfxDensity: density,
      lines: plannerLinesFromScriptContent(
        JSON.parse(
          fs.readFileSync(path.join("src", "scripts", "fixtures", "varietyEpisodes", `${results[0].name}.json`), "utf8")
        ).segments
      ),
      assets: assets.catalog,
      cooldown: { episodes: [] },
      includeIntro: true,
      includeOutro: true,
      introAssetId: assets.set.intro?.id ?? null,
      outroAssetId: assets.set.outro?.id ?? null,
    });
    assertOk(
      JSON.stringify(replay) === JSON.stringify(results[0].plan),
      "plan replays deterministically from identical inputs"
    );

    // 6. Metadata FIT (Step 5c): each fixture's chosen bed matches its emotional
    //    profile, and the hard rules hold — injury-news must not ride an upbeat
    //    bed; the blowout must not ride a somber one. Report fit scores.
    const bedOf = (r: (typeof results)[number]) => {
      const bedCue = r.plan.cues.find((c) => c.type === "bed_change");
      if (!bedCue?.assetId) return { name: null as string | null, family: null as string | null, fit: null as number | null };
      const asset = assets.catalog.find((a) => a.id === bedCue.assetId)!;
      const m = parseAssetMetadata({ name: asset.name, kind: "bed", category: null, tags: asset.tags ?? [] });
      return { name: bedCue.assetName, family: m.energyFamily, fit: bedCue.fit ?? null };
    };
    const beds = Object.fromEntries(results.map((r) => [r.name, bedOf(r)]));
    const fitReport = results.map((r) => {
      const withFit = r.plan.cues.filter((c) => typeof c.fit === "number");
      const meanFit = withFit.length ? withFit.reduce((a, c) => a + (c.fit || 0), 0) / withFit.length : 0;
      return {
        fixture: r.name,
        bed: beds[r.name],
        placedCues: withFit.length,
        meanFit: Number(meanFit.toFixed(2)),
        stingerFits: r.plan.cues.filter((c) => c.type === "stinger").map((c) => ({ name: c.assetName, fit: c.fit })),
      };
    });
    console.log("\n=== Fit report (Step 5) ===");
    for (const f of fitReport) {
      console.log(`  ${f.fixture}: bed '${f.bed.name}' [${f.bed.family}] fit ${f.bed.fit} | ${f.placedCues} placed cues, mean fit ${f.meanFit}`);
    }
    assertOk(beds["injury-news"].family !== "upbeat", `injury-news bed is not upbeat (got ${beds["injury-news"].family})`);
    assertOk(beds["blowout"].family !== "dark/tense", `blowout bed is not somber (got ${beds["blowout"].family})`);
    const distinctFamilies = new Set(Object.values(beds).map((b) => b.family).filter(Boolean));
    assertOk(distinctFamilies.size >= 2, `bed energy families vary across fixtures (${[...distinctFamilies].join(", ")})`);
    assertOk(fitReport.every((f) => f.placedCues === 0 || f.meanFit > 0), "placed cues carry musical fit scores");

    const report = {
      generatedBy: "produceLocalSoundDesignDemo.ts --variety",
      style,
      density,
      assetLibrary: assets.catalog.map((a) => ({ id: a.id, kind: a.kind, category: a.category })),
      episodes: results.map((r) => ({
        name: r.name,
        cueStats: r.plan.stats,
        legacyForComparison: r.legacy,
        assetsUsed: [...new Set(planAssetUsage(r.plan).map((u) => u.assetId))],
      })),
      pairwiseSimilarity: results.flatMap((a, i) =>
        results.slice(i + 1).map((b) => ({
          pair: `${a.name} vs ${b.name}`,
          jaccard: Number(jaccard(planSignature(a.plan), planSignature(b.plan)).toFixed(3)),
        }))
      ),
      totalCooldownSuppressions: totalSuppressions,
      fitReport,
      assertionFailures: failures,
    };
    fs.writeFileSync(path.join(outDir, "variety-report.json"), JSON.stringify(report, null, 2));
    console.log(`\nWrote cue sheets, renders, and variety-report.json to ${outDir}`);

    if (failures.length > 0) {
      console.error(`\n${failures.length} assertion(s) failed.`);
      process.exit(1);
    }
    console.log("All variety assertions passed.");
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Single-episode mode (original behavior)
// ---------------------------------------------------------------------------

async function runSingle(): Promise<void> {
  const contentPath = arg("content");
  const segmentsDir = arg("segments-dir");
  const outPath = arg("out");
  const style = arg("style", "full")!;
  const density = arg("density", "medium")!;
  const dry = process.argv.includes("--dry");

  if (!contentPath || !segmentsDir || !outPath) {
    throw new Error("Required: --content <json> --segments-dir <dir> --out <mp3> (or --variety)");
  }
  if (!isProductionStyle(style)) throw new Error(`Bad style '${style}'`);
  if (!isSfxDensity(density)) throw new Error(`Bad density '${density}'`);

  const content = JSON.parse(fs.readFileSync(contentPath, "utf8"));
  const segments = content.segments;
  if (!Array.isArray(segments)) throw new Error("content.segments missing");

  const work = fs.mkdtempSync(path.join(os.tmpdir(), "take-machine-demo-"));
  try {
    const allLinesCount = flattenSegments(segments).length;
    console.log(`Loaded ${allLinesCount} lines across ${segments.length} segments.`);
    const { allLines, plannedLines } = await buildPlannedLines(work, segments, false, segmentsDir);

    let assets: DemoAssets = { set: emptyAssetSet(), catalog: [] };
    if (!dry && style !== "clean") {
      console.log("Synthesizing starter pack for the mix…");
      assets = await loadDemoAssets(work, { withVariants: false });
    }

    await renderLegacyMix(
      { allLines, segments, plannedLines, assets, style, density, dry, work },
      outPath
    );
    const finalMs = await getFileDurationMs(ffprobePath, outPath);
    console.log(`Done: ${outPath} (${(finalMs / 1000 / 60).toFixed(1)} min, ${(fs.statSync(outPath).size / 1048576).toFixed(1)} MB)`);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

async function main() {
  if (process.argv.includes("--variety")) return runVariety();
  return runSingle();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
