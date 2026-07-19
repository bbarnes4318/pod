// Post-TTS sound director tests (PR 3, pure). Run: npm run test:post-tts-director

import { directPostTtsSound, type PostTtsDirectorInput, type DirectorScriptLine } from "../lib/audio/postTtsSoundDirector";
import { buildActualDialogueTimeline, type ActualTimelineLineInput } from "../lib/audio/dialogueTimeline";
import { resolveWaveformConfig } from "../lib/audio/waveformAnalysis";
import type { FrozenSoundProfile, FrozenSoundAssetRef } from "../lib/services/podcastSoundProfile";
import { DEFAULT_SONIC_IDENTITY } from "../lib/audio/sonicIdentity";

let passed = 0, failed = 0;
function check(name: string, fn: () => void) { try { fn(); passed++; console.log(`  ✓ ${name}`); } catch (err) { failed++; console.error(`  ✗ ${name}\n      ${(err as Error).message}`); } }
function assert(c: boolean, m: string) { if (!c) throw new Error(m); }
const cfg = resolveWaveformConfig();

const ref = (id: string, role: FrozenSoundAssetRef["role"], over: Partial<FrozenSoundAssetRef> = {}): FrozenSoundAssetRef => ({
  assetId: id, kind: role === "intro" ? "theme_intro" : role === "outro" ? "theme_outro" : role === "bed" ? "bed" : role === "stinger" ? "stinger" : "sfx",
  category: null, name: id, contentHash: `h${id}`, scope: "shared_system", role, orderIndex: 0,
  gainDb: null, fadeInMs: null, fadeOutMs: null, durationMs: 4000, tags: [], rightsStatusAtCapture: "not_required", licenseStatusAtCapture: "licensed", provenance: "system_default", weight: 1, cueFamily: null,
  ...over,
});
const profile = (over: Partial<FrozenSoundProfile> = {}): FrozenSoundProfile => ({
  mode: "custom", targetLoudnessLufs: null, cooldownScope: "podcast", stingerCooldownEpisodes: null, reactionCooldownEpisodes: null,
  introEnabled: true, outroEnabled: true,
  intro: ref("intro-1", "intro"), outro: ref("outro-1", "outro"), bed: ref("bed-1", "bed"),
  stingers: [ref("st-topic", "stinger", { cueFamily: "topic_reset" }), ref("st-hard", "stinger", { cueFamily: "hard_hit" })],
  reactions: [ref("rx-agree", "reaction", { cueFamily: "agreement" }), ref("rx-crowd", "reaction", { cueFamily: "crowd_positive" })],
  introVariants: [], outroVariants: [], beds: [], sonicIdentity: DEFAULT_SONIC_IDENTITY, containsLegacyCompatAssets: false, excluded: [],
  ...over,
});

// A timeline: line0 (open) | topic boundary gap before line1 | line2 amused w/ reaction gap | line3 (close)
function timeline() {
  const L = (i: number, start: number, dur: number, boundary: "inline" | "segment" | "topic", over: Partial<ActualTimelineLineInput> = {}): ActualTimelineLineInput => ({
    lineIndex: i, hostId: `h${i % 2}`, seatIndex: i % 2, fileDurationMs: dur, timelineStartMs: start, timelineEndMs: start + dur,
    leadSilenceMs: 0, trailSilenceMs: 0, isInterruption: false, segmentBoundary: boundary, timingSource: "ffprobe_waveform", ...over,
  });
  return buildActualDialogueTimeline([
    L(0, 0, 2000, "inline"),
    L(1, 4000, 2000, "topic"),     // 2000ms topic gap before line1 -> topic_gap
    L(2, 6800, 2000, "inline"),    // 800ms gap before line2 -> reaction_ok
    L(3, 11000, 2000, "inline"),   // 2200ms gap
  ], cfg);
}
const scriptLines: DirectorScriptLine[] = [
  { lineIndex: 0, text: "welcome in", tone: "neutral" },
  { lineIndex: 1, text: "new topic now", tone: "analytical" },
  { lineIndex: 2, text: "wow that is wild", tone: "amused" },
  { lineIndex: 3, text: "see you next time", tone: "neutral" },
];

const baseInput = (over: Partial<PostTtsDirectorInput> = {}): PostTtsDirectorInput => ({
  episodeId: "ep1", scriptId: "sc1", seed: "seed-1", formatId: "two_host_debate",
  frozenProfile: profile(), timeline: timeline(), scriptLines,
  introAssetDurationMs: 4000, outroAssetDurationMs: 4000, includeIntro: true, includeOutro: true, protectedSpeechPaddingMs: 150, ...over,
});

function main() {
  console.log("\nPost-TTS sound director\n");

  check("deterministic: same inputs -> same plan + fingerprint", () => {
    const a = directPostTtsSound(baseInput());
    const b = directPostTtsSound(baseInput());
    assert(a.fingerprint === b.fingerprint && JSON.stringify(a) === JSON.stringify(b), "deterministic");
    assert(a.mode === "post_tts" && a.directorVersion === 2 && !!a.fingerprint, "typed versioned plan");
  });

  check("a different seed may alter an equivalent cue selection", () => {
    const seeds = new Set<string>();
    for (const s of ["s1", "s2", "s3", "s4", "s5"]) seeds.add(JSON.stringify(directPostTtsSound(baseInput({ seed: s })).cuePlacements.map((c) => c.assetId)));
    assert(seeds.size >= 2, `seed variety (${seeds.size})`);
  });

  check("transition placed only at a structural boundary with a transition-sized gap", () => {
    const p = directPostTtsSound(baseInput());
    const trans = p.cuePlacements.filter((c) => c.kind === "transition");
    assert(trans.length === 1 && trans[0].lineIndex === 1, `one transition at topic boundary (${trans.length})`);
    // only frozen-pool assets appear
    assert(p.cuePlacements.every((c) => ["st-topic", "st-hard", "rx-agree", "rx-crowd"].includes(c.assetId)), "only frozen pool assets used");
  });

  check("reaction requires a tone trigger + reaction gap; not on every line", () => {
    const p = directPostTtsSound(baseInput());
    const rx = p.cuePlacements.filter((c) => c.kind === "reaction");
    assert(rx.length === 1 && rx[0].lineIndex === 2, `reaction only on the amused line (${rx.length})`);
  });

  check("family prohibited by identity is never selected (crowd disabled)", () => {
    const noCrowd = profile({ sonicIdentity: { ...DEFAULT_SONIC_IDENTITY, crowdEffectsAllowed: false } });
    const p = directPostTtsSound(baseInput({ frozenProfile: noCrowd }));
    assert(p.cuePlacements.every((c) => c.assetId !== "rx-crowd"), "crowd reaction excluded by identity");
  });

  check("intro treatment chosen; a too-short asset falls back to another TREATMENT (not another asset)", () => {
    const p = directPostTtsSound(baseInput({ formatId: "sports_radio", introAssetDurationMs: 4000 }));
    assert(p.bookendPlan.intro?.treatment === "cold_open_ducked" && p.bookendPlan.intro.continuesUnderSpeech, "sports cold-open ducked");
    const shortIntro = directPostTtsSound(baseInput({ formatId: "sports_radio", introAssetDurationMs: 500 }));
    assert(shortIntro.bookendPlan.intro?.assetId === "intro-1" && shortIntro.bookendPlan.intro.treatment !== "cold_open_ducked", "short asset -> different treatment, same asset");
  });

  check("required intro/outro with no usable asset -> structured failure", () => {
    const noIntro = directPostTtsSound(baseInput({ frozenProfile: profile({ intro: null }) }));
    assert(noIntro.failure === "required_intro_no_safe_treatment", `intro failure (${noIntro.failure})`);
    const noOutro = directPostTtsSound(baseInput({ frozenProfile: profile({ outro: null }) }));
    assert(noOutro.failure === "required_outro_no_safe_treatment", `outro failure (${noOutro.failure})`);
  });

  check("outro treatment respects the format; unresolved final overlap -> clean close", () => {
    const doc = directPostTtsSound(baseInput({ formatId: "documentary" }));
    assert(doc.bookendPlan.outro?.treatment === "reflective_gap_then_outro", "documentary reflective outro");
    // final line interrupted -> even a rise-under format falls back to a clean close
    const interrupted = timeline();
    interrupted.lines[interrupted.lines.length - 1].isInterruption = true;
    interrupted.lines[interrupted.lines.length - 1].appliedOverlapMs = 300;
    const sports = directPostTtsSound(baseInput({ formatId: "sports_radio", timeline: interrupted }));
    assert((sports.bookendPlan.outro?.outroStartMs ?? 0) >= interrupted.speechEndMs, "outro not during unresolved overlap");
  });

  check("bed plan follows policy: none (rapid) / identity none / intro_outro / full", () => {
    assert(directPostTtsSound(baseInput({ formatId: "rapid_fire" })).bedPlan === null, "rapid-fire: no bed (format)");
    assert(directPostTtsSound(baseInput({ frozenProfile: profile({ sonicIdentity: { ...DEFAULT_SONIC_IDENTITY, bedPolicy: "none" } }) })).bedPlan === null, "identity none: no bed");
    const io = directPostTtsSound(baseInput({ frozenProfile: profile({ sonicIdentity: { ...DEFAULT_SONIC_IDENTITY, bedPolicy: "intro_outro_only" } }) }));
    assert(io.bedPlan?.policy === "intro_outro_only" && io.bedPlan.segments.length === 2, "intro/outro bed = 2 segments");
    const full = directPostTtsSound(baseInput({ frozenProfile: profile({ sonicIdentity: { ...DEFAULT_SONIC_IDENTITY, bedPolicy: "full_episode" } }) }));
    assert(full.bedPlan?.policy === "full_episode" && full.bedPlan.segments.length === 1 && full.bedPlan.duckedGainDb < full.bedPlan.baseGainDb, "full bed ducks under speech");
  });

  check("different formats produce meaningfully different cue structures", () => {
    const debate = directPostTtsSound(baseInput({ formatId: "two_host_debate" }));
    const solo = directPostTtsSound(baseInput({ formatId: "solo_commentary" }));
    const rapid = directPostTtsSound(baseInput({ formatId: "rapid_fire" }));
    // solo has minimal reactions (ceiling 1) + no bed via 'none'? solo bed depends on identity; compare intro styles + reaction counts
    assert(debate.bookendPlan.intro?.treatment !== solo.bookendPlan.intro?.treatment || debate.cuePlacements.length !== solo.cuePlacements.length, "debate != solo");
    assert(rapid.bedPlan === null && debate.bedPlan !== null, "rapid no bed, debate has bed");
  });

  check("clean profile yields no bookends, cues, or bed", () => {
    const clean = directPostTtsSound(baseInput({ frozenProfile: profile({ mode: "clean", intro: null, outro: null, bed: null, stingers: [], reactions: [] }) }));
    assert(!clean.bookendPlan.intro && !clean.bookendPlan.outro && clean.bedPlan === null && clean.cuePlacements.length === 0, "clean = silent direction");
    assert(clean.failure === null, "clean has no required-bookend failure");
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}
main();
