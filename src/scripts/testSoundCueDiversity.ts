// Within-episode cue diversity + cue-sequence similarity tests (PR 4, pure).
// Run: npm run test:sound-cue-diversity
import { selectDiverseCue, recordCuePlacement, newWithinEpisodeCueState, type CrossEpisodeCueHistory } from "../lib/audio/soundCueDiversity";
import { tokenizeCueSequence, sequenceSimilarity, maxSimilarityToHistory, evaluateSequenceSimilarity } from "../lib/audio/soundSequenceSimilarity";
import { resolveSoundDiversityPolicy } from "../lib/audio/soundDiversityPolicy";
import type { FrozenSoundAssetRef } from "../lib/services/podcastSoundProfile";

let passed = 0, failed = 0;
function check(name: string, fn: () => void) { try { fn(); passed++; console.log(`  ✓ ${name}`); } catch (err) { failed++; console.error(`  ✗ ${name}\n      ${(err as Error).message}`); } }
function assert(c: boolean, m: string) { if (!c) throw new Error(m); }

const cue = (assetId: string, family: string, over: Partial<FrozenSoundAssetRef> = {}): FrozenSoundAssetRef => ({
  assetId, kind: "stinger", category: null, name: assetId, contentHash: `h-${assetId}`, scope: "shared_system", role: "stinger", orderIndex: 0,
  gainDb: null, fadeInMs: null, fadeOutMs: null, durationMs: 1000, tags: [], rightsStatusAtCapture: "not_required", licenseStatusAtCapture: "licensed",
  provenance: "podcast_assignment", weight: 1, cueFamily: family, isBrandedMotif: false, allowedFormatIds: [], prohibitedFormatIds: [], maxUsesPerEpisode: null, minEpisodeCooldown: null, ...over,
});
const noHist: CrossEpisodeCueHistory = { recentAssetIds: [], recentFamilies: [] };
const policy = resolveSoundDiversityPolicy();

function main() {
  console.log("\nWithin-episode cue diversity + sequence similarity\n");

  // --- Within-episode cue diversity ---------------------------------------
  check("31/32. a repeated cue asset is avoided when an alternative exists", () => {
    const within = newWithinEpisodeCueState();
    const first = selectDiverseCue({ role: "transition", lineIndex: 1, candidates: [cue("X", "topic_reset"), cue("Y", "quick_sweep")], policy, mode: "soft", seed: "s", within, history: noHist });
    recordCuePlacement(within, first.selected!.assetId, first.selected!.cueFamily ?? null);
    const second = selectDiverseCue({ role: "transition", lineIndex: 2, candidates: [cue("X", "topic_reset"), cue("Y", "quick_sweep")], policy, mode: "soft", seed: "s", within, history: noHist });
    assert(second.selected!.assetId !== first.selected!.assetId, `alternated (${first.selected!.assetId} -> ${second.selected!.assetId})`);
  });

  check("33. the within-episode FAMILY cap excludes further cues of that family", () => {
    const within = newWithinEpisodeCueState();
    // Fill the family cap with distinct assets of the same family.
    for (let i = 0; i < policy.withinEpisodeFamilyCap; i++) recordCuePlacement(within, `A${i}`, "topic_reset");
    const r = selectDiverseCue({ role: "transition", lineIndex: 9, candidates: [cue("Znew", "topic_reset"), cue("Zother", "quick_sweep")], policy, mode: "enforce", seed: "s", within, history: noHist });
    assert(r.selected?.cueFamily === "quick_sweep", `family-capped family avoided (${r.selected?.cueFamily})`);
  });

  check("34. the within-episode ASSET cap excludes an over-used asset", () => {
    const within = newWithinEpisodeCueState();
    for (let i = 0; i < policy.withinEpisodeAssetCap; i++) recordCuePlacement(within, "X", "fam_a");
    const r = selectDiverseCue({ role: "transition", lineIndex: 5, candidates: [cue("X", "fam_a"), cue("Y", "fam_b")], policy, mode: "enforce", seed: "s", within, history: noHist });
    assert(r.selected?.assetId === "Y", `asset-capped X avoided (${r.selected?.assetId})`);
  });

  check("35. an assignment maxUsesPerEpisode is enforced", () => {
    const within = newWithinEpisodeCueState();
    recordCuePlacement(within, "X", "fam_a"); // used once
    const r = selectDiverseCue({ role: "transition", lineIndex: 5, candidates: [cue("X", "fam_a", { maxUsesPerEpisode: 1 }), cue("Y", "fam_b")], policy, mode: "soft", seed: "s", within, history: noHist });
    assert(r.selected?.assetId === "Y", `maxUsesPerEpisode-capped X avoided (${r.selected?.assetId})`);
  });

  check("37. only assets from the given (already-permitted) pool are ever chosen", () => {
    for (let i = 0; i < 20; i++) {
      const r = selectDiverseCue({ role: "reaction", lineIndex: i, candidates: [cue("P", "agree"), cue("Q", "disagree")], policy, mode: "soft", seed: `x-${i}`, within: newWithinEpisodeCueState(), history: noHist });
      assert(["P", "Q"].includes(r.selected!.assetId), "only from pool");
    }
  });

  check("38. a cue opportunity may remain EMPTY when every option is capped", () => {
    const within = newWithinEpisodeCueState();
    for (let i = 0; i < policy.withinEpisodeAssetCap; i++) { recordCuePlacement(within, "X", "fam_a"); }
    const r = selectDiverseCue({ role: "transition", lineIndex: 5, candidates: [cue("X", "fam_a")], policy, mode: "enforce", seed: "s", within, history: noHist });
    assert(r.selected === null && /left empty/.test(r.decision.reason), "left empty honestly");
  });

  check("cross-episode recency penalizes a very recently used cue asset", () => {
    const hist: CrossEpisodeCueHistory = { recentAssetIds: ["R"], recentFamilies: ["fam_r"] };
    const counts: Record<string, number> = { R: 0, S: 0 };
    for (let i = 0; i < 60; i++) { const r = selectDiverseCue({ role: "transition", lineIndex: 1, candidates: [cue("R", "fam_r"), cue("S", "fam_s")], policy, mode: "soft", seed: `k-${i}`, within: newWithinEpisodeCueState(), history: hist }); counts[r.selected!.assetId]++; }
    assert(counts.S > counts.R, `recently-used R disfavored (R=${counts.R}, S=${counts.S})`);
  });

  // --- Sequence similarity (Part 6) ---------------------------------------
  const tok = (arr: Array<[string, string]>) => tokenizeCueSequence(arr.map(([role, family]) => ({ role, family })));
  const A = tok([["INTRO", "brand_main"], ["TRANSITION", "topic_reset"], ["REACTION", "surprise"], ["OUTRO", "close_main"]]);

  check("39. an identical sequence scores maximum similarity (1)", () => { assert(sequenceSimilarity(A, A.slice()) === 1, "identical = 1"); });

  check("40. a completely different sequence scores low", () => {
    const B = tok([["INTRO", "brand_x"], ["TRANSITION", "data_reveal"], ["OUTRO", "close_x"]]);
    assert(sequenceSimilarity(A, B) < 0.34, `disjoint low (${sequenceSimilarity(A, B).toFixed(2)})`);
  });

  check("41. same families different assets are similar (families drive the token stream)", () => {
    const A2 = tok([["INTRO", "brand_main"], ["TRANSITION", "topic_reset"], ["REACTION", "surprise"], ["OUTRO", "close_main"]]);
    assert(sequenceSimilarity(A, A2) === 1, "same families -> identical tokens");
  });

  check("42. same families in a different order are similar but not identical", () => {
    const rev = tok([["OUTRO", "close_main"], ["REACTION", "surprise"], ["TRANSITION", "topic_reset"], ["INTRO", "brand_main"]]);
    const s = sequenceSimilarity(A, rev);
    assert(s < 1 && s > 0.3, `reorder similar<1 (${s.toFixed(2)})`);
  });

  check("43. similarity is deterministic and bounded to [0,1]", () => {
    for (const [a, b] of [[A, A], [A, tok([["INTRO", "z"]])], [tok([]), tok([])]] as const) {
      const s = sequenceSimilarity(a, b); assert(s >= 0 && s <= 1 && s === sequenceSimilarity(a, b), "bounded + deterministic");
    }
  });

  check("44. maxSimilarityToHistory finds the most similar recent episode (bounded)", () => {
    const hist = [tok([["INTRO", "x"]]), A.slice(), tok([["OUTRO", "y"]])];
    const m = maxSimilarityToHistory(A, hist);
    assert(m.maxSimilarity === 1 && m.mostSimilarIndex === 1, `most similar at 1 (${m.mostSimilarIndex})`);
  });

  check("45/46/47. over-threshold similarity records a relaxation (soft target, never hard-fails)", () => {
    const over = evaluateSequenceSimilarity(A, [A.slice()], 0.5);
    assert(over.overThreshold && over.relaxation === "sequence_similarity_relaxed", "over -> relaxation");
    const under = evaluateSequenceSimilarity(A, [tok([["INTRO", "z"]])], 0.9);
    assert(!under.overThreshold && under.relaxation === null, "under -> no relaxation");
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}
main();
