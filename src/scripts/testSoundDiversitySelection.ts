// Pre-snapshot diversity SELECTION tests (PR 4, pure).
// Run: npm run test:sound-diversity-selection
import { selectDiverseVariant, type RoleHistoryView } from "../lib/audio/soundDiversitySelection";
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
const roleHist = (assetIds: Array<string | null>, families: Array<string | null> = []): RoleHistoryView => ({ assetIds, families: families.length ? families : assetIds.map(() => null) });
const policy = resolveSoundDiversityPolicy();

// Build a DiversityHistory from per-episode role selections (newest first).
const history = (eps: Array<Partial<DiversityHistoryEpisode>>): DiversityHistory => ({
  scope: "podcast", windowRequested: 6, windowUsed: eps.length, warnings: [], truncated: false,
  episodes: eps.map((e, i) => ({
    episodeId: `e${i}`, renderId: `r${i}`, creationOrder: i, formatId: "two_host_debate",
    introAssetId: null, outroAssetId: null, bedAssetId: null, transitionAssetIds: [], reactionAssetIds: [],
    introFamily: null, outroFamily: null, bedFamily: null, transitionFamilySequence: [], reactionFamilySequence: [],
    cueFamilySequence: [], brandedMotifUsed: false, planningEngine: "post_tts", planningVersion: 2, planFingerprint: `fp${i}`, renderKind: "initial", ...e,
  })),
});

function main() {
  console.log("\nPre-snapshot diversity selection\n");

  check("11. immediate intro repeat is avoided in enforce mode when an alternative exists", () => {
    const r = selectDiverseVariant({ role: "intro", candidates: [ref("X"), ref("Y")], policy, mode: "enforce", seed: "s", history: roleHist(["X"]) });
    assert(r.selected?.assetId === "Y", `picked Y not X (${r.selected?.assetId})`);
    assert(r.decision.candidates.find((c) => c.assetId === "X")?.excluded === true, "X hard-excluded (cooldown)");
  });

  check("14. a bed at its streak limit is excluded in enforce mode", () => {
    const r = selectDiverseVariant({ role: "bed", candidates: [ref("B", { role: "bed" }), ref("C", { role: "bed" })], policy, mode: "enforce", seed: "s", history: roleHist(["B", "B"]) });
    assert(r.selected?.assetId === "C", `avoided the streaked bed (${r.selected?.assetId})`);
  });

  check("15. a one-item pool selects the only asset and records single_item_pool", () => {
    const r = selectDiverseVariant({ role: "intro", candidates: [ref("X")], policy, mode: "enforce", seed: "s", history: roleHist(["X", "X"]) });
    assert(r.selected?.assetId === "X" && r.decision.relaxations.includes("single_item_pool"), "only asset, honest relaxation");
    assert(!/cooldown compliance/.test(r.decision.reason), "does not claim cooldown compliance");
  });

  check("16. a two-item pool alternates deterministically when the previous is on cooldown", () => {
    const afterX = selectDiverseVariant({ role: "intro", candidates: [ref("X"), ref("Y")], policy, mode: "enforce", seed: "s", history: roleHist(["X"]) });
    const afterY = selectDiverseVariant({ role: "intro", candidates: [ref("X"), ref("Y")], policy, mode: "enforce", seed: "s", history: roleHist(["Y"]) });
    assert(afterX.selected?.assetId === "Y" && afterY.selected?.assetId === "X", "alternates");
  });

  check("17. a hard-cooled asset is never chosen while a valid alternative exists (large pool)", () => {
    for (let i = 0; i < 25; i++) {
      const r = selectDiverseVariant({ role: "intro", candidates: [ref("A"), ref("B"), ref("C"), ref("D")], policy, mode: "enforce", seed: `seed-${i}`, history: roleHist(["A"]) });
      assert(r.selected?.assetId !== "A", `seed ${i}: never the just-used A`);
    }
  });

  check("18/19. weight is favored over a large sample yet low-weight variants still appear", () => {
    const counts: Record<string, number> = { H: 0, L: 0 };
    for (let i = 0; i < 200; i++) {
      const r = selectDiverseVariant({ role: "intro", candidates: [ref("H", { weight: 8 }), ref("L", { weight: 1 })], policy, mode: "soft", seed: `k-${i}`, history: roleHist([]) });
      counts[r.selected!.assetId]++;
    }
    assert(counts.H > counts.L, `high weight favored (H=${counts.H}, L=${counts.L})`);
    assert(counts.L > 0, `low weight still appears (L=${counts.L})`);
  });

  check("selection is deterministic (same inputs -> same pick)", () => {
    const a = selectDiverseVariant({ role: "intro", candidates: [ref("A"), ref("B"), ref("C")], policy, mode: "soft", seed: "det", history: roleHist(["A"]) });
    const b = selectDiverseVariant({ role: "intro", candidates: [ref("A"), ref("B"), ref("C")], policy, mode: "soft", seed: "det", history: roleHist(["A"]) });
    assert(a.selected?.assetId === b.selected?.assetId && JSON.stringify(a.decision) === JSON.stringify(b.decision), "deterministic pick + decision");
  });

  check("never selects outside the given (already-eligible) pool", () => {
    for (let i = 0; i < 30; i++) {
      const r = selectDiverseVariant({ role: "intro", candidates: [ref("P"), ref("Q")], policy, mode: "soft", seed: `x-${i}`, history: roleHist(["P", "Q", "P"]) });
      assert(["P", "Q"].includes(r.selected!.assetId), "only from the pool");
    }
  });

  // --- Orchestrator (intro/outro/bed together) -----------------------------
  const profile = (over: Partial<FrozenSoundProfile> = {}): FrozenSoundProfile => ({
    mode: "custom", targetLoudnessLufs: null, cooldownScope: "podcast", stingerCooldownEpisodes: null, reactionCooldownEpisodes: null,
    introEnabled: true, outroEnabled: true, intro: ref("i1"), outro: ref("o1", { role: "outro", kind: "theme_outro" }), bed: ref("b1", { role: "bed", kind: "bed" }),
    stingers: [], reactions: [],
    introVariants: [ref("i1"), ref("i2")], outroVariants: [ref("o1", { role: "outro" }), ref("o2", { role: "outro" })], beds: [ref("b1", { role: "bed" }), ref("b2", { role: "bed" })],
    sonicIdentity: DEFAULT_SONIC_IDENTITY, containsLegacyCompatAssets: false, excluded: [], ...over,
  });

  check("13. the exact intro/outro pair from the previous episode is avoided (enforce)", () => {
    const h = history([{ introAssetId: "i1", outroAssetId: "o1" }]);
    const r = selectDiverseBookends(profile(), { policy, mode: "enforce", history: h, seed: "s", formatId: "two_host_debate" });
    assert(!(r.intro?.assetId === "i1" && r.outro?.assetId === "o1"), `pair (i1,o1) avoided, got (${r.intro?.assetId},${r.outro?.assetId})`);
  });

  check("20/21. a format/identity-incompatible variant is never selected", () => {
    const p = profile({ introVariants: [ref("i1", { prohibitedFormatIds: ["two_host_debate"] }), ref("i2")] });
    for (let i = 0; i < 20; i++) {
      const r = selectDiverseBookends(p, { policy, mode: "soft", history: history([]), seed: `f-${i}`, formatId: "two_host_debate" });
      assert(r.intro?.assetId === "i2", `format-prohibited i1 never chosen (${r.intro?.assetId})`);
    }
  });

  check("orchestrator produces a versioned, fingerprinted decision + honors observe/soft/enforce", () => {
    const h = history([{ introAssetId: "i1" }]);
    const soft = selectDiverseBookends(profile(), { policy, mode: "soft", history: h, seed: "s", formatId: "two_host_debate" });
    assert(soft.decision.version >= 1 && soft.decision.fingerprint.length === 64, "versioned + fingerprinted");
    assert(soft.decision.mode === "soft" && !!soft.decision.selectedIntro, "records intro decision");
    const enforce = selectDiverseBookends(profile(), { policy, mode: "enforce", history: h, seed: "s", formatId: "two_host_debate" });
    assert(enforce.intro?.assetId === "i2", "enforce avoids the just-used intro");
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}
main();
