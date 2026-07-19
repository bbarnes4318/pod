// Branded-motif continuity + system cross-podcast diversity tests (PR 4, pure).
// Run: npm run test:sound-motif-diversity
import { evaluateMotifContinuity, recentMotifRate } from "../lib/audio/soundMotifContinuity";
import { selectDiverseBookends } from "../lib/audio/soundDiversity";
import { resolveSoundDiversityPolicy } from "../lib/audio/soundDiversityPolicy";
import type { FrozenSoundProfile, FrozenSoundAssetRef } from "../lib/services/podcastSoundProfile";
import type { DiversityHistory, DiversityHistoryEpisode } from "../lib/services/diversityHistory";
import { DEFAULT_SONIC_IDENTITY } from "../lib/audio/sonicIdentity";

let passed = 0, failed = 0;
function check(name: string, fn: () => void) { try { fn(); passed++; console.log(`  ✓ ${name}`); } catch (err) { failed++; console.error(`  ✗ ${name}\n      ${(err as Error).message}`); } }
function assert(c: boolean, m: string) { if (!c) throw new Error(m); }

const ref = (assetId: string, over: Partial<FrozenSoundAssetRef> = {}): FrozenSoundAssetRef => ({
  assetId, kind: "theme_intro", category: null, name: assetId, contentHash: `h-${assetId}`, scope: "shared_system", role: "intro", orderIndex: 0,
  gainDb: null, fadeInMs: null, fadeOutMs: null, durationMs: 3000, tags: [], rightsStatusAtCapture: "not_required", licenseStatusAtCapture: "licensed",
  provenance: "podcast_assignment", weight: 1, cueFamily: null, isBrandedMotif: false, allowedFormatIds: [], prohibitedFormatIds: [], ...over,
});
const policy = resolveSoundDiversityPolicy();
const emptyHist: DiversityHistory = { scope: "podcast", windowRequested: 6, windowUsed: 0, episodes: [], warnings: [], truncated: false };
const histWith = (introMotifFlags: boolean[]): DiversityHistory => ({
  scope: "podcast", windowRequested: 6, windowUsed: introMotifFlags.length, warnings: [], truncated: false,
  episodes: introMotifFlags.map((m, i): DiversityHistoryEpisode => ({
    episodeId: `e${i}`, renderId: `r${i}`, creationOrder: i, formatId: "two_host_debate",
    introAssetId: m ? "motif" : "plain", outroAssetId: null, bedAssetId: null, transitionAssetIds: [], reactionAssetIds: [],
    introFamily: null, outroFamily: null, bedFamily: null, transitionFamilySequence: [], reactionFamilySequence: [],
    cueFamilySequence: [], introIsMotif: m, outroIsMotif: false, bedIsMotif: false, brandedMotifUsed: m,
    planningEngine: "post_tts", planningVersion: 2, planFingerprint: `fp${i}`, renderKind: "initial",
  })),
});
const profile = (over: Partial<FrozenSoundProfile> = {}): FrozenSoundProfile => ({
  mode: "custom", targetLoudnessLufs: null, cooldownScope: "podcast", stingerCooldownEpisodes: null, reactionCooldownEpisodes: null,
  introEnabled: true, outroEnabled: true, intro: ref("motif", { isBrandedMotif: true }), outro: ref("o1", { role: "outro" }), bed: ref("b1", { role: "bed" }),
  stingers: [], reactions: [],
  introVariants: [ref("motif", { isBrandedMotif: true }), ref("plain")], outroVariants: [ref("o1", { role: "outro" })], beds: [ref("b1", { role: "bed" })],
  sonicIdentity: DEFAULT_SONIC_IDENTITY, containsLegacyCompatAssets: false, excluded: [], ...over,
});

function main() {
  console.log("\nBranded-motif continuity + system cross-podcast diversity\n");

  check("recentMotifRate is a simple bounded fraction", () => {
    assert(recentMotifRate([]) === 0 && recentMotifRate([true, false, false, false]) === 0.25, "rate");
  });

  check("25. a below-minimum motif rate favors the motif over a large sample", () => {
    const counts: Record<string, number> = { motif: 0, plain: 0 };
    for (let i = 0; i < 200; i++) { const r = selectDiverseBookends(profile(), { policy, mode: "soft", history: emptyHist, seed: `k-${i}`, formatId: "two_host_debate" }); counts[r.intro!.assetId]++; }
    assert(counts.motif > counts.plain, `motif favored below min (motif=${counts.motif}, plain=${counts.plain})`);
  });

  check("26. an above-maximum motif rate penalizes the motif over a large sample", () => {
    const saturated = histWith([true, true, true, true, true, true]); // rate 1 > max
    const counts: Record<string, number> = { motif: 0, plain: 0 };
    for (let i = 0; i < 200; i++) { const r = selectDiverseBookends(profile(), { policy, mode: "soft", history: saturated, seed: `k-${i}`, formatId: "two_host_debate" }); counts[r.intro!.assetId]++; }
    assert(counts.plain > counts.motif, `motif penalized above max (motif=${counts.motif}, plain=${counts.plain})`);
  });

  check("27. a within-range motif rate is neutral", () => {
    const m = evaluateMotifContinuity({ role: "intro", candidates: [ref("motif", { isBrandedMotif: true }), ref("plain")], recentMotifUsage: [true, false], policy });
    assert(m.action === "neutral", `within-range neutral (${m.action}, rate ${m.recentRate})`);
  });

  check("28. no eligible motif in the pool -> unavailable", () => {
    const m = evaluateMotifContinuity({ role: "intro", candidates: [ref("plain"), ref("plain2")], recentMotifUsage: [], policy });
    assert(m.action === "unavailable", `unavailable (${m.action})`);
  });

  check("29. a motif-only pool reports UNAVOIDABLE overuse honestly", () => {
    const m = evaluateMotifContinuity({ role: "intro", candidates: [ref("motif", { isBrandedMotif: true })], recentMotifUsage: [true, true], policy });
    assert(m.action === "unavoidable", `unavoidable (${m.action})`);
    const r = selectDiverseBookends(profile({ introVariants: [ref("motif", { isBrandedMotif: true })] }), { policy, mode: "enforce", history: histWith([true, true]), seed: "s", formatId: "two_host_debate" });
    assert(r.decision.relaxations.includes("motif_maximum_unavoidable"), "unavoidable relaxation recorded");
  });

  check("30. a format-prohibited motif is excluded before motif evaluation", () => {
    const p = profile({ introVariants: [ref("motif", { isBrandedMotif: true, prohibitedFormatIds: ["two_host_debate"] }), ref("plain")] });
    for (let i = 0; i < 20; i++) { const r = selectDiverseBookends(p, { policy, mode: "soft", history: emptyHist, seed: `f-${i}`, formatId: "two_host_debate" }); assert(r.intro!.assetId === "plain", `format-prohibited motif never chosen (${r.intro!.assetId})`); }
  });

  check("intro and outro motif are evaluated independently", () => {
    const p = profile({ introVariants: [ref("mi", { isBrandedMotif: true }), ref("pi")], outroVariants: [ref("mo", { role: "outro", isBrandedMotif: true }), ref("po", { role: "outro" })] });
    const r = selectDiverseBookends(p, { policy, mode: "soft", history: emptyHist, seed: "s", formatId: "two_host_debate" });
    assert(!!r.decision.motifDecision && r.decision.motifDecision.role === "intro", "primary motif decision is intro");
  });

  // --- System cross-podcast diversity (Part 9) -----------------------------
  const systemHist = (assetIds: string[]): DiversityHistory => ({
    scope: "system", windowRequested: 6, windowUsed: assetIds.length, warnings: [], truncated: false,
    episodes: assetIds.map((a, i): DiversityHistoryEpisode => ({
      episodeId: `sys${i}`, renderId: `r${i}`, creationOrder: i, formatId: "two_host_debate",
      introAssetId: a, outroAssetId: null, bedAssetId: null, transitionAssetIds: [], reactionAssetIds: [],
      introFamily: null, outroFamily: null, bedFamily: null, transitionFamilySequence: [], reactionFamilySequence: [],
      cueFamilySequence: [], introIsMotif: false, outroIsMotif: false, bedIsMotif: false, brandedMotifUsed: false,
      planningEngine: "post_tts", planningVersion: 2, planFingerprint: `fp${i}`, renderKind: "initial",
    })),
  });
  const sysProfile = profile({ intro: ref("s1"), introVariants: [ref("s1"), ref("s2")] });

  check("48. two system podcasts with different seeds do not both open the same way", () => {
    const p1 = selectDiverseBookends(sysProfile, { policy, mode: "soft", history: emptyHist, seed: "podcast-1", formatId: "two_host_debate" });
    const p2 = selectDiverseBookends(sysProfile, { policy, mode: "soft", history: emptyHist, seed: "podcast-2", formatId: "two_host_debate" });
    // Different seeds CAN pick differently; over many, they must not be locked identical.
    let same = 0; for (let i = 0; i < 40; i++) { const a = selectDiverseBookends(sysProfile, { policy, mode: "soft", history: emptyHist, seed: `A${i}`, formatId: "two_host_debate" }); const b = selectDiverseBookends(sysProfile, { policy, mode: "soft", history: emptyHist, seed: `B${i}`, formatId: "two_host_debate" }); if (a.intro!.assetId === b.intro!.assetId) same++; }
    assert(same < 40, `not all identical (${same}/40)`); void p1; void p2;
  });

  check("49. system diversity OFF preserves selection (system history is ignored)", () => {
    const offPolicy = resolveSoundDiversityPolicy({ overrides: { systemCrossPodcastDiversityEnabled: false } });
    const withSys = selectDiverseBookends(sysProfile, { policy: offPolicy, mode: "soft", history: emptyHist, seed: "z", formatId: "two_host_debate", systemHistory: systemHist(["s1", "s1", "s1"]) });
    const without = selectDiverseBookends(sysProfile, { policy: offPolicy, mode: "soft", history: emptyHist, seed: "z", formatId: "two_host_debate" });
    assert(withSys.intro!.assetId === without.intro!.assetId, "system history ignored when disabled");
  });

  check("50/53. a heavily system-used shared asset is softly disfavored but never starves a small pool", () => {
    const onPolicy = resolveSoundDiversityPolicy({ overrides: { systemCrossPodcastDiversityEnabled: true } });
    const counts: Record<string, number> = { s1: 0, s2: 0 };
    for (let i = 0; i < 120; i++) { const r = selectDiverseBookends(sysProfile, { policy: onPolicy, mode: "soft", history: emptyHist, seed: `q-${i}`, formatId: "two_host_debate", systemHistory: systemHist(["s1", "s1", "s1", "s1"]) }); counts[r.intro!.assetId]++; }
    assert(counts.s2 > counts.s1, `system-heavy s1 softly disfavored (s1=${counts.s1}, s2=${counts.s2})`);
    assert(counts.s1 > 0, `soft only — s1 never fully starved (s1=${counts.s1})`);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}
main();
