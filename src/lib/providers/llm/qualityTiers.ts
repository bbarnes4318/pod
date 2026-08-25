// The quality tiers a user or admin can actually choose, and what each one
// honestly costs them.
//
// WHY THIS FILE EXISTS SEPARATELY FROM profiles.ts: a routing profile is an
// engineering artefact — twenty-one roles, provider chains, fallback order. A
// TIER is a product decision a non-engineer makes in a dropdown. Keeping the
// user-facing copy next to the routing map means the two can never drift, which
// is the failure mode that matters here: a tier whose label promises something
// its chain does not deliver.
//
// EVERY NUMBER BELOW IS MEASURED, not estimated. Costs are priced against the
// real token counts of episode ade82ba1 (a 3,125-word, 62-line episode) on the
// scoped cost ledger. Latencies are per-call probe results from 2026-08-15.
// When the routing changes, these change in the same commit.

import type { RoutingProfile } from "./profiles";

export type QualityTier = "free" | "balanced" | "premium";

export const QUALITY_TIERS: QualityTier[] = ["free", "balanced", "premium"];

export interface QualityTierInfo {
  id: QualityTier;
  /** The routing profile this tier selects. */
  profile: RoutingProfile;
  label: string;
  /** One line, plain language, no jargon. Shown under the label. */
  summary: string;
  /** Approximate USD per episode. null = genuinely no model spend. */
  approxCostUsd: number | null;
  /** Approximate minutes from "generate" to a finished script. */
  approxMinutes: [number, number];
  /**
   * SPEED WARNING — non-null means the surface MUST show it before the choice
   * is committed, not after.
   *
   * This is the whole reason the field exists. The free tier's writers answer in
   * 50s and 32s per call against roughly 1s on Opus, so a free episode spends
   * eight to ten minutes in the writing stages. A user who picks "Free" without
   * being told that will conclude the app has hung — and they will be right to,
   * because nothing on screen distinguishes "working" from "wedged". Cost is
   * discoverable after the fact; a ten-minute wait is not.
   */
  speedWarning: string | null;
  /** Who writes the audible dialogue, in words a user recognises. */
  writers: string;
  /**
   * Honest quality position. Sourced from EQ-Bench longform creative writing
   * (claude-opus-5 86.3, kimi-k2.6 78.5, z-ai/glm-5.2 77.9, deepseek-v4-flash
   * 66.0), which scores prose rather than benchmarks reasoning.
   */
  qualityNote: string;
  /** True when choosing this tier bills the operator's API accounts. */
  billable: boolean;
}

export const QUALITY_TIER_INFO: Record<QualityTier, QualityTierInfo> = {
  free: {
    id: "free",
    profile: "free_independent",
    label: "Free",
    summary: "No model costs. Noticeably slower, and the dialogue is rougher.",
    approxCostUsd: null,
    approxMinutes: [8, 12],
    speedWarning:
      "Takes about 8-12 minutes per episode — roughly ten times longer than the paid tiers. " +
      "This is normal for this tier, not a stall.",
    // GLM-5.2 was retired by NVIDIA on 2026-08-21 (410 Gone). The free tier's
    // Zhipu half is now GLM-4.7-flash on Z.ai direct — same lab, still free,
    // still a different family from DeepSeek, which is the property this pair
    // exists to have. Kept accurate because this string is shown in the picker.
    writers: "DeepSeek and GLM-4.7-flash (free tiers)",
    qualityNote:
      "Dialogue is more clichéd than the paid tiers, and one host noticeably more than the other.",
    billable: false,
  },
  balanced: {
    id: "balanced",
    profile: "balanced",
    label: "Balanced",
    summary: "Close to premium dialogue at a fraction of the cost. Fast.",
    approxCostUsd: 0.53,
    approxMinutes: [2, 4],
    speedWarning: null,
    // Same retirement as the free tier: the GLM half is now GLM-4.7-flash on
    // Z.ai direct rather than GLM-5.2 via NVIDIA.
    writers: "Kimi K2.6 and GLM-4.7-flash",
    qualityNote:
      "Slightly less polished than Premium, and hard to tell apart on most episodes.",
    billable: true,
  },
  premium: {
    id: "premium",
    // POINTS AT ITS OWN PROFILE NOW. This said `verified_development`, whose
    // host writers are Z.ai and Kimi — so the tier charged for Opus 5 and
    // routed the dialogue to free models, with Anthropic reachable only as a
    // paid FALLBACK after a free model failed. `writers` below was describing
    // a chain that did not exist. See premiumChain in profiles.ts.
    profile: "premium",
    label: "Premium",
    summary: "The best dialogue this app can produce. Fast.",
    // PRICED, NOT PICKED. $1.75 was carried over from the era when this tier
    // resolved to verified_development, and it survived the profile being
    // written because nobody re-derived it. Here is the derivation, from the
    // scoped generate:script ledger for episode ade82ba1 at Anthropic list
    // rates (Opus 5 $5/$25, Sonnet 5 $3/$15, Haiku 4.5 $1/$5 per MTok):
    //
    //   $1.26  Opus writers + Haiku everything else
    //          (docs/verification/tiering-option-a.md, the costed option (a))
    //  +$0.36  script_rewrite Haiku -> Opus   (selfverify-rewrite: $0.09 -> $0.45;
    //          it re-sends the transcript, so it is the single most expensive
    //          non-writer call in the job)
    //  +$0.10  script_dialogue_director Haiku -> Opus
    //  -$0.01  cold_open_judge Haiku -> Groq OSS small
    //   -----
    //   $1.71
    //
    // This briefly read $1.94, for a +$0.23 escalation of
    // script_debate_architect from Haiku to Sonnet. That escalation is reverted
    // — Sonnet returned a terminal programming_error on the role and ended
    // every Premium episode at role 2 of 7 (see premiumChain) — so the line is
    // gone from the arithmetic rather than left in as a number nobody spends.
    //
    // Rounded UP to the cent it actually reaches rather than down to the
    // familiar number. Roles outside generate:script — research_brief,
    // evidence_extraction, show_notes, episode_metadata — are not in this
    // ledger scope and are not billed to Anthropic by this profile.
    approxCostUsd: 1.71,
    // DERIVED FROM PER-CALL LATENCY, NOT YET MEASURED END-TO-END ON THIS MAP.
    // The 22 calls in the ledger scope now all run on Anthropic at ~1 s each
    // against the 60-200 s Nemotron calls they replace, which is what makes 2-4
    // minutes reachable at all — the previous premium chain left every one of
    // those calls on the free chain and took twenty minutes while claiming this
    // number. Re-measure on the first Premium run after this deploys and
    // correct it here if it is wrong; do not let it stand on inference twice.
    approxMinutes: [2, 4],
    speedWarning: null,
    writers: "Claude Opus 5 (both hosts)",
    qualityNote:
      "Highest-scoring writer available, with the least formulaic prose. " +
      "The whole script — structure, editing and fact-checking, not just the dialogue — runs on Claude.",
    billable: true,
  },
};

/** The tier a surface should preselect when nothing has been chosen. */
export const DEFAULT_QUALITY_TIER: QualityTier = "balanced";

export function isQualityTier(value: unknown): value is QualityTier {
  return typeof value === "string" && (QUALITY_TIERS as string[]).includes(value);
}

/** Parse a stored/submitted value, falling back rather than throwing. */
export function toQualityTier(value: unknown, fallback: QualityTier = DEFAULT_QUALITY_TIER): QualityTier {
  return isQualityTier(value) ? value : fallback;
}

export function tierInfo(tier: QualityTier): QualityTierInfo {
  return QUALITY_TIER_INFO[tier];
}

export function profileForTier(tier: QualityTier): RoutingProfile {
  return QUALITY_TIER_INFO[tier].profile;
}

/**
 * A short, honest cost string for a dropdown option.
 *
 * "Free" for the free tier rather than "$0.00", because a price of zero reads as
 * a rounding error where the word does not.
 */
export function formatTierCost(tier: QualityTier): string {
  const info = QUALITY_TIER_INFO[tier];
  return info.approxCostUsd === null ? "Free" : `~$${info.approxCostUsd.toFixed(2)} / episode`;
}

/** "~2-4 min" / "~8-12 min". */
export function formatTierDuration(tier: QualityTier): string {
  const [lo, hi] = QUALITY_TIER_INFO[tier].approxMinutes;
  return `~${lo}-${hi} min`;
}

/**
 * The one-line badge a compact surface shows next to the tier name.
 *
 * Deliberately leads with the DOWNSIDE for any tier that has one, because a
 * chooser that lists benefits first and caveats last is how a user ends up
 * surprised. For the free tier the badge says "slower" before it says "free".
 */
export function tierBadge(tier: QualityTier): string {
  const info = QUALITY_TIER_INFO[tier];
  return info.speedWarning
    ? `${formatTierDuration(tier)} · ${formatTierCost(tier)}`
    : `${formatTierCost(tier)} · ${formatTierDuration(tier)}`;
}
