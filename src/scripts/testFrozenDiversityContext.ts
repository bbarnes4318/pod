// Frozen diversity context (snapshot v6) tests (PR 4 corrections, pure).
// Run: npm run test:frozen-diversity-context
//
// Proves the render-influencing diversity context is FROZEN at creation and is
// self-contained + deterministic, so a delayed / initial render cannot drift
// when later history / policy / env / system state changes. The render-path
// "uses frozen, not current" invariant + remix modes are proven end-to-end by
// test:post-tts-render-gate.

import { buildFrozenDiversityContext, fingerprintFrozenDiversityContext } from "../lib/audio/soundDiversity";
import { resolveSoundDiversityPolicy } from "../lib/audio/soundDiversityPolicy";
import type { FrozenSoundProfile, FrozenSoundAssetRef } from "../lib/services/podcastSoundProfile";
import type { DiversityHistory, DiversityHistoryEpisode } from "../lib/services/diversityHistory";
import { DEFAULT_SONIC_IDENTITY } from "../lib/audio/sonicIdentity";

let passed = 0, failed = 0;
function check(name: string, fn: () => void) { try { fn(); passed++; console.log(`  ✓ ${name}`); } catch (err) { failed++; console.error(`  ✗ ${name}\n      ${(err as Error).message}`); } }
function assert(c: boolean, m: string) { if (!c) throw new Error(m); }

const ref = (assetId: string, role: FrozenSoundAssetRef["role"], over: Partial<FrozenSoundAssetRef> = {}): FrozenSoundAssetRef => ({
  assetId, kind: role === "intro" ? "theme_intro" : role === "outro" ? "theme_outro" : "bed", category: null, name: assetId, contentHash: `h-${assetId}`, scope: "shared_system", role, orderIndex: 0,
  gainDb: null, fadeInMs: null, fadeOutMs: null, durationMs: 3000, tags: [], rightsStatusAtCapture: "not_required", licenseStatusAtCapture: "licensed",
  provenance: "podcast_assignment", weight: 1, cueFamily: null, isBrandedMotif: false, allowedFormatIds: [], prohibitedFormatIds: [], ...over,
});
const profile: FrozenSoundProfile = {
  mode: "custom", targetLoudnessLufs: null, cooldownScope: "podcast", stingerCooldownEpisodes: null, reactionCooldownEpisodes: null,
  introEnabled: true, outroEnabled: true, intro: ref("i1", "intro"), outro: ref("o1", "outro"), bed: ref("b1", "bed"),
  stingers: [], reactions: [], introVariants: [ref("i1", "intro"), ref("i2", "intro")], outroVariants: [ref("o1", "outro"), ref("o2", "outro")], beds: [ref("b1", "bed"), ref("b2", "bed")],
  sonicIdentity: DEFAULT_SONIC_IDENTITY, containsLegacyCompatAssets: false, excluded: [],
};
const hist = (intros: string[], transitions: string[][] = []): DiversityHistory => ({
  scope: "podcast", windowRequested: 6, windowUsed: intros.length, warnings: [], truncated: false,
  episodes: intros.map((intro, i): DiversityHistoryEpisode => ({
    episodeId: `e${i}`, renderId: `r${i}`, creationOrder: i, formatId: "two_host_debate",
    introAssetId: intro, outroAssetId: "o1", bedAssetId: "b1", transitionAssetIds: transitions[i] ?? [], reactionAssetIds: [],
    introFamily: null, outroFamily: null, bedFamily: null, transitionFamilySequence: (transitions[i] ?? []).map(() => "topic_reset"), reactionFamilySequence: [],
    cueFamilySequence: [], introIsMotif: false, outroIsMotif: false, bedIsMotif: false, brandedMotifUsed: false,
    planningEngine: "post_tts", planningVersion: 2, planFingerprint: `fp${i}`, renderKind: "initial",
  })),
});
const policy = resolveSoundDiversityPolicy();
const build = (history: DiversityHistory, mode: "soft" | "enforce" = "enforce", seed = "ep-A") =>
  buildFrozenDiversityContext(profile, { policy, mode, history, seed, formatId: "two_host_debate", identity: DEFAULT_SONIC_IDENTITY });

function main() {
  console.log("\nFrozen diversity context (snapshot v6)\n");

  check("1/6/12. building the context is deterministic (same inputs -> identical fingerprint + selection)", () => {
    const a = build(hist(["i1"]));
    const b = build(hist(["i1"]));
    assert(a.context.fingerprint === b.context.fingerprint && a.context.fingerprint.length === 64, "deterministic v6 fingerprint");
    assert(a.intro?.assetId === b.intro?.assetId && a.outro?.assetId === b.outro?.assetId, "deterministic selection");
  });

  check("the frozen context is SELF-CONTAINED (policy + mode + bounded cue history)", () => {
    const a = build(hist(["i1"], [["st-1", "st-2"]]));
    assert(a.context.policy.version === policy.version, "resolved policy frozen");
    assert(a.context.rolloutMode === "enforce", "rollout mode frozen");
    assert(Array.isArray(a.context.transitionHistory.recentAssetIds) && a.context.transitionHistory.recentAssetIds.includes("st-1"), "transition cue history frozen");
    assert(Array.isArray(a.context.reactionHistory.recentAssetIds), "reaction cue history frozen");
    assert(!!a.context.historyFingerprint && !!a.context.decision, "history fingerprint + decision frozen");
  });

  check("1. a DIFFERENT creation-time history yields a different frozen context (history is captured, not read later)", () => {
    const a = build(hist(["i1"]));   // previous episode used i1
    const b = build(hist(["i2"]));   // previous episode used i2
    assert(a.context.fingerprint !== b.context.fingerprint, "history A vs B differ");
    // With i1 on cooldown, A avoids i1; with i2 on cooldown, B avoids i2.
    assert(a.intro?.assetId === "i2" && b.intro?.assetId === "i1", `each avoids its own recent intro (${a.intro?.assetId}/${b.intro?.assetId})`);
  });

  check("2-5. the context captures the mode + policy at creation (a later mode/policy change cannot reach a frozen episode)", () => {
    const enforce = build(hist(["i1"]), "enforce");
    const soft = build(hist(["i1"]), "soft");
    assert(enforce.context.rolloutMode === "enforce" && soft.context.rolloutMode === "soft", "mode frozen per build");
    // A frozen context references its OWN policy snapshot; env changes later do not
    // mutate this object (it is a value, not a live read).
    const strictPolicy = resolveSoundDiversityPolicy({ overrides: { hardAssetCooldownEpisodes: 5 } });
    const withStrict = buildFrozenDiversityContext(profile, { policy: strictPolicy, mode: "enforce", history: hist(["i1"]), seed: "ep-A", formatId: "two_host_debate", identity: DEFAULT_SONIC_IDENTITY });
    assert(withStrict.context.policy.hardAssetCooldownEpisodes === 5 && enforce.context.policy.hardAssetCooldownEpisodes === policy.hardAssetCooldownEpisodes, "each context keeps its own frozen policy");
  });

  check("the v6 fingerprint includes every render-influencing field (changing cue history changes it)", () => {
    const a = build(hist(["i1"], [["st-1"]]));
    const b = build(hist(["i1"], [["st-9"]]));
    assert(a.context.fingerprint !== b.context.fingerprint, "different transition history -> different fingerprint");
  });

  check("fingerprintFrozenDiversityContext is a pure function of the context value", () => {
    const a = build(hist(["i1"]));
    const recomputed = fingerprintFrozenDiversityContext({ ...a.context, fingerprint: "" });
    assert(recomputed === a.context.fingerprint, "fingerprint reproducible from the value");
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}
main();
