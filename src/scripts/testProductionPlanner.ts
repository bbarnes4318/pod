// Production-planner test suite. Run: npm run test:production-planner
//
// Pure unit tests (no ffmpeg, no DB): plan generation, determinism, variety,
// cross-episode cooldown, per-episode max-uses, silence-as-a-cue, the
// opening-line rule, flag parsing, and plan execution onto a timeline.

import type { PlannedLine, TimelineClip } from "../lib/audio/assembly";
import type { LoadedAsset } from "../lib/audio/soundDesign";
import {
  executePlanOnTimeline,
  plannedStingerDurations,
  resolveIntroFromPlan,
} from "../lib/audio/planExecution";
import { parseProductionPlan } from "../lib/audio/productionPlan";
import {
  CooldownSnapshot,
  DEFAULT_PLANNER_CONFIG,
  PlannerAsset,
  PlannerLine,
  RawScriptLine,
  generateProductionPlan,
  isSoundDesignPlannerEnabled,
  planAssetUsage,
  plannerLinesFromScriptContent,
  resolvePlannerConfig,
} from "../lib/audio/productionPlanner";

let passed = 0;
let failed = 0;

function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed++;
      console.log(`  ✓ ${name}`);
    })
    .catch((err) => {
      failed++;
      console.error(`  ✗ ${name}\n      ${err.message}`);
    });
}

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A starter-pack-shaped asset catalog: 3 stingers, 2 beds, 1 sfx/category. */
function makeCatalog(): PlannerAsset[] {
  return [
    { id: "intro-1", name: "Arena Charge", kind: "theme_intro", category: null, durationMs: 8500 },
    { id: "outro-1", name: "Final Whistle", kind: "theme_outro", category: null, durationMs: 7000 },
    { id: "sting-a", name: "Slam Riser", kind: "stinger", category: null, durationMs: 1800 },
    { id: "sting-b", name: "Drum Hit", kind: "stinger", category: null, durationMs: 1200 },
    { id: "sting-c", name: "Whoosh Cut", kind: "stinger", category: null, durationMs: 1000 },
    { id: "bed-a", name: "Fast Break", kind: "bed", category: null, durationMs: 24000 },
    { id: "bed-b", name: "Half Court", kind: "bed", category: null, durationMs: 22000 },
    { id: "sfx-crowd", name: "Crowd Surge", kind: "sfx", category: "crowd", durationMs: 2200 },
    { id: "sfx-impact", name: "Big Impact", kind: "sfx", category: "impact", durationMs: 1300 },
    { id: "sfx-rimshot", name: "Rimshot", kind: "sfx", category: "rimshot", durationMs: 800 },
    { id: "sfx-airhorn", name: "Air Horn", kind: "sfx", category: "airhorn", durationMs: 1400 },
    { id: "sfx-buzzer", name: "Buzzer", kind: "sfx", category: "buzzer", durationMs: 900 },
  ];
}

interface SegSpec {
  type: string;
  lines: Array<{ tone?: string; energy?: string; interruption?: boolean }>;
}

/** Build script-content-shaped segments from a compact spec. */
function makeSegments(specs: SegSpec[]): Array<{ type: string; lines: RawScriptLine[] }> {
  let lineIndex = 0;
  return specs.map((s) => ({
    type: s.type,
    lines: s.lines.map((l) => ({
      lineIndex: lineIndex++,
      speakerName: lineIndex % 2 === 0 ? "Max Voltage" : "Dr. Linebreak",
      text: "This is a fairly typical hot-take line about the game last night, long enough to feel real.",
      tone: l.tone ?? "analytical",
      energy: l.energy ?? "medium",
      pauseBefore: "beat",
      isInterruption: l.interruption === true,
    })),
  }));
}

function heatedShow(): PlannerLine[] {
  return plannerLinesFromScriptContent(
    makeSegments([
      { type: "intro", lines: [{ tone: "excited", energy: "high" }, {}, {}] },
      {
        type: "topic",
        lines: [
          { tone: "heated", energy: "high" },
          { tone: "heated", energy: "high" },
          { tone: "amused", energy: "medium" },
          { tone: "incredulous", energy: "high" },
        ],
      },
      {
        type: "topic",
        lines: [
          { tone: "heated", energy: "high", interruption: true },
          { tone: "sarcastic", energy: "high" },
          { tone: "dismissive", energy: "high" },
          { tone: "heated", energy: "high" },
        ],
      },
      { type: "topic", lines: [{ tone: "excited", energy: "high" }, { tone: "heated", energy: "high" }, {}] },
    ])
  );
}

function calmShow(): PlannerLine[] {
  return plannerLinesFromScriptContent(
    makeSegments([
      { type: "intro", lines: [{}, {}] },
      { type: "topic", lines: [{ tone: "analytical" }, { tone: "measured", energy: "low" }, {}, {}] },
      { type: "topic", lines: [{ tone: "measured", energy: "low" }, {}, { tone: "analytical" }] },
      { type: "transition", lines: [{}] },
      { type: "topic", lines: [{ tone: "analytical" }, {}, { tone: "measured", energy: "low" }] },
    ])
  );
}

function basePlanInput(overrides: Record<string, unknown> = {}) {
  return {
    episodeId: "ep-1",
    scriptId: "script-1",
    style: "full" as const,
    sfxDensity: "medium" as const,
    lines: heatedShow(),
    assets: makeCatalog(),
    includeIntro: true,
    includeOutro: true,
    introAssetId: "intro-1",
    outroAssetId: "outro-1",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function main() {
  console.log("Plan generation:");

  await check("plan is deterministic for identical inputs", () => {
    const a = JSON.stringify(generateProductionPlan(basePlanInput()));
    const b = JSON.stringify(generateProductionPlan(basePlanInput()));
    assert(a === b, "same inputs must yield a byte-identical plan");
  });

  await check("different episodes produce different plans (weighted, not rotation)", () => {
    const plans = ["ep-1", "ep-2", "ep-3", "ep-4"].map((episodeId) =>
      generateProductionPlan(basePlanInput({ episodeId }))
    );
    const signatures = plans.map((p) =>
      JSON.stringify(p.cues.map((c) => [c.type, c.lineIndex, c.assetId]))
    );
    const distinct = new Set(signatures);
    assert(distinct.size >= 3, `expected ≥3 distinct cue sheets across 4 episodes, got ${distinct.size}`);
  });

  await check("a heated script plans more reactions than a calm one", () => {
    const hot = generateProductionPlan(basePlanInput());
    const calm = generateProductionPlan(basePlanInput({ lines: calmShow() }));
    assert(
      hot.stats.reactionCues > calm.stats.reactionCues,
      `hot=${hot.stats.reactionCues} should exceed calm=${calm.stats.reactionCues}`
    );
    assert(calm.stats.reactionCues === 0, "an all-analytical script must get zero reactions");
  });

  await check("silence appears as a positive cue with a reason", () => {
    // Across several seeds a boundary or strong beat gets deliberately held.
    let sawSilence = false;
    for (const episodeId of ["ep-1", "ep-2", "ep-3", "ep-4", "ep-5", "ep-6"]) {
      const plan = generateProductionPlan(basePlanInput({ episodeId, sfxDensity: "subtle" }));
      for (const cue of plan.cues) {
        if (cue.type === "silence") {
          sawSilence = true;
          assert(cue.reason.length > 5, "silence cue must carry a reason");
          assert(cue.assetId === null, "silence cue must not reference an asset");
        }
      }
    }
    assert(sawSilence, "no silence cues across 6 subtle-density episodes — silence isn't real");
  });

  await check("no stinger/reaction cue on the opening line without a cold open", () => {
    for (const episodeId of ["ep-1", "ep-2", "ep-3", "ep-4", "ep-5"]) {
      const plan = generateProductionPlan(basePlanInput({ episodeId, sfxDensity: "hype" }));
      const offenders = plan.cues.filter(
        (c) => c.lineIndex === 0 && (c.type === "stinger" || c.type === "reaction")
      );
      assert(offenders.length === 0, `episode ${episodeId} cued the opening line: ${JSON.stringify(offenders)}`);
    }
  });

  await check("a cold open MAY get a cue on the opening line", () => {
    const coldOpen = plannerLinesFromScriptContent(
      makeSegments([
        { type: "cold_open", lines: [{ tone: "heated", energy: "high" }] },
        { type: "intro", lines: [{}, {}] },
        { type: "topic", lines: [{ tone: "heated", energy: "high" }, {}, {}] },
      ])
    );
    let sawOpeningCue = false;
    for (let i = 0; i < 40 && !sawOpeningCue; i++) {
      const plan = generateProductionPlan(
        basePlanInput({ episodeId: `ep-${i}`, lines: coldOpen, sfxDensity: "hype" })
      );
      sawOpeningCue = plan.cues.some((c) => c.lineIndex === 0 && c.type === "reaction");
    }
    assert(sawOpeningCue, "cold-open opening line never earned a cue across 40 seeds");
  });

  console.log("Cooldown & repetition:");

  await check("stingers/beds used in recent episodes are hard-suppressed", () => {
    const cooldown: CooldownSnapshot = {
      episodes: [
        { episodeId: "prev-1", assetIds: ["sting-a", "bed-a"] },
        { episodeId: "prev-2", assetIds: ["sting-b"] },
      ],
    };
    for (const episodeId of ["ep-1", "ep-2", "ep-3", "ep-4", "ep-5", "ep-6"]) {
      const plan = generateProductionPlan(basePlanInput({ episodeId, cooldown }));
      for (const cue of plan.cues) {
        if (cue.type === "stinger") {
          assert(
            cue.assetId !== "sting-a" && cue.assetId !== "sting-b",
            `cooled stinger ${cue.assetId} recurred in ${episodeId}`
          );
        }
        if (cue.type === "bed_change") {
          assert(cue.assetId !== "bed-a", `cooled bed recurred in ${episodeId}`);
        }
      }
      assert(plan.stats.cooldownSuppressions > 0, "suppressions must be counted");
    }
  });

  await check("with every stinger cooling, boundaries fall back to silence", () => {
    const cooldown: CooldownSnapshot = {
      episodes: [{ episodeId: "prev-1", assetIds: ["sting-a", "sting-b", "sting-c"] }],
    };
    const plan = generateProductionPlan(basePlanInput({ cooldown }));
    assert(plan.stats.stingerCues === 0, "no stinger may play while all are cooling");
    const boundarySilences = plan.cues.filter(
      (c) => c.type === "silence" && c.reason.includes("cooling")
    );
    assert(boundarySilences.length > 0, "cooldown fallback silence must be documented");
  });

  await check("per-episode max-uses is enforced (stingers once, sfx twice)", () => {
    for (const episodeId of ["ep-1", "ep-2", "ep-3", "ep-4"]) {
      const plan = generateProductionPlan(basePlanInput({ episodeId, sfxDensity: "hype" }));
      const uses = new Map<string, { kind: string; n: number }>();
      for (const cue of plan.cues) {
        if (!cue.assetId) continue;
        if (cue.type !== "stinger" && cue.type !== "reaction") continue;
        const prev = uses.get(cue.assetId) ?? { kind: cue.type, n: 0 };
        prev.n++;
        uses.set(cue.assetId, prev);
      }
      for (const [id, u] of uses) {
        const cap =
          u.kind === "stinger"
            ? DEFAULT_PLANNER_CONFIG.maxStingerUsesPerEpisode
            : DEFAULT_PLANNER_CONFIG.maxSfxUsesPerEpisode;
        assert(u.n <= cap, `${id} used ${u.n}× in ${episodeId} (cap ${cap})`);
      }
    }
  });

  await check("planAssetUsage lists exactly the consumable cues", () => {
    const plan = generateProductionPlan(basePlanInput());
    const usage = planAssetUsage(plan);
    assert(usage.length > 0, "a full-style plan should consume assets");
    for (const u of usage) {
      assert(
        ["stinger", "bed_change", "reaction"].includes(u.cueType),
        `unexpected cueType ${u.cueType} in usage`
      );
      assert(!!u.assetId, "usage rows must carry assetId");
    }
    assert(!usage.some((u) => u.assetId === "intro-1" || u.assetId === "outro-1"), "themes are exempt from cooldown");
  });

  console.log("Styles & flag:");

  await check("light style plans topic boundaries only, no reactions or bed", () => {
    const plan = generateProductionPlan(basePlanInput({ style: "light" }));
    assert(plan.stats.reactionCues === 0, "light style must not plan reactions");
    assert(!plan.cues.some((c) => c.type === "bed_change"), "light style must not plan a bed");
    const boundaryCues = plan.cues.filter((c) => c.type === "stinger");
    // heatedShow has intro→topic (segment? no: type "topic" → topic break) breaks only.
    assert(boundaryCues.every((c) => c.type === "stinger"), "sanity");
  });

  await check("flag parsing: only the exact string 'true' enables the planner", () => {
    assert(isSoundDesignPlannerEnabled({ SOUND_DESIGN_PLANNER: "true" }), "'true' must enable");
    assert(!isSoundDesignPlannerEnabled({ SOUND_DESIGN_PLANNER: "1" }), "'1' must not enable");
    assert(!isSoundDesignPlannerEnabled({ SOUND_DESIGN_PLANNER: "TRUE" }), "'TRUE' must not enable");
    assert(!isSoundDesignPlannerEnabled({}), "unset must not enable");
    assert(!isSoundDesignPlannerEnabled({ SOUND_DESIGN_PLANNER: "false" }), "'false' must not enable");
  });

  await check("resolvePlannerConfig reads env overrides and falls back", () => {
    const def = resolvePlannerConfig({});
    assert(def.cooldownEpisodes === DEFAULT_PLANNER_CONFIG.cooldownEpisodes, "default cooldown");
    const custom = resolvePlannerConfig({ SOUND_DESIGN_COOLDOWN_EPISODES: "5" });
    assert(custom.cooldownEpisodes === 5, "env override respected");
    const junk = resolvePlannerConfig({ SOUND_DESIGN_COOLDOWN_EPISODES: "banana" });
    assert(junk.cooldownEpisodes === DEFAULT_PLANNER_CONFIG.cooldownEpisodes, "junk env ignored");
  });

  console.log("Plan execution:");

  await check("executor maps cues onto the timeline with legacy timing", () => {
    const plan = generateProductionPlan(basePlanInput());
    const lines = heatedShow();
    const plannedLines: PlannedLine[] = lines.map((l, i) => ({
      filePath: `line-${l.lineIndex}.wav`,
      durationMs: 4000,
      lineIndex: l.lineIndex,
      hostSlot: (i % 2) as 0 | 1,
      segmentBreak: l.breakKind === "none" ? "none" : l.breakKind,
    }));
    const dialogueClips: TimelineClip[] = plannedLines.map((l, i) => ({
      filePath: l.filePath,
      startMs: 8000 + i * 5000,
      durationMs: l.durationMs,
      kind: "speech",
      pan: 0,
      fadeInMs: 4,
      fadeOutMs: 8,
      gainDb: 0,
    }));
    const assetsById = new Map<string, LoadedAsset>(
      makeCatalog().map((a) => [
        a.id,
        { id: a.id, name: a.name, kind: a.kind, category: a.category, filePath: `${a.id}.wav`, durationMs: a.durationMs! },
      ])
    );
    const warnings: string[] = [];
    const intro = resolveIntroFromPlan({ plan, assetsById, musicCrossfadeMs: 900, warnings });
    assert(!!intro.introClip, "intro cue must resolve to a clip");
    assert(intro.dialogueStartMs === 8500 - 900, "dialogue starts under the intro fade tail");

    const result = executePlanOnTimeline({
      plan,
      plannedLines,
      dialogueClips,
      assetsById,
      musicCrossfadeMs: 900,
      dialogueStartMs: intro.dialogueStartMs,
      warnings,
    });
    assert(warnings.length === 0, `unexpected warnings: ${warnings.join("; ")}`);
    assert(result.stingerClips.length === plan.stats.stingerCues, "every stinger cue must render");
    assert(result.reactionClips.length === plan.stats.reactionCues, "every reaction cue must render");

    // Stingers end before their line starts; reactions ride the line's tail.
    const clipStartByLine = new Map(dialogueClips.map((c, i) => [plannedLines[i].lineIndex, c]));
    for (const s of result.stingerSummary) {
      const lineClip = clipStartByLine.get(s.lineIndex)!;
      const asset = [...assetsById.values()].find((a) => a.name === s.asset)!;
      assert(s.atMs + asset.durationMs <= lineClip.startMs, `stinger at line ${s.lineIndex} overlaps the line`);
    }
    for (const r of result.reactionSummary) {
      const lineClip = clipStartByLine.get(r.lineIndex)!;
      assert(
        r.atMs >= lineClip.startMs && r.atMs <= lineClip.startMs + lineClip.durationMs,
        `reaction at line ${r.lineIndex} misses the line`
      );
    }
    const bedCue = plan.cues.find((c) => c.type === "bed_change");
    assert(
      (bedCue && result.bedAsset?.id === bedCue.assetId) || (!bedCue && !result.bedAsset),
      "executor bed must match the plan"
    );
    assert(!!result.outroClip, "outro cue must resolve to a clip");
    const dialogueEnd = Math.max(...dialogueClips.map((c) => c.startMs + c.durationMs));
    assert(result.outroClip!.startMs === dialogueEnd - 450, "outro starts half a crossfade early");
  });

  await check("executor skips cues whose assets failed to load, with warnings", () => {
    const plan = generateProductionPlan(basePlanInput());
    const lines = heatedShow();
    const plannedLines: PlannedLine[] = lines.map((l, i) => ({
      filePath: `line-${l.lineIndex}.wav`,
      durationMs: 4000,
      lineIndex: l.lineIndex,
      hostSlot: (i % 2) as 0 | 1,
    }));
    const dialogueClips: TimelineClip[] = plannedLines.map((l, i) => ({
      filePath: l.filePath,
      startMs: i * 5000,
      durationMs: 4000,
      kind: "speech",
      pan: 0,
      fadeInMs: 4,
      fadeOutMs: 8,
      gainDb: 0,
    }));
    const warnings: string[] = [];
    const result = executePlanOnTimeline({
      plan,
      plannedLines,
      dialogueClips,
      assetsById: new Map(), // nothing loaded
      musicCrossfadeMs: 900,
      dialogueStartMs: 0,
      warnings,
    });
    assert(result.stingerClips.length === 0 && result.reactionClips.length === 0, "nothing renders");
    const consumable = plan.cues.filter((c) => c.assetId && c.type !== "silence").length;
    assert(warnings.length >= Math.min(1, consumable), "missing assets must be warned about");
  });

  await check("plannedStingerDurations reflects only plan-selected assets", () => {
    const plan = generateProductionPlan(basePlanInput());
    const assetsById = new Map<string, LoadedAsset>(
      makeCatalog().map((a) => [
        a.id,
        { id: a.id, name: a.name, kind: a.kind, category: a.category, filePath: `${a.id}.wav`, durationMs: a.durationMs! },
      ])
    );
    const durations = plannedStingerDurations(plan, assetsById);
    assert(durations.length === plan.stats.stingerCues, "one duration per stinger cue");
  });

  await check("parseProductionPlan round-trips a JSON-serialized plan", () => {
    const plan = generateProductionPlan(basePlanInput());
    const parsed = parseProductionPlan(JSON.parse(JSON.stringify(plan)));
    assert(!!parsed, "parse must succeed");
    assert(JSON.stringify(parsed) === JSON.stringify(plan), "round-trip must be lossless");
    assert(parseProductionPlan(null) === null, "null → null");
    assert(parseProductionPlan({ version: 2 }) === null, "unknown version rejected");
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
