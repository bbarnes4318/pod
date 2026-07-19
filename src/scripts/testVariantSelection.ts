// Deterministic variant-selection tests (PR 2). Run: npm run test:variant-selection
//
// Pure (no DB/ffmpeg/network). Proves the seeded selector: identical inputs ->
// identical selection; different seeds may differ; weights bias the
// distribution; one-item pools always select; intro/outro avoid the same file;
// format + identity restrictions respected; excluded assets never selected;
// reasons recorded; no Math.random / wall-clock.

import { selectEpisodeSoundVariants } from "../lib/audio/variantSelection";
import { DEFAULT_SONIC_IDENTITY, type SonicIdentity } from "../lib/audio/sonicIdentity";
import type { FrozenSoundProfile, FrozenSoundAssetRef } from "../lib/services/podcastSoundProfile";

let passed = 0, failed = 0;
function check(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.error(`  ✗ ${name}\n      ${(err as Error).message}`); }
}
function assert(c: boolean, m: string) { if (!c) throw new Error(m); }

const ref = (id: string, role: FrozenSoundAssetRef["role"], over: Partial<FrozenSoundAssetRef> = {}): FrozenSoundAssetRef => ({
  assetId: id, kind: role === "intro" ? "theme_intro" : role === "outro" ? "theme_outro" : role === "bed" ? "bed" : role === "stinger" ? "stinger" : "sfx",
  category: null, name: `Asset ${id}`, contentHash: `h-${id}`, scope: "shared_system", role,
  orderIndex: 0, gainDb: null, fadeInMs: null, fadeOutMs: null, durationMs: 3000, tags: [],
  rightsStatusAtCapture: "not_required", licenseStatusAtCapture: "licensed", provenance: "podcast_assignment",
  weight: 1, cueFamily: null, allowedFormatIds: [], prohibitedFormatIds: [], isBrandedMotif: false,
  ...over,
});

const profile = (over: Partial<FrozenSoundProfile> = {}): FrozenSoundProfile => ({
  mode: "custom", targetLoudnessLufs: null, cooldownScope: "podcast",
  stingerCooldownEpisodes: null, reactionCooldownEpisodes: null,
  introEnabled: true, outroEnabled: true,
  intro: null, outro: null, bed: null, stingers: [], reactions: [],
  introVariants: [], outroVariants: [], beds: [],
  sonicIdentity: DEFAULT_SONIC_IDENTITY, containsLegacyCompatAssets: false, excluded: [],
  ...over,
});

function main() {
  console.log("\nDeterministic variant selection\n");

  const introPool = [ref("iA", "intro", { cueFamily: "brand_main" }), ref("iB", "intro", { cueFamily: "brand_short" }), ref("iC", "intro", { cueFamily: "brand_high_energy" })];
  const outroPool = [ref("oA", "outro", { cueFamily: "close_main" }), ref("oB", "outro", { cueFamily: "close_short" })];
  const base = profile({ introVariants: introPool, outroVariants: outroPool });

  check("Test 28: identical inputs select identical variants (reproducible)", () => {
    const a = selectEpisodeSoundVariants(base, { seed: "ep-1", formatId: "two_host_debate" });
    const b = selectEpisodeSoundVariants(base, { seed: "ep-1", formatId: "two_host_debate" });
    assert(a.intro?.assetId === b.intro?.assetId && a.outro?.assetId === b.outro?.assetId, "same seed -> same selection");
    assert(!!a.selectionSeed && a.selectionReasons?.intro !== undefined, "seed + reasons recorded");
  });

  check("Test 29: different episode seeds may select different intro variants", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const r = selectEpisodeSoundVariants(base, { seed: `ep-${i}`, formatId: "two_host_debate" });
      if (r.intro) seen.add(r.intro.assetId);
    }
    assert(seen.size >= 2, `variety across seeds (got ${seen.size} distinct)`);
  });

  check("Test 30: weight biases the deterministic distribution across many seeds", () => {
    const weighted = profile({ introVariants: [ref("heavy", "intro", { weight: 20 }), ref("light", "intro", { weight: 1 })] });
    let heavy = 0;
    for (let i = 0; i < 200; i++) if (selectEpisodeSoundVariants(weighted, { seed: `s-${i}`, formatId: "two_host_debate" }).intro?.assetId === "heavy") heavy++;
    assert(heavy > 140, `heavy weight dominates (got ${heavy}/200)`);
  });

  check("Test 31: a one-item pool always selects that item", () => {
    const one = profile({ introVariants: [ref("solo", "intro")], outroVariants: [ref("soloO", "outro")] });
    for (let i = 0; i < 10; i++) assert(selectEpisodeSoundVariants(one, { seed: `x-${i}`, formatId: "two_host_debate" }).intro?.assetId === "solo", "always solo");
  });

  check("Test 32: intro and outro avoid the exact same asset when alternatives exist", () => {
    // Same physical asset id offered to both pools + an alternative outro.
    const shared = profile({ introVariants: [ref("shared", "intro")], outroVariants: [ref("shared", "outro"), ref("altO", "outro")] });
    for (let i = 0; i < 10; i++) {
      const r = selectEpisodeSoundVariants(shared, { seed: `y-${i}`, formatId: "two_host_debate" });
      assert(r.outro?.assetId !== r.intro?.assetId, `outro (${r.outro?.assetId}) != intro (${r.intro?.assetId})`);
    }
  });

  check("Test 32b: outro prefers the intro's matching brand family", () => {
    const branded = profile({
      introVariants: [ref("iHE", "intro", { cueFamily: "brand_high_energy" })],
      outroVariants: [ref("oPlain", "outro", { cueFamily: "close_main", weight: 1 }), ref("oHE", "outro", { cueFamily: "close_high_energy", weight: 1 })],
    });
    let matched = 0;
    for (let i = 0; i < 40; i++) if (selectEpisodeSoundVariants(branded, { seed: `b-${i}`, formatId: "two_host_debate" }).outro?.cueFamily === "close_high_energy") matched++;
    assert(matched > 28, `brand-matched close preferred (got ${matched}/40)`);
  });

  check("Tests 33/35: format restrictions are respected; excluded assets never selected", () => {
    const fmtRestricted = profile({ introVariants: [
      ref("news", "intro", { allowedFormatIds: ["news_roundup"] }),
      ref("any", "intro", { allowedFormatIds: [] }),
    ] });
    for (let i = 0; i < 15; i++) {
      const r = selectEpisodeSoundVariants(fmtRestricted, { seed: `f-${i}`, formatId: "two_host_debate" });
      assert(r.intro?.assetId === "any", `format-incompatible 'news' never selected (got ${r.intro?.assetId})`);
    }
    // the excluded one is recorded
    const r = selectEpisodeSoundVariants(fmtRestricted, { seed: "f-x", formatId: "two_host_debate" });
    assert(r.excluded.some((e) => e.assetId === "news"), "format-excluded variant recorded");
  });

  check("Test 34: sonic-identity format restrictions are respected", () => {
    const id: SonicIdentity = { ...DEFAULT_SONIC_IDENTITY, prohibitedFormatIds: ["two_host_debate"] };
    const p = profile({ sonicIdentity: id, introVariants: [ref("iA", "intro")] });
    const r = selectEpisodeSoundVariants(p, { seed: "z", formatId: "two_host_debate", identity: id });
    assert(r.intro === null, "identity-prohibited format -> no selection");
  });

  check("Test 36: selection reasons are stored for intro/outro/bed", () => {
    const p = profile({ introVariants: introPool, outroVariants: outroPool, beds: [ref("bed1", "bed")] });
    const r = selectEpisodeSoundVariants(p, { seed: "r", formatId: "two_host_debate" });
    assert(!!r.selectionReasons?.intro && !!r.selectionReasons?.outro && !!r.selectionReasons?.bed, `reasons: ${JSON.stringify(r.selectionReasons)}`);
  });

  check("bed policy 'none' selects no bed", () => {
    const id: SonicIdentity = { ...DEFAULT_SONIC_IDENTITY, bedPolicy: "none" };
    const p = profile({ sonicIdentity: id, beds: [ref("bed1", "bed")] });
    assert(selectEpisodeSoundVariants(p, { seed: "n", formatId: "two_host_debate", identity: id }).bed === null, "no bed under 'none' policy");
  });

  check("clean profiles pass through selection untouched", () => {
    const clean = profile({ mode: "clean", introEnabled: false, outroEnabled: false });
    const r = selectEpisodeSoundVariants(clean, { seed: "c", formatId: "two_host_debate" });
    assert(r.intro === null && r.outro === null && r.bed === null, "clean stays empty");
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
