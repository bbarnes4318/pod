// Sound diversity POLICY tests (PR 4, pure). Run: npm run test:sound-diversity-policy
import {
  resolveSoundDiversityPolicy, diversityPolicyOverridesFromEnv, DEFAULT_SOUND_DIVERSITY_POLICY,
  DIVERSITY_BOUNDS, SOUND_DIVERSITY_POLICY_VERSION,
} from "../lib/audio/soundDiversityPolicy";
import { DEFAULT_SONIC_IDENTITY } from "../lib/audio/sonicIdentity";

let passed = 0, failed = 0;
function check(name: string, fn: () => void) { try { fn(); passed++; console.log(`  ✓ ${name}`); } catch (err) { failed++; console.error(`  ✗ ${name}\n      ${(err as Error).message}`); } }
function assert(c: boolean, m: string) { if (!c) throw new Error(m); }

function main() {
  console.log("\nSound diversity policy\n");

  check("defaults are valid, version-pinned, and coherent", () => {
    const p = resolveSoundDiversityPolicy();
    assert(p.version === SOUND_DIVERSITY_POLICY_VERSION, "version pinned");
    assert(p.brandedMotifMinimumRate <= p.brandedMotifMaximumRate, "motif band coherent");
    assert(p.historyWindowEpisodes === DEFAULT_SOUND_DIVERSITY_POLICY.historyWindowEpisodes, "default window");
    assert(p.systemCrossPodcastDiversityEnabled === false, "system diversity off by default");
  });

  check("out-of-range numeric overrides clamp to bounds (fail-safe, no throw)", () => {
    const p = resolveSoundDiversityPolicy({ overrides: {
      historyWindowEpisodes: 9999, hardAssetCooldownEpisodes: -5, maximumSameIntroStreak: 0,
      brandedMotifMaximumRate: 3, brandedMotifMinimumRate: -1, assetReusePenalty: 10_000,
      withinEpisodeAssetCap: 999, maximumCueSequenceSimilarity: 2,
    } });
    assert(p.historyWindowEpisodes === DIVERSITY_BOUNDS.maxHistoryWindowEpisodes, `window clamped (${p.historyWindowEpisodes})`);
    assert(p.hardAssetCooldownEpisodes === 0, "negative cooldown clamped to 0");
    assert(p.maximumSameIntroStreak === 1, "streak min is 1");
    assert(p.brandedMotifMaximumRate === 1 && p.brandedMotifMinimumRate === 0, "rates clamped to [0,1]");
    assert(p.assetReusePenalty === 100, "penalty clamped to 100");
    assert(p.withinEpisodeAssetCap === 50, "asset cap clamped to 50");
    assert(p.maximumCueSequenceSimilarity === 1, "similarity clamped to 1");
  });

  check("invalid (NaN / wrong type) overrides fall back to the default value", () => {
    const p = resolveSoundDiversityPolicy({ overrides: {
      historyWindowEpisodes: NaN as unknown as number,
      familyCooldownEpisodes: "bad" as unknown as number,
    } });
    assert(p.historyWindowEpisodes === DEFAULT_SOUND_DIVERSITY_POLICY.historyWindowEpisodes, "NaN -> default");
    assert(p.familyCooldownEpisodes === DEFAULT_SOUND_DIVERSITY_POLICY.familyCooldownEpisodes, "string -> default");
  });

  check("a minimum motif rate above the maximum is pulled down to the maximum", () => {
    const p = resolveSoundDiversityPolicy({ overrides: { brandedMotifMinimumRate: 0.9, brandedMotifMaximumRate: 0.4 } });
    assert(p.brandedMotifMaximumRate === 0.4, "max kept");
    assert(p.brandedMotifMinimumRate === 0.4, "min pulled to max");
  });

  check("an identity with branded motifs disabled collapses the motif band to zero", () => {
    const p = resolveSoundDiversityPolicy({ identity: { ...DEFAULT_SONIC_IDENTITY, brandedMotifEnabled: false } });
    assert(p.brandedMotifMinimumRate === 0 && p.brandedMotifMaximumRate === 0, "motif band 0");
  });

  check("env overrides are parsed and then bounded", () => {
    const env = { SOUND_DIVERSITY_HISTORY_WINDOW: "8", SOUND_DIVERSITY_MAX_SEQUENCE_SIMILARITY: "0.55", SOUND_DIVERSITY_HARD_ASSET_COOLDOWN: "999" } as unknown as NodeJS.ProcessEnv;
    const p = resolveSoundDiversityPolicy({ overrides: diversityPolicyOverridesFromEnv(env) });
    assert(p.historyWindowEpisodes === 8, `window from env (${p.historyWindowEpisodes})`);
    assert(Math.abs(p.maximumCueSequenceSimilarity - 0.55) < 1e-9, "similarity from env");
    assert(p.hardAssetCooldownEpisodes === 20, "env cooldown clamped to bound 20");
  });

  check("systemCrossPodcastDiversityEnabled override is respected as a boolean", () => {
    assert(resolveSoundDiversityPolicy({ overrides: { systemCrossPodcastDiversityEnabled: true } }).systemCrossPodcastDiversityEnabled === true, "true honored");
    assert(resolveSoundDiversityPolicy({ overrides: { systemCrossPodcastDiversityEnabled: "yes" as unknown as boolean } }).systemCrossPodcastDiversityEnabled === false, "non-boolean -> default false");
  });

  check("resolution is deterministic (same inputs -> identical policy)", () => {
    const a = resolveSoundDiversityPolicy({ overrides: { historyWindowEpisodes: 5 } });
    const b = resolveSoundDiversityPolicy({ overrides: { historyWindowEpisodes: 5 } });
    assert(JSON.stringify(a) === JSON.stringify(b), "deterministic");
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}
main();
