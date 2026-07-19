// Deterministic pre-snapshot DIVERSITY selection for intro/outro/bed (PR 4).
// PURE. Given the eligible frozen candidate pool, the diversity policy, the
// recent podcast history, and the episode seed, choose a variant that avoids
// mechanical repetition while preserving weighted branding — and record WHY.
//
// Determinism: a seeded mulberry32 stream (FNV-1a seed), the same PRNG family as
// the planner/variant selector. No Math.random, no wall-clock. Selection is
// reproducible from (candidates, policy, history, seed).
//
// It NEVER invents a candidate, never selects outside the given (already
// eligibility-filtered) pool, and never leaves a required bookend unselected
// when a valid candidate exists. When soft rules cannot all be satisfied it
// picks the least-bad valid candidate and records the relaxation; hard rules
// (immediate asset cooldown) are respected whenever an alternative exists.

import type { FrozenSoundAssetRef } from "@/lib/services/podcastSoundProfile";
import {
  type SoundDiversityPolicy, type DiversityMode, type DiversityRelaxationCode,
  DIVERSITY_BOUNDS, DIVERSITY_WEIGHT_SCALE,
} from "@/lib/audio/soundDiversityPolicy";
import { motifScoreDelta, type MotifAction } from "@/lib/audio/soundMotifContinuity";

// --- Decision records (Part 10) --------------------------------------------
export interface DiversityScoreEntry { code: string; amount: number }
export interface DiversityCandidateDecision {
  assetId: string;
  family: string | null;
  weight: number;
  score: number;
  excluded: boolean;
  exclusionReason: string | null;
  penalties: DiversityScoreEntry[];
  bonuses: DiversityScoreEntry[];
  recentUsageCount: number;
  lastUsedEpisodesAgo: number | null;   // 0 = the immediately previous episode
}
export interface DiversitySelectionDecision {
  role: "intro" | "outro" | "bed";
  selectedAssetId: string | null;
  reason: string;
  poolSize: number;
  eligibleCount: number;
  assetStreak: number;
  familyStreak: number;
  relaxations: DiversityRelaxationCode[];
  candidates: DiversityCandidateDecision[];
}

// --- FNV-1a + mulberry32 (identical family to variantSelection.ts) ----------
function fnv1a(s: string): number { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } return h >>> 0; }
function mulberry32(seed: number): () => number { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function weightedPick<T>(rand: () => number, pool: Array<{ item: T; weight: number }>): T | null {
  const c = pool.filter((p) => p.weight > 0);
  if (!c.length) return null;
  const total = c.reduce((a, p) => a + p.weight, 0);
  let roll = rand() * total;
  for (const p of c) { roll -= p.weight; if (roll <= 0) return p.item; }
  return c[c.length - 1].item;
}

/** Per-role recent history, newest first (index 0 = the immediately previous
 *  episode). Derived by the orchestrator from the podcast diversity history. */
export interface RoleHistoryView {
  /** assetId this role used in each recent episode, newest first (may be null). */
  assetIds: Array<string | null>;
  /** family this role used in each recent episode, newest first (may be null). */
  families: Array<string | null>;
}

export interface DiverseVariantInput {
  role: "intro" | "outro" | "bed";
  candidates: FrozenSoundAssetRef[]; // ALREADY format/identity eligible
  policy: SoundDiversityPolicy;
  mode: Exclude<DiversityMode, "off" | "observe">; // soft | enforce apply; off/observe handled upstream
  seed: string;
  history: RoleHistoryView;
  /** For the outro: the intro asset chosen this episode, to avoid repeating the
   *  exact intro/outro PAIR that the immediately previous episode used. */
  chosenIntroId?: string | null;
  /** For the outro pair check: prior episodes' (introId, outroId), newest first. */
  priorPairs?: Array<{ introId: string | null; outroId: string | null }>;
  /** A coherence bonus for a specific family (e.g. the outro family that brand-
   *  matches the chosen intro), applied to the candidate score. */
  familyBonus?: { family: string; amount: number };
  /** How branded-motif candidates should be biased (from the motif module). */
  motifAction?: MotifAction;
  /** Shared-system assets recently used SYSTEM-WIDE (cross-podcast), applied as a
   *  SOFT penalty only — never an exclusion (cannot starve a small podcast). */
  systemRecentAssetIds?: string[];
}

const roleStreakMax = (role: string, p: SoundDiversityPolicy) =>
  role === "intro" ? p.maximumSameIntroStreak : role === "outro" ? p.maximumSameOutroStreak : p.maximumSameBedStreak;
const roleMinVariants = (role: string, p: SoundDiversityPolicy) =>
  role === "intro" ? p.minimumIntroVariantsBeforeRepeat : role === "outro" ? p.minimumOutroVariantsBeforeRepeat : p.minimumBedVariantsBeforeRepeat;

/** How many of the most-recent episodes (from index 0) used `assetId` for this
 *  role consecutively (the current streak of that asset). */
function currentStreak(assetIds: Array<string | null>, assetId: string): number {
  let n = 0;
  for (const a of assetIds) { if (a === assetId) n++; else break; }
  return n;
}
/** Episodes-ago the asset was last used for this role (0 = previous), or null. */
function lastUsedAgo(assetIds: Array<string | null>, assetId: string): number | null {
  const i = assetIds.findIndex((a) => a === assetId);
  return i < 0 ? null : i;
}
/** Episodes-ago the family was last used, or null. */
function familyLastUsedAgo(families: Array<string | null>, family: string | null): number | null {
  if (family == null) return null;
  const i = families.findIndex((f) => f === family);
  return i < 0 ? null : i;
}

export interface DiverseVariantResult { selected: FrozenSoundAssetRef | null; decision: DiversitySelectionDecision }

/** Score + select one role's variant, diversity-aware. */
export function selectDiverseVariant(input: DiverseVariantInput): DiverseVariantResult {
  const { role, policy, mode, seed } = input;
  const enforce = mode === "enforce";
  const candidates = input.candidates.slice(0, DIVERSITY_BOUNDS.maxCandidatesPerRole);
  const relaxations: DiversityRelaxationCode[] = [];
  const eligibleCount = candidates.length;

  const emptyDecision = (reason: string): DiversitySelectionDecision => ({
    role, selectedAssetId: null, reason, poolSize: input.candidates.length, eligibleCount,
    assetStreak: 0, familyStreak: 0, relaxations, candidates: [],
  });

  if (candidates.length === 0) return { selected: null, decision: emptyDecision("no eligible variants in the frozen pool") };

  // One-item pool: diversity is impossible; select honestly, do not claim cooldown.
  if (candidates.length === 1) {
    relaxations.push("single_item_pool");
    const only = candidates[0];
    const streak = currentStreak(input.history.assetIds, only.assetId);
    return {
      selected: only,
      decision: {
        role, selectedAssetId: only.assetId, reason: "only variant in the frozen pool (diversity impossible)",
        poolSize: 1, eligibleCount: 1, assetStreak: streak,
        familyStreak: 0, relaxations,
        candidates: [{ assetId: only.assetId, family: only.cueFamily ?? null, weight: only.weight ?? 1, score: only.weight ?? 1, excluded: false, exclusionReason: null, penalties: [], bonuses: [], recentUsageCount: input.history.assetIds.filter((a) => a === only.assetId).length, lastUsedEpisodesAgo: lastUsedAgo(input.history.assetIds, only.assetId) }],
      },
    };
  }

  const streakMax = roleStreakMax(role, policy);
  const minVariants = roleMinVariants(role, policy);
  const lastEpisodePair = input.priorPairs?.[0] ?? null;

  interface Scored { ref: FrozenSoundAssetRef; d: DiversityCandidateDecision }
  const scored: Scored[] = candidates.map((ref) => {
    const weight = Math.max(0, ref.weight ?? 1);
    const penalties: DiversityScoreEntry[] = [];
    const bonuses: DiversityScoreEntry[] = [];
    const usedAgo = lastUsedAgo(input.history.assetIds, ref.assetId);
    const famAgo = familyLastUsedAgo(input.history.families, ref.cueFamily ?? null);
    const streak = currentStreak(input.history.assetIds, ref.assetId);
    const recentUsageCount = input.history.assetIds.filter((a) => a === ref.assetId).length;

    let excluded = false; let exclusionReason: string | null = null;
    const hardExclude = (r: string) => { if (!excluded) { excluded = true; exclusionReason = r; } };

    // HARD immediate asset cooldown — respected whenever an alternative exists.
    if (usedAgo != null && usedAgo < policy.hardAssetCooldownEpisodes) hardExclude(`hard asset cooldown (used ${usedAgo} episode(s) ago < ${policy.hardAssetCooldownEpisodes})`);
    // Streak limit: exclude in enforce, heavy penalty in soft.
    if (streak >= streakMax) {
      if (enforce) hardExclude(`same-${role} streak ${streak} >= ${streakMax}`);
      else penalties.push({ code: "streak", amount: policy.assetReusePenalty });
    }
    // min-variants-before-repeat: asset appeared within the last `minVariants`
    // distinct selections for this role.
    if (usedAgo != null && usedAgo < minVariants) {
      if (enforce) hardExclude(`repeat before ${minVariants} variants (used ${usedAgo} ago)`);
      else penalties.push({ code: "min_variants", amount: policy.assetReusePenalty });
    }
    // Exact intro/outro PAIR avoidance (outro only).
    if (role === "outro" && lastEpisodePair && lastEpisodePair.introId === (input.chosenIntroId ?? null) && lastEpisodePair.outroId === ref.assetId) {
      if (enforce) hardExclude("exact intro/outro pair repeats the previous episode");
      else penalties.push({ code: "exact_pair", amount: policy.assetReusePenalty });
    }

    // SOFT penalties (always applied to the score).
    if (usedAgo != null && usedAgo < policy.softAssetCooldownEpisodes) penalties.push({ code: "soft_asset_cooldown", amount: policy.assetReusePenalty * (1 - usedAgo / Math.max(1, policy.softAssetCooldownEpisodes)) });
    if (famAgo != null && famAgo < policy.familyCooldownEpisodes) penalties.push({ code: "family_cooldown", amount: policy.familyReusePenalty * (1 - famAgo / Math.max(1, policy.familyCooldownEpisodes)) });
    if (recentUsageCount > 0) penalties.push({ code: "recent_episode", amount: policy.recentEpisodePenalty * Math.min(1, recentUsageCount / Math.max(1, policy.historyWindowEpisodes)) });
    // Branded motif: the motif module's rate control decides the direction
    // (prefer below-min rate, penalize above-max, else the mild continuity nudge).
    if (ref.isBrandedMotif) {
      const delta = motifScoreDelta(input.motifAction ?? "neutral", policy);
      if (delta >= 0) bonuses.push({ code: "branded_motif", amount: delta });
      else penalties.push({ code: "branded_motif_overuse", amount: -delta });
    }
    // Brand-coherence: e.g. the outro family that matches the chosen intro.
    if (input.familyBonus && (ref.cueFamily ?? null) === input.familyBonus.family) bonuses.push({ code: "brand_match", amount: input.familyBonus.amount });
    // System-wide (cross-podcast) recency: a SOFT penalty for shared-system
    // assets heavily used across the platform. Never excludes.
    if (input.systemRecentAssetIds && input.systemRecentAssetIds.includes(ref.assetId)) penalties.push({ code: "system_recent", amount: policy.recentEpisodePenalty * 0.5 });

    const penaltySum = penalties.reduce((a, p) => a + p.amount, 0);
    const bonusSum = bonuses.reduce((a, b) => a + b.amount, 0);
    const score = Math.max(0, weight * DIVERSITY_WEIGHT_SCALE + bonusSum - penaltySum);
    return { ref, d: { assetId: ref.assetId, family: ref.cueFamily ?? null, weight, score, excluded, exclusionReason, penalties, bonuses, recentUsageCount, lastUsedEpisodesAgo: usedAgo } };
  });

  // Survivors = not hard-excluded. If none survive, RELAX: prefer the
  // least-recently-used candidate and record it (never invent, never fail here).
  let survivors = scored.filter((s) => !s.d.excluded);
  if (survivors.length === 0) {
    relaxations.push(enforce ? "insufficient_variants" : "soft_asset_cooldown_relaxed");
    // Re-admit all; pick the one used longest ago (or never).
    survivors = scored.map((s) => ({ ...s, d: { ...s.d, excluded: false, exclusionReason: null } }));
    survivors.sort((a, b) => (b.d.lastUsedEpisodesAgo ?? 999) - (a.d.lastUsedEpisodesAgo ?? 999));
  }

  // Deterministic weighted pick over survivors by score (min epsilon so a
  // fully-penalized-but-valid candidate can still appear). Weight remains a
  // preference: a higher base weight yields a higher score, hence higher
  // probability, without a permanent monopoly.
  const rand = mulberry32(fnv1a(`${seed}:diversity:${role}`));
  const picked = weightedPick(rand, survivors.map((s) => ({ item: s, weight: Math.max(0.001, s.d.score) })));
  const selectedRef = picked?.ref ?? survivors[0].ref;

  const selStreak = currentStreak(input.history.assetIds, selectedRef.assetId);
  const selFamStreak = (() => { let n = 0; for (const f of input.history.families) { if (f === (selectedRef.cueFamily ?? null) && f != null) n++; else break; } return n; })();

  return {
    selected: selectedRef,
    decision: {
      role, selectedAssetId: selectedRef.assetId,
      reason: relaxations.length ? `selected under relaxation (${relaxations.join(", ")})` : "diversity-weighted pick avoiding recent repeats",
      poolSize: input.candidates.length, eligibleCount, assetStreak: selStreak, familyStreak: selFamStreak,
      relaxations, candidates: scored.map((s) => s.d).slice(0, DIVERSITY_BOUNDS.maxDiagnosticCandidateRecords),
    },
  };
}
