// Sound diversity / anti-repetition policy (PR 4). PURE + deterministic.
//
// A typed, BOUNDED policy that controls how the deterministic sound engine
// varies its selections across one episode, consecutive episodes, and a
// podcast's recent catalog — without destroying recognizable branding. The
// policy is resolved from code defaults + env overrides + the sonic identity
// (NOT baked into the identity/snapshot fingerprint, so historical v1–v5
// fingerprints stay byte-identical); only its VERSION + the resulting decision
// trace are frozen as non-fingerprinted material.
//
// Every numeric field is clamped to an explicit bound — there is no
// uncontrolled free-text policy, and an invalid value fails SAFE to the nearest
// bound rather than throwing.

import type { SonicIdentity } from "@/lib/audio/sonicIdentity";

export const SOUND_DIVERSITY_POLICY_VERSION = 1 as const;

/** Rollout enforcement mode (Part 12). off = prior behavior; observe = compute
 *  but do not apply; soft = penalties + relaxable soft rules; enforce = apply
 *  hard constraints (fail only when explicit policy requires). */
export type DiversityMode = "off" | "observe" | "soft" | "enforce";
export const DIVERSITY_MODES: readonly DiversityMode[] = ["off", "observe", "soft", "enforce"] as const;
export function isDiversityMode(x: unknown): x is DiversityMode {
  return typeof x === "string" && (DIVERSITY_MODES as readonly string[]).includes(x);
}

// --- Performance / safety bounds (Part 17) ---------------------------------
export const DIVERSITY_BOUNDS = {
  /** Hard ceiling on how many recent episodes any history read/scoring spans. */
  maxHistoryWindowEpisodes: 50,
  /** Hard ceiling on cue tokens tokenized per episode for similarity. */
  maxCueTokensPerEpisode: 64,
  /** Hard ceiling on candidate variants scored per role. */
  maxCandidatesPerRole: 32,
  /** Hard ceiling on pairwise sequence comparisons per selection. */
  maxSequenceComparisons: 64,
  /** Hard ceiling on rows a system-wide (cross-podcast) history read scans. */
  maxSystemHistoryRecords: 200,
  /** Hard ceiling on candidate decision records kept in a diagnostic. */
  maxDiagnosticCandidateRecords: 64,
} as const;

// --- Policy shape ----------------------------------------------------------
export interface SoundDiversityPolicy {
  version: number;

  historyWindowEpisodes: number;
  hardAssetCooldownEpisodes: number;
  softAssetCooldownEpisodes: number;
  familyCooldownEpisodes: number;

  maximumSameIntroStreak: number;
  maximumSameOutroStreak: number;
  maximumSameBedStreak: number;
  maximumSameTransitionFamilyStreak: number;
  maximumSameReactionFamilyStreak: number;

  minimumIntroVariantsBeforeRepeat: number;
  minimumOutroVariantsBeforeRepeat: number;
  minimumBedVariantsBeforeRepeat: number;

  brandedMotifMinimumRate: number;
  brandedMotifMaximumRate: number;

  assetReusePenalty: number;
  familyReusePenalty: number;
  sequenceSimilarityPenalty: number;
  recentEpisodePenalty: number;
  brandedContinuityBonus: number;
  formatCompatibilityBonus: number;
  identityCompatibilityBonus: number;

  withinEpisodeFamilyCap: number;
  withinEpisodeAssetCap: number;
  maximumCueSequenceSimilarity: number;

  systemCrossPodcastDiversityEnabled: boolean;
}

// --- Typed failures + relaxations (Part 16) --------------------------------
export type DiversityFailure =
  | "diversity_history_unavailable"
  | "diversity_history_invalid"
  | "hard_asset_cooldown_unsatisfied"
  | "hard_family_cooldown_unsatisfied"
  | "required_motif_unavailable"
  | "sequence_similarity_limit_unsatisfied"
  | "diversity_pool_exhausted"
  | "diversity_plan_invalid"
  | "diversity_snapshot_mismatch";

export type DiversityRelaxationCode =
  | "single_item_pool"
  | "insufficient_variants"
  | "soft_asset_cooldown_relaxed"
  | "soft_family_cooldown_relaxed"
  | "motif_minimum_unavailable"
  | "motif_maximum_unavoidable"
  | "sequence_similarity_relaxed"
  | "system_history_ignored"
  | "history_window_reduced";

export interface DiversityRelaxation { code: DiversityRelaxationCode; detail: string; subject?: string }

// --- Defaults --------------------------------------------------------------
// Goals: avoid immediate asset/intro/outro repeats when alternatives exist;
// avoid the same bed every episode; keep branded motifs recognizable without
// playing them everywhere; keep a high-weight asset preferred but not a
// permanent monopoly; keep sparse formats sparse; fail honestly on tiny pools.
export const DEFAULT_SOUND_DIVERSITY_POLICY: SoundDiversityPolicy = {
  version: SOUND_DIVERSITY_POLICY_VERSION,
  historyWindowEpisodes: 6,
  hardAssetCooldownEpisodes: 1,
  softAssetCooldownEpisodes: 3,
  familyCooldownEpisodes: 2,
  maximumSameIntroStreak: 1,
  maximumSameOutroStreak: 1,
  maximumSameBedStreak: 2,
  maximumSameTransitionFamilyStreak: 2,
  maximumSameReactionFamilyStreak: 2,
  minimumIntroVariantsBeforeRepeat: 2,
  minimumOutroVariantsBeforeRepeat: 2,
  minimumBedVariantsBeforeRepeat: 2,
  brandedMotifMinimumRate: 0.34,
  brandedMotifMaximumRate: 0.75,
  assetReusePenalty: 40,
  familyReusePenalty: 25,
  sequenceSimilarityPenalty: 30,
  recentEpisodePenalty: 15,
  brandedContinuityBonus: 20,
  formatCompatibilityBonus: 10,
  identityCompatibilityBonus: 10,
  withinEpisodeFamilyCap: 3,
  withinEpisodeAssetCap: 2,
  maximumCueSequenceSimilarity: 0.7,
  systemCrossPodcastDiversityEnabled: false,
};

// --- Field bounds ----------------------------------------------------------
type Bound = { min: number; max: number };
const B = (min: number, max: number): Bound => ({ min, max });
const NUMERIC_BOUNDS: Record<Exclude<keyof SoundDiversityPolicy, "version" | "systemCrossPodcastDiversityEnabled">, Bound> = {
  historyWindowEpisodes: B(0, DIVERSITY_BOUNDS.maxHistoryWindowEpisodes),
  hardAssetCooldownEpisodes: B(0, 20),
  softAssetCooldownEpisodes: B(0, 20),
  familyCooldownEpisodes: B(0, 20),
  maximumSameIntroStreak: B(1, 20),
  maximumSameOutroStreak: B(1, 20),
  maximumSameBedStreak: B(1, 20),
  maximumSameTransitionFamilyStreak: B(1, 20),
  maximumSameReactionFamilyStreak: B(1, 20),
  minimumIntroVariantsBeforeRepeat: B(1, 10),
  minimumOutroVariantsBeforeRepeat: B(1, 10),
  minimumBedVariantsBeforeRepeat: B(1, 10),
  brandedMotifMinimumRate: B(0, 1),
  brandedMotifMaximumRate: B(0, 1),
  assetReusePenalty: B(0, 100),
  familyReusePenalty: B(0, 100),
  sequenceSimilarityPenalty: B(0, 100),
  recentEpisodePenalty: B(0, 100),
  brandedContinuityBonus: B(0, 100),
  formatCompatibilityBonus: B(0, 100),
  identityCompatibilityBonus: B(0, 100),
  withinEpisodeFamilyCap: B(1, 50),
  withinEpisodeAssetCap: B(1, 50),
  maximumCueSequenceSimilarity: B(0, 1),
};

const clamp = (v: unknown, b: Bound, fallback: number): number => {
  const n = typeof v === "number" && Number.isFinite(v) ? v : fallback;
  return Math.min(b.max, Math.max(b.min, n));
};

/** Resolve the effective diversity policy: defaults, clamped to bounds, with
 *  optional overrides (from env / a future stored config). Invalid values fail
 *  SAFE to the default (then the bound). Pure + deterministic. `identity` only
 *  influences motif bounds when branded motifs are disabled. */
export function resolveSoundDiversityPolicy(opts?: {
  identity?: SonicIdentity | null;
  overrides?: Partial<SoundDiversityPolicy>;
}): SoundDiversityPolicy {
  const o = opts?.overrides ?? {};
  const out: SoundDiversityPolicy = { ...DEFAULT_SOUND_DIVERSITY_POLICY };
  for (const key of Object.keys(NUMERIC_BOUNDS) as Array<keyof typeof NUMERIC_BOUNDS>) {
    out[key] = clamp(o[key], NUMERIC_BOUNDS[key], DEFAULT_SOUND_DIVERSITY_POLICY[key]);
  }
  out.version = SOUND_DIVERSITY_POLICY_VERSION;
  out.systemCrossPodcastDiversityEnabled =
    typeof o.systemCrossPodcastDiversityEnabled === "boolean" ? o.systemCrossPodcastDiversityEnabled : DEFAULT_SOUND_DIVERSITY_POLICY.systemCrossPodcastDiversityEnabled;
  // A minimum can never exceed the maximum (keep the band coherent after clamps).
  if (out.brandedMotifMinimumRate > out.brandedMotifMaximumRate) out.brandedMotifMinimumRate = out.brandedMotifMaximumRate;
  // When the identity disables branded motifs, the motif band collapses to 0.
  if (opts?.identity && opts.identity.brandedMotifEnabled === false) {
    out.brandedMotifMinimumRate = 0;
    out.brandedMotifMaximumRate = 0;
  }
  return out;
}

/** Parse a Partial policy from env vars (all optional, all bounded on resolve).
 *  Names mirror the field names, screaming-snake-cased and prefixed. */
export function diversityPolicyOverridesFromEnv(env: NodeJS.ProcessEnv = process.env): Partial<SoundDiversityPolicy> {
  const num = (name: string): number | undefined => {
    const raw = env[name];
    if (raw == null || raw.trim() === "") return undefined;
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
  };
  const overrides: Partial<SoundDiversityPolicy> = {};
  const map: Array<[keyof SoundDiversityPolicy, string]> = [
    ["historyWindowEpisodes", "SOUND_DIVERSITY_HISTORY_WINDOW"],
    ["hardAssetCooldownEpisodes", "SOUND_DIVERSITY_HARD_ASSET_COOLDOWN"],
    ["softAssetCooldownEpisodes", "SOUND_DIVERSITY_SOFT_ASSET_COOLDOWN"],
    ["familyCooldownEpisodes", "SOUND_DIVERSITY_FAMILY_COOLDOWN"],
    ["maximumSameBedStreak", "SOUND_DIVERSITY_MAX_BED_STREAK"],
    ["maximumCueSequenceSimilarity", "SOUND_DIVERSITY_MAX_SEQUENCE_SIMILARITY"],
  ];
  for (const [field, envName] of map) {
    const v = num(envName);
    if (v !== undefined) (overrides as Record<string, number>)[field as string] = v;
  }
  return overrides;
}
