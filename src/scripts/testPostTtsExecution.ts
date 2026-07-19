// Post-TTS execution (clip generation + Part-15 validation) tests (PR 3, pure).
// Run: npm run test:post-tts-execution

import { directPostTtsSound, resolveIntroDialogueStartMs, type PostTtsDirectorInput, type DirectorScriptLine } from "../lib/audio/postTtsSoundDirector";
import { executeDirectedPlan, type LoadedAssetLite } from "../lib/audio/postTtsExecution";
import { buildActualDialogueTimeline, type ActualTimelineLineInput } from "../lib/audio/dialogueTimeline";
import { resolveWaveformConfig } from "../lib/audio/waveformAnalysis";
import type { FrozenSoundProfile, FrozenSoundAssetRef } from "../lib/services/podcastSoundProfile";
import { DEFAULT_SONIC_IDENTITY } from "../lib/audio/sonicIdentity";

let passed = 0, failed = 0;
function check(name: string, fn: () => void) { try { fn(); passed++; console.log(`  ✓ ${name}`); } catch (err) { failed++; console.error(`  ✗ ${name}\n      ${(err as Error).message}`); } }
function assert(c: boolean, m: string) { if (!c) throw new Error(m); }
const wcfg = resolveWaveformConfig();

const ref = (id: string, role: FrozenSoundAssetRef["role"], over: Partial<FrozenSoundAssetRef> = {}): FrozenSoundAssetRef => ({
  assetId: id, kind: role === "intro" ? "theme_intro" : role === "outro" ? "theme_outro" : role === "bed" ? "bed" : role === "stinger" ? "stinger" : "sfx",
  category: null, name: id, contentHash: `h${id}`, scope: "shared_system", role, orderIndex: 0, gainDb: null, fadeInMs: null, fadeOutMs: null,
  durationMs: 4000, tags: [], rightsStatusAtCapture: "not_required", licenseStatusAtCapture: "licensed", provenance: "system_default", weight: 1, cueFamily: null, ...over,
});
const profile = (over: Partial<FrozenSoundProfile> = {}): FrozenSoundProfile => ({
  mode: "custom", targetLoudnessLufs: null, cooldownScope: "podcast", stingerCooldownEpisodes: null, reactionCooldownEpisodes: null,
  introEnabled: true, outroEnabled: true, intro: ref("intro-1", "intro"), outro: ref("outro-1", "outro"), bed: ref("bed-1", "bed"),
  stingers: [ref("st-topic", "stinger", { cueFamily: "topic_reset" })], reactions: [ref("rx-agree", "reaction", { cueFamily: "agreement" })],
  introVariants: [], outroVariants: [], beds: [], sonicIdentity: DEFAULT_SONIC_IDENTITY, containsLegacyCompatAssets: false, excluded: [], ...over,
});
// The real stitcher offsets the dialogue by the intro treatment's speech-entry
// BEFORE building the timeline, so the intro never overlaps the opening words.
// Mirror that here (full_before on a 4000ms asset -> ~4250ms offset).
const DIALOGUE_OFFSET = resolveIntroDialogueStartMs(profile(), "two_host_debate", true, 4000);
function timeline(off: number = DIALOGUE_OFFSET) {
  const L = (i: number, start: number, dur: number, boundary: "inline" | "segment" | "topic"): ActualTimelineLineInput => ({
    lineIndex: i, hostId: `h${i % 2}`, seatIndex: i % 2, fileDurationMs: dur, timelineStartMs: off + start, timelineEndMs: off + start + dur, leadSilenceMs: 0, trailSilenceMs: 0, isInterruption: false, segmentBoundary: boundary, timingSource: "ffprobe_waveform",
  });
  return buildActualDialogueTimeline([L(0, 0, 2000, "inline"), L(1, 4000, 2000, "topic"), L(2, 6800, 2000, "inline"), L(3, 11000, 2000, "inline")], wcfg);
}
const scriptLines: DirectorScriptLine[] = [
  { lineIndex: 0, text: "welcome in", tone: "neutral" }, { lineIndex: 1, text: "new topic", tone: "analytical" },
  { lineIndex: 2, text: "wow wild", tone: "amused" }, { lineIndex: 3, text: "bye now", tone: "neutral" },
];
const input = (over: Partial<PostTtsDirectorInput> = {}): PostTtsDirectorInput => ({
  episodeId: "e", scriptId: "s", seed: "seed", formatId: "two_host_debate", frozenProfile: profile(), timeline: timeline(), scriptLines,
  introAssetDurationMs: 4000, outroAssetDurationMs: 4000, includeIntro: true, includeOutro: true, protectedSpeechPaddingMs: 150, ...over,
});
const frozenIds = new Set(["intro-1", "outro-1", "bed-1", "st-topic", "rx-agree"]);
const loadedMap = (durs: Record<string, number> = {}): Map<string, LoadedAssetLite> => {
  const base: Record<string, number> = { "intro-1": 4000, "outro-1": 4000, "bed-1": 30000, "st-topic": 1000, "rx-agree": 800 };
  const m = new Map<string, LoadedAssetLite>();
  for (const [id, d] of Object.entries({ ...base, ...durs })) m.set(id, { assetId: id, filePath: `/tmp/${id}.wav`, durationMs: d });
  return m;
};

function main() {
  console.log("\nPost-TTS execution + validation\n");

  check("produces intro/outro/cue clips from the directed plan; validation passes", () => {
    const plan = directPostTtsSound(input());
    const ex = executeDirectedPlan(plan, loadedMap(), { frozenAssetIds: frozenIds, protectedRegions: plan.protectedRegions });
    assert(ex.validation.ok, `validation: ${ex.validation.errors.join("; ")}`);
    assert(ex.introClips.length >= 1 && ex.introClips.every((c) => c.assetId === "intro-1"), "intro clip(s)");
    assert(ex.outroClips.length >= 1 && ex.outroClips.every((c) => c.assetId === "outro-1"), "outro clip(s)");
    assert(ex.cueClips.length >= 1 && ex.cueClips.every((c) => frozenIds.has(c.assetId)), "cue clips from frozen pool");
    assert(!!ex.bed && ex.bed.duckedGainDb < ex.bed.baseGainDb, "bed ducks under speech");
    assert(ex.dialogueStartMs > 0, "dialogue enters after the intro treatment");
  });

  check("cue fitting: a too-long cue is excerpted with fades (never abrupt)", () => {
    const plan = directPostTtsSound(input());
    const ex = executeDirectedPlan(plan, loadedMap({ "st-topic": 9000 }), { frozenAssetIds: frozenIds, protectedRegions: plan.protectedRegions });
    const trans = ex.cueClips.find((c) => c.assetId === "st-topic");
    assert(!!trans && trans.fitStrategy === "faded_excerpt" && trans.fadeInMs > 0 && trans.fadeOutMs > 0, `excerpted+faded (${trans?.fitStrategy})`);
    assert(trans!.sourceEndMs < 9000 && trans!.durationMs < 9000 && trans!.durationMs === trans!.sourceEndMs, "excerpt shorter than source, fits the window");
  });

  check("an asset OUTSIDE the frozen profile is a hard validation failure", () => {
    const plan = directPostTtsSound(input());
    // frozen set missing the intro id
    const ex = executeDirectedPlan(plan, loadedMap(), { frozenAssetIds: new Set(["outro-1", "bed-1", "st-topic", "rx-agree"]), protectedRegions: plan.protectedRegions });
    assert(!ex.validation.ok && ex.validation.errors.some((e) => /not in the frozen profile/.test(e)), `frozen check: ${ex.validation.errors.join("; ")}`);
  });

  check("a required bookend with no loaded asset fails validation (not silently dropped)", () => {
    const plan = directPostTtsSound(input());
    const partial = loadedMap(); partial.delete("outro-1");
    const ex = executeDirectedPlan(plan, partial, { frozenAssetIds: frozenIds, protectedRegions: plan.protectedRegions });
    assert(!ex.validation.ok && ex.validation.errors.some((e) => /outro/.test(e)), `required outro: ${ex.validation.errors.join("; ")}`);
  });

  check("a cue with no loaded asset is skipped with a reason (bookends stay hard)", () => {
    const plan = directPostTtsSound(input());
    const partial = loadedMap(); partial.delete("st-topic");
    const ex = executeDirectedPlan(plan, partial, { frozenAssetIds: frozenIds, protectedRegions: plan.protectedRegions });
    assert(ex.skippedCues.some((s) => s.assetId === "st-topic" && /not loaded/.test(s.reason)), "cue skipped with reason");
    assert(ex.validation.ok, "a missing OPTIONAL cue does not fail the render");
  });

  check("all clip bounds/gains/fades are validated in-range", () => {
    const plan = directPostTtsSound(input());
    const ex = executeDirectedPlan(plan, loadedMap(), { frozenAssetIds: frozenIds, protectedRegions: plan.protectedRegions });
    const all = [...ex.introClips, ...ex.outroClips, ...ex.cueClips];
    assert(all.every((c) => c.startMs >= 0 && c.durationMs > 0 && c.gainDb >= -24 && c.gainDb <= 6 && c.fadeInMs >= 0 && c.fadeOutMs >= 0), "all clips in bounds");
  });

  check("clean profile executes to no clips and passes validation", () => {
    const plan = directPostTtsSound(input({ frozenProfile: profile({ mode: "clean", intro: null, outro: null, bed: null, stingers: [], reactions: [] }) }));
    const ex = executeDirectedPlan(plan, loadedMap(), { frozenAssetIds: frozenIds, protectedRegions: plan.protectedRegions });
    assert(ex.validation.ok && ex.introClips.length === 0 && ex.outroClips.length === 0 && ex.cueClips.length === 0 && !ex.bed, "clean = no clips, valid");
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}
main();
