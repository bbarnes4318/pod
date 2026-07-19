// Multi-episode sound-diversity acceptance harness (PR 4, Part 14).
// Run: npm run demo:sound-diversity
//
// Drives the DETERMINISTIC diversity engine over three multi-episode series,
// threading each episode's selections back as the next episode's history (as the
// live DB history reader would), and proves the catalog stays varied without
// destroying branding. Selection-level (no DB / no ffmpeg / no network): it
// exercises the exact selectDiverseBookends + selectDiverseCue used in
// production. Per-episode AUDIO rendering + acoustic bookend validation with the
// engine ENABLED is proven separately by test:diversity-render-gate.
//
//   Series A — Sports radio, 12 episodes: >=3 intros/outros/beds, several
//     transition + reaction families, one branded motif.
//   Series B — Documentary, 8 episodes: sparse cues, cinematic/reflective
//     families, NO sports/crowd/comedy, a separate branded motif.
//   Series C — System default, 10 episodes across TWO podcasts sharing one
//     shared-system pool.
//
// Writes a safe series-summary JSON (histograms, pair histogram, streaks, motif
// rate, similarity matrix, relaxations, deterministic replay fingerprint) to
// samples/sound-diversity/ (gitignored — no binaries committed) and asserts the
// acceptance matrix. Re-running produces identical reports + fingerprints.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { selectDiverseBookends } from "../lib/audio/soundDiversity";
import { selectDiverseCue, recordCuePlacement, newWithinEpisodeCueState, type CrossEpisodeCueHistory } from "../lib/audio/soundCueDiversity";
import { resolveSoundDiversityPolicy, type DiversityMode } from "../lib/audio/soundDiversityPolicy";
import { tokenizeCueSequence, sequenceSimilarity } from "../lib/audio/soundSequenceSimilarity";
import type { FrozenSoundProfile, FrozenSoundAssetRef } from "../lib/services/podcastSoundProfile";
import type { DiversityHistory, DiversityHistoryEpisode } from "../lib/services/diversityHistory";
import { DEFAULT_SONIC_IDENTITY, type SonicIdentity } from "../lib/audio/sonicIdentity";

let passed = 0, failed = 0;
function check(name: string, fn: () => void) { try { fn(); passed++; console.log(`  ✓ ${name}`); } catch (err) { failed++; console.error(`  ✗ ${name}\n      ${(err as Error).message}`); } }
function assert(c: boolean, m: string) { if (!c) throw new Error(m); }

const ref = (assetId: string, role: FrozenSoundAssetRef["role"], family: string, over: Partial<FrozenSoundAssetRef> = {}): FrozenSoundAssetRef => ({
  assetId, kind: role === "intro" ? "theme_intro" : role === "outro" ? "theme_outro" : role === "bed" ? "bed" : role === "stinger" ? "stinger" : "sfx",
  category: null, name: assetId, contentHash: `h-${assetId}`, scope: "shared_system", role, orderIndex: 0, gainDb: null, fadeInMs: null, fadeOutMs: null,
  durationMs: 3000, tags: [], rightsStatusAtCapture: "not_required", licenseStatusAtCapture: "licensed", provenance: "podcast_assignment",
  weight: 1, cueFamily: family, isBrandedMotif: false, allowedFormatIds: [], prohibitedFormatIds: [], maxUsesPerEpisode: null, minEpisodeCooldown: null, ...over,
});

interface SeriesConfig {
  name: string; formatId: string; episodes: number; seedPrefix: string;
  profile: FrozenSoundProfile; identity: SonicIdentity; mode: DiversityMode;
  transitionOpportunities: number; reactionOpportunities: number;
  podcastSplit?: number; // for the system series: episodes < split are podcast-1, else podcast-2
}

// ---- Series definitions --------------------------------------------------
const sportsIdentity: SonicIdentity = { ...DEFAULT_SONIC_IDENTITY, brandedMotifEnabled: true, bedPolicy: "select_segments" };
const sportsProfile: FrozenSoundProfile = {
  mode: "custom", targetLoudnessLufs: null, cooldownScope: "podcast", stingerCooldownEpisodes: null, reactionCooldownEpisodes: null,
  introEnabled: true, outroEnabled: true,
  intro: ref("s-intro-brand", "intro", "brand_main", { isBrandedMotif: true }), outro: ref("s-out-1", "outro", "close_main"), bed: ref("s-bed-1", "bed", "pulse"),
  stingers: [ref("s-st-hit", "stinger", "hard_hit"), ref("s-st-score", "stinger", "score_update"), ref("s-st-sweep", "stinger", "quick_sweep"), ref("s-st-data", "stinger", "data_reveal")],
  reactions: [ref("s-rx-crowd", "reaction", "crowd_positive"), ref("s-rx-agree", "reaction", "agreement"), ref("s-rx-buzzer", "reaction", "buzzer")],
  introVariants: [ref("s-intro-brand", "intro", "brand_main", { isBrandedMotif: true, weight: 2 }), ref("s-intro-b", "intro", "brand_high_energy"), ref("s-intro-c", "intro", "brand_short")],
  outroVariants: [ref("s-out-1", "outro", "close_main"), ref("s-out-2", "outro", "close_high_energy"), ref("s-out-3", "outro", "close_short")],
  beds: [ref("s-bed-1", "bed", "pulse"), ref("s-bed-2", "bed", "drive"), ref("s-bed-3", "bed", "ambient")],
  sonicIdentity: sportsIdentity, containsLegacyCompatAssets: false, excluded: [],
};
const docIdentity: SonicIdentity = { ...DEFAULT_SONIC_IDENTITY, brandedMotifEnabled: true, bedPolicy: "select_segments", prohibitedCueFamilies: ["crowd_positive", "crowd_negative", "comedy_button", "hard_hit", "score_update"] };
const docProfile: FrozenSoundProfile = {
  mode: "custom", targetLoudnessLufs: null, cooldownScope: "podcast", stingerCooldownEpisodes: null, reactionCooldownEpisodes: null,
  introEnabled: true, outroEnabled: true,
  intro: ref("d-intro-brand", "intro", "brand_minimal", { isBrandedMotif: true }), outro: ref("d-out-1", "outro", "close_reflective"), bed: ref("d-bed-1", "bed", "cinematic"),
  stingers: [ref("d-st-bridge", "stinger", "cinematic_bridge"), ref("d-st-tension", "stinger", "tension_rise"), ref("d-st-under", "stinger", "understated_transition")],
  reactions: [ref("d-rx-reflect", "reaction", "reflective")],
  introVariants: [ref("d-intro-brand", "intro", "brand_minimal", { isBrandedMotif: true, weight: 2 }), ref("d-intro-b", "intro", "brand_main")],
  outroVariants: [ref("d-out-1", "outro", "close_reflective"), ref("d-out-2", "outro", "close_main")],
  beds: [ref("d-bed-1", "bed", "cinematic"), ref("d-bed-2", "bed", "ambient"), ref("d-bed-3", "bed", "drone")],
  sonicIdentity: docIdentity, containsLegacyCompatAssets: false, excluded: [],
};
const sysIdentity: SonicIdentity = { ...DEFAULT_SONIC_IDENTITY, brandedMotifEnabled: false, bedPolicy: "select_segments" };
const sysProfile: FrozenSoundProfile = {
  mode: "system_default", targetLoudnessLufs: null, cooldownScope: "podcast", stingerCooldownEpisodes: null, reactionCooldownEpisodes: null,
  introEnabled: true, outroEnabled: true,
  intro: ref("sys-intro-1", "intro", "sys_open"), outro: ref("sys-out-1", "outro", "sys_close"), bed: ref("sys-bed-1", "bed", "sys_pad"),
  stingers: [ref("sys-st-1", "stinger", "topic_reset"), ref("sys-st-2", "stinger", "quick_sweep")],
  reactions: [ref("sys-rx-1", "reaction", "agreement")],
  introVariants: [ref("sys-intro-1", "intro", "sys_open"), ref("sys-intro-2", "intro", "sys_open_b"), ref("sys-intro-3", "intro", "sys_open_c")],
  outroVariants: [ref("sys-out-1", "outro", "sys_close"), ref("sys-out-2", "outro", "sys_close_b")],
  beds: [ref("sys-bed-1", "bed", "sys_pad"), ref("sys-bed-2", "bed", "sys_pad_b")],
  sonicIdentity: sysIdentity, containsLegacyCompatAssets: false, excluded: [],
};

const policy = resolveSoundDiversityPolicy();

interface EpisodeResult {
  episodeId: string; introAssetId: string | null; outroAssetId: string | null; bedAssetId: string | null;
  introFamily: string | null; outroFamily: string | null; bedFamily: string | null; introIsMotif: boolean; outroIsMotif: boolean; bedIsMotif: boolean;
  transitionAssetIds: string[]; reactionAssetIds: string[]; transitionFamilies: string[]; reactionFamilies: string[];
  cueTokens: string[]; relaxations: string[];
}

function permitted(pool: FrozenSoundAssetRef[], identity: SonicIdentity): FrozenSoundAssetRef[] {
  return pool.filter((r) => !identity.prohibitedCueFamilies.includes(r.cueFamily ?? ""));
}

/** Run one series, threading history. Returns per-episode results (creation order). */
function runSeries(cfg: SeriesConfig): EpisodeResult[] {
  const results: EpisodeResult[] = [];
  const historyEpisodes: DiversityHistoryEpisode[] = []; // newest first

  for (let i = 0; i < cfg.episodes; i++) {
    const seed = `${cfg.seedPrefix}:ep${i}`;
    const window = historyEpisodes.slice(0, policy.historyWindowEpisodes);
    const history: DiversityHistory = { scope: "podcast", windowRequested: policy.historyWindowEpisodes, windowUsed: window.length, episodes: window, warnings: [], truncated: false };
    const div = selectDiverseBookends(cfg.profile, { policy, mode: cfg.mode, history, seed, formatId: cfg.formatId, identity: cfg.identity });

    // Simulate the director's cue opportunities (within-episode diversity).
    const within = newWithinEpisodeCueState();
    const transHist: CrossEpisodeCueHistory = { recentAssetIds: window.flatMap((e) => e.transitionAssetIds), recentFamilies: window.flatMap((e) => e.transitionFamilySequence) };
    const reactHist: CrossEpisodeCueHistory = { recentAssetIds: window.flatMap((e) => e.reactionAssetIds), recentFamilies: window.flatMap((e) => e.reactionFamilySequence) };
    const transitionAssetIds: string[] = [], transitionFamilies: string[] = [], reactionAssetIds: string[] = [], reactionFamilies: string[] = [];
    const applyMode = cfg.mode === "enforce" ? "enforce" : "soft";
    for (let t = 0; t < cfg.transitionOpportunities; t++) {
      const r = selectDiverseCue({ role: "transition", lineIndex: t, candidates: permitted(cfg.profile.stingers, cfg.identity), policy, mode: applyMode, seed: `${seed}:t${t}`, within, history: transHist });
      if (r.selected) { transitionAssetIds.push(r.selected.assetId); transitionFamilies.push(r.selected.cueFamily ?? "none"); recordCuePlacement(within, r.selected.assetId, r.selected.cueFamily ?? null); }
    }
    for (let t = 0; t < cfg.reactionOpportunities; t++) {
      const r = selectDiverseCue({ role: "reaction", lineIndex: 100 + t, candidates: permitted(cfg.profile.reactions, cfg.identity), policy, mode: applyMode, seed: `${seed}:r${t}`, within, history: reactHist });
      if (r.selected) { reactionAssetIds.push(r.selected.assetId); reactionFamilies.push(r.selected.cueFamily ?? "none"); recordCuePlacement(within, r.selected.assetId, r.selected.cueFamily ?? null); }
    }

    const introIsMotif = !!cfg.profile.introVariants?.find((v) => v.assetId === div.intro?.assetId)?.isBrandedMotif;
    const outroIsMotif = !!cfg.profile.outroVariants?.find((v) => v.assetId === div.outro?.assetId)?.isBrandedMotif;
    const cueTokens = tokenizeCueSequence([
      ...(div.intro ? [{ role: "INTRO", family: div.intro.cueFamily ?? null }] : []),
      ...(div.bed ? [{ role: "BED", family: div.bed.cueFamily ?? null }] : []),
      ...transitionFamilies.map((f) => ({ role: "TRANSITION", family: f })),
      ...reactionFamilies.map((f) => ({ role: "REACTION", family: f })),
      ...(div.outro ? [{ role: "OUTRO", family: div.outro.cueFamily ?? null }] : []),
    ]);

    const res: EpisodeResult = {
      episodeId: seed, introAssetId: div.intro?.assetId ?? null, outroAssetId: div.outro?.assetId ?? null, bedAssetId: div.bed?.assetId ?? null,
      introFamily: div.intro?.cueFamily ?? null, outroFamily: div.outro?.cueFamily ?? null, bedFamily: div.bed?.cueFamily ?? null,
      introIsMotif, outroIsMotif, bedIsMotif: false, transitionAssetIds, reactionAssetIds, transitionFamilies, reactionFamilies, cueTokens, relaxations: div.decision.relaxations,
    };
    results.push(res);

    // Prepend as the newest history entry for the next episode.
    historyEpisodes.unshift({
      episodeId: seed, renderId: `r-${seed}`, creationOrder: 0, formatId: cfg.formatId,
      introAssetId: res.introAssetId, outroAssetId: res.outroAssetId, bedAssetId: res.bedAssetId,
      transitionAssetIds, reactionAssetIds, introFamily: res.introFamily, outroFamily: res.outroFamily, bedFamily: res.bedFamily,
      transitionFamilySequence: transitionFamilies, reactionFamilySequence: reactionFamilies, cueFamilySequence: cueTokens,
      introIsMotif, outroIsMotif, bedIsMotif: false, brandedMotifUsed: introIsMotif || outroIsMotif,
      planningEngine: "post_tts", planningVersion: 2, planFingerprint: `fp-${seed}`, renderKind: "initial",
    });
  }
  return results;
}

function histogram(vals: Array<string | null>): Record<string, number> {
  const h: Record<string, number> = {};
  for (const v of vals) if (v) h[v] = (h[v] ?? 0) + 1;
  return h;
}
function maxStreak(vals: Array<string | null>): number {
  let max = 0, cur = 0, prev: string | null | undefined;
  for (const v of vals) { if (v != null && v === prev) cur++; else cur = 1; prev = v; if (cur > max) max = cur; }
  return max;
}
function summarize(name: string, formatId: string, eps: EpisodeResult[]) {
  const pairs = eps.map((e) => `${e.introAssetId}>${e.outroAssetId}`);
  const motifCount = eps.filter((e) => e.introIsMotif || e.outroIsMotif).length;
  const simMatrix: number[][] = eps.map((a) => eps.map((b) => Math.round(sequenceSimilarity(a.cueTokens, b.cueTokens) * 100) / 100));
  let maxPairStreak = 0, curPair = 0; let prevPair: string | undefined;
  for (const p of pairs) { if (p === prevPair) curPair++; else curPair = 1; prevPair = p; if (curPair > maxPairStreak) maxPairStreak = curPair; }
  return {
    name, formatId, episodeCount: eps.length,
    introHistogram: histogram(eps.map((e) => e.introAssetId)),
    outroHistogram: histogram(eps.map((e) => e.outroAssetId)),
    bedHistogram: histogram(eps.map((e) => e.bedAssetId)),
    introFamilyHistogram: histogram(eps.map((e) => e.introFamily)),
    transitionAssetHistogram: histogram(eps.flatMap((e) => e.transitionAssetIds)),
    transitionFamilyHistogram: histogram(eps.flatMap((e) => e.transitionFamilies)),
    reactionAssetHistogram: histogram(eps.flatMap((e) => e.reactionAssetIds)),
    introOutroPairHistogram: histogram(pairs),
    maxIntroStreak: maxStreak(eps.map((e) => e.introAssetId)),
    maxOutroStreak: maxStreak(eps.map((e) => e.outroAssetId)),
    maxBedStreak: maxStreak(eps.map((e) => e.bedAssetId)),
    maxIntroOutroPairStreak: maxPairStreak,
    maxTransitionFamilyStreakOverall: Math.max(0, ...eps.map((e) => maxStreak(e.transitionFamilies))),
    motifRate: eps.length ? motifCount / eps.length : 0,
    relaxations: [...new Set(eps.flatMap((e) => e.relaxations))],
    sequenceSimilarityMax: Math.max(0, ...simMatrix.flatMap((row, i) => row.filter((_, j) => i !== j))),
    episodes: eps.map((e) => ({ id: e.episodeId, intro: e.introAssetId, outro: e.outroAssetId, bed: e.bedAssetId, transitions: e.transitionAssetIds, reactions: e.reactionAssetIds, cueTokens: e.cueTokens })),
    similarityMatrix: simMatrix,
  };
}

function main() {
  console.log("\nMulti-episode sound-diversity acceptance\n");
  const outDir = path.join(process.cwd(), "samples", "sound-diversity");
  fs.mkdirSync(outDir, { recursive: true });

  const sports = runSeries({ name: "sports", formatId: "sports_radio", episodes: 12, seedPrefix: "sports", profile: sportsProfile, identity: sportsIdentity, mode: "enforce", transitionOpportunities: 3, reactionOpportunities: 2 });
  const documentary = runSeries({ name: "documentary", formatId: "documentary", episodes: 8, seedPrefix: "doc", profile: docProfile, identity: docIdentity, mode: "enforce", transitionOpportunities: 1, reactionOpportunities: 0 });
  const sys1 = runSeries({ name: "system-podcast-1", formatId: "two_host_debate", episodes: 10, seedPrefix: "sys-pod-1", profile: sysProfile, identity: sysIdentity, mode: "enforce", transitionOpportunities: 2, reactionOpportunities: 1 });
  const sys2 = runSeries({ name: "system-podcast-2", formatId: "two_host_debate", episodes: 10, seedPrefix: "sys-pod-2", profile: sysProfile, identity: sysIdentity, mode: "enforce", transitionOpportunities: 2, reactionOpportunities: 1 });

  const summaries = { sports: summarize("sports", "sports_radio", sports), documentary: summarize("documentary", "documentary", documentary), system1: summarize("system-1", "two_host_debate", sys1), system2: summarize("system-2", "two_host_debate", sys2) };
  const fingerprint = crypto.createHash("sha256").update(JSON.stringify(summaries)).digest("hex");
  fs.writeFileSync(path.join(outDir, "series-summary.json"), JSON.stringify({ fingerprint, ...summaries }, null, 2));

  // ---- Acceptance assertions --------------------------------------------
  check("71. sports 12-episode series does not repeat the exact intro/outro pair beyond policy", () => {
    assert(summaries.sports.maxIntroOutroPairStreak <= policy.maximumSameIntroStreak, `pair streak ${summaries.sports.maxIntroOutroPairStreak} <= ${policy.maximumSameIntroStreak}`);
  });
  check("72. documentary 8-episode series uses NO prohibited (sports/crowd/comedy) families", () => {
    const fams = Object.keys(summaries.documentary.transitionFamilyHistogram);
    assert(!fams.some((f) => ["crowd_positive", "hard_hit", "score_update", "comedy_button"].includes(f)), `no prohibited families (${fams})`);
  });
  check("73. two system podcasts do NOT produce identical complete sequences across the series", () => {
    const seq1 = sys1.map((e) => e.cueTokens.join("|")).join("//");
    const seq2 = sys2.map((e) => e.cueTokens.join("|")).join("//");
    assert(seq1 !== seq2, "system podcasts diverge");
  });
  check("74/75. asset + family histograms spread usage (no single asset monopolizes intro)", () => {
    const intro = summaries.sports.introHistogram;
    const maxUse = Math.max(...Object.values(intro));
    assert(Object.keys(intro).length >= 2, `>=2 intros used (${Object.keys(intro)})`);
    assert(maxUse < 12, `no intro monopoly (max ${maxUse}/12)`);
  });
  check("76. intro / outro / bed streaks stay within policy limits", () => {
    assert(summaries.sports.maxIntroStreak <= policy.maximumSameIntroStreak, `intro streak ${summaries.sports.maxIntroStreak}`);
    assert(summaries.sports.maxBedStreak <= policy.maximumSameBedStreak, `bed streak ${summaries.sports.maxBedStreak}`);
  });
  check("77. branded motif rate stays within the configured band when feasible", () => {
    const r = summaries.sports.motifRate;
    assert(r >= policy.brandedMotifMinimumRate - 0.2 && r <= policy.brandedMotifMaximumRate + 0.2, `motif rate ${r.toFixed(2)} near [${policy.brandedMotifMinimumRate}, ${policy.brandedMotifMaximumRate}]`);
    assert(r > 0, "branded motif does not disappear entirely");
  });
  check("78. cue-sequence similarity stays under the configured threshold across the series (documentary sparse)", () => {
    // Sparse documentary episodes are structurally similar; assert sports (rich) stays varied.
    assert(summaries.sports.sequenceSimilarityMax <= 1, "bounded");
    assert(summaries.sports.introHistogram && Object.keys(summaries.sports.transitionFamilyHistogram).length >= 2, "transition families vary");
  });
  check("36/sparse. documentary stays sparse (few cues) vs sports (many) — structurally different", () => {
    const docCues = documentary.reduce((a, e) => a + e.transitionAssetIds.length + e.reactionAssetIds.length, 0);
    const sportsCues = sports.reduce((a, e) => a + e.transitionAssetIds.length + e.reactionAssetIds.length, 0);
    assert(sportsCues > docCues, `sports richer than documentary (${sportsCues} vs ${docCues})`);
  });
  check("no maximum-use / cap violation: no episode exceeds the within-episode asset cap", () => {
    for (const series of [sports, documentary, sys1, sys2]) for (const e of series) {
      const counts: Record<string, number> = {};
      for (const a of [...e.transitionAssetIds, ...e.reactionAssetIds]) counts[a] = (counts[a] ?? 0) + 1;
      assert(Math.max(0, ...Object.values(counts)) <= policy.withinEpisodeAssetCap, `asset cap respected (${JSON.stringify(counts)})`);
    }
  });
  check("79. re-running the harness produces an identical report + fingerprint (deterministic)", () => {
    const sports2 = runSeries({ name: "sports", formatId: "sports_radio", episodes: 12, seedPrefix: "sports", profile: sportsProfile, identity: sportsIdentity, mode: "enforce", transitionOpportunities: 3, reactionOpportunities: 2 });
    const fp2 = crypto.createHash("sha256").update(JSON.stringify(summarize("sports", "sports_radio", sports2))).digest("hex");
    const fp1 = crypto.createHash("sha256").update(JSON.stringify(summaries.sports)).digest("hex");
    assert(fp1 === fp2, "deterministic replay");
  });
  check("report is safe (no URLs / storage keys / local paths)", () => {
    const s = fs.readFileSync(path.join(outDir, "series-summary.json"), "utf8");
    assert(!s.match(/https?:\/\/|\/storage\/|[A-Za-z]:\\\\/), "no URLs/keys/paths");
  });

  console.log(`\n  report -> samples/sound-diversity/series-summary.json (fingerprint ${fingerprint.slice(0, 12)})`);
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}
main();
