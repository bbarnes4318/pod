// Rollout modes + operator visibility tests (PR 4, pure).
// Run: npm run test:sound-diversity-rollout
import { resolveDiversityRollout } from "../lib/audio/soundDiversityFlags";
import { summarizePodcastDiversity } from "../lib/audio/soundDiversityVisibility";
import { resolveSoundDiversityPolicy } from "../lib/audio/soundDiversityPolicy";

let passed = 0, failed = 0;
function check(name: string, fn: () => void) { try { fn(); passed++; console.log(`  ✓ ${name}`); } catch (err) { failed++; console.error(`  ✗ ${name}\n      ${(err as Error).message}`); } }
function assert(c: boolean, m: string) { if (!c) throw new Error(m); }
const env = (o: Record<string, string>) => o as unknown as NodeJS.ProcessEnv;

function main() {
  console.log("\nSound diversity rollout modes + visibility\n");

  check("54. engine OFF -> mode off, no enforcement", () => {
    const r = resolveDiversityRollout(env({}));
    assert(r.mode === "off" && r.engineEnabled === false, "off by default");
  });

  check("55. enabled with no mode configured -> observe (safe default, never silent enforce)", () => {
    const r = resolveDiversityRollout(env({ SOUND_DIVERSITY_ENGINE_ENABLED: "true" }));
    assert(r.mode === "observe" && r.engineEnabled, "observe default");
  });

  check("56. explicit soft mode", () => {
    assert(resolveDiversityRollout(env({ SOUND_DIVERSITY_ENGINE_ENABLED: "true", SOUND_DIVERSITY_ENFORCEMENT_MODE: "soft" })).mode === "soft", "soft");
  });

  check("57. explicit enforce mode", () => {
    assert(resolveDiversityRollout(env({ SOUND_DIVERSITY_ENGINE_ENABLED: "true", SOUND_DIVERSITY_ENFORCEMENT_MODE: "enforce" })).mode === "enforce", "enforce");
  });

  check("58. an INVALID mode fails SAFE to off and records the bad value", () => {
    const r = resolveDiversityRollout(env({ SOUND_DIVERSITY_ENGINE_ENABLED: "true", SOUND_DIVERSITY_ENFORCEMENT_MODE: "aggressive" }));
    assert(r.mode === "off" && r.invalidMode === "aggressive", `fail-safe off (${r.mode}, invalid=${r.invalidMode})`);
  });

  check("explicit off mode when enabled", () => {
    assert(resolveDiversityRollout(env({ SOUND_DIVERSITY_ENGINE_ENABLED: "true", SOUND_DIVERSITY_ENFORCEMENT_MODE: "off" })).mode === "off", "off honored");
  });

  check("system-history flag is independent of the mode", () => {
    const r = resolveDiversityRollout(env({ SOUND_DIVERSITY_ENGINE_ENABLED: "true", SOUND_DIVERSITY_ENFORCEMENT_MODE: "soft", SOUND_DIVERSITY_SYSTEM_HISTORY_ENABLED: "true" }));
    assert(r.systemHistoryEnabled === true, "system history on");
  });

  check("resolution is deterministic", () => {
    const a = resolveDiversityRollout(env({ SOUND_DIVERSITY_ENGINE_ENABLED: "true", SOUND_DIVERSITY_ENFORCEMENT_MODE: "soft" }));
    const b = resolveDiversityRollout(env({ SOUND_DIVERSITY_ENGINE_ENABLED: "true", SOUND_DIVERSITY_ENFORCEMENT_MODE: "soft" }));
    assert(JSON.stringify(a) === JSON.stringify(b), "deterministic");
  });

  check("operator summary is safe (numbers/modes/histograms only, no URLs/keys)", () => {
    const policy = resolveSoundDiversityPolicy();
    const rollout = resolveDiversityRollout(env({ SOUND_DIVERSITY_ENGINE_ENABLED: "true", SOUND_DIVERSITY_ENFORCEMENT_MODE: "soft" }));
    const s = summarizePodcastDiversity({ policy, rollout, history: { scope: "podcast", windowRequested: 6, windowUsed: 2, warnings: [], truncated: false, episodes: [
      { episodeId: "e0", renderId: "r0", creationOrder: 0, formatId: "two_host_debate", introAssetId: "i1", outroAssetId: "o1", bedAssetId: "b1", transitionAssetIds: ["t1"], reactionAssetIds: [], introFamily: "brand_main", outroFamily: "close_main", bedFamily: "analysis", transitionFamilySequence: ["topic_reset"], reactionFamilySequence: [], cueFamilySequence: [], introIsMotif: false, outroIsMotif: false, bedIsMotif: false, brandedMotifUsed: false, planningEngine: "post_tts", planningVersion: 2, planFingerprint: "fp0", renderKind: "initial" },
      { episodeId: "e1", renderId: "r1", creationOrder: 1, formatId: "two_host_debate", introAssetId: "i1", outroAssetId: "o2", bedAssetId: "b1", transitionAssetIds: [], reactionAssetIds: [], introFamily: "brand_main", outroFamily: "close_alt", bedFamily: "analysis", transitionFamilySequence: [], reactionFamilySequence: [], cueFamilySequence: [], introIsMotif: false, outroIsMotif: false, bedIsMotif: false, brandedMotifUsed: false, planningEngine: "post_tts", planningVersion: 2, planFingerprint: "fp1", renderKind: "initial" },
    ] } });
    assert(s.rolloutMode === "soft" && s.policyVersion === policy.version, "config surfaced");
    assert(s.recentAssetUsage["i1"] === 2 && s.recentAssetUsage["b1"] === 2, "asset histogram");
    assert(s.recentFamilyUsage["brand_main"] === 2, "family histogram");
    assert(!JSON.stringify(s).match(/https?:\/\/|\/storage\/|[A-Za-z]:\\/), "no URLs/keys/paths");
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}
main();
