// Branded-motif continuity control (PR 4, Part 8). PURE + deterministic.
//
// A branded motif should create recognition without becoming exhausting. This
// measures the motif's RECENT usage rate from history and decides whether the
// engine should PREFER it (recent rate below the minimum), PENALIZE it (above
// the maximum), or stay NEUTRAL — biasing the intro/outro/bed selection
// accordingly. Honest edge cases: no eligible motif -> "unavailable"; a pool
// whose only candidate is the motif -> "unavoidable" overuse (reported, not
// hidden). Format/role restrictions are respected by the caller (the candidate
// pool is already format/identity-eligible).

import type { FrozenSoundAssetRef } from "@/lib/services/podcastSoundProfile";
import type { SoundDiversityPolicy } from "@/lib/audio/soundDiversityPolicy";
import type { MotifContinuityDecision } from "@/lib/audio/soundDiversity";

export type MotifAction = MotifContinuityDecision["action"];

/** Recent motif usage rate for a role: fraction of the recent episodes whose
 *  selection for that role was a branded motif. */
export function recentMotifRate(usedMotif: Array<boolean>): number {
  if (usedMotif.length === 0) return 0;
  return usedMotif.filter(Boolean).length / usedMotif.length;
}

/** Decide how to treat branded motifs for a role given the recent rate + policy
 *  + whether the eligible pool even contains a motif. Deterministic. */
export function evaluateMotifContinuity(opts: {
  role: "intro" | "outro" | "bed";
  candidates: FrozenSoundAssetRef[]; // already format/identity eligible
  recentMotifUsage: boolean[];       // newest first, one per recent episode
  policy: SoundDiversityPolicy;
}): MotifContinuityDecision {
  const { role, candidates, policy } = opts;
  const min = policy.brandedMotifMinimumRate;
  const max = policy.brandedMotifMaximumRate;
  const rate = recentMotifRate(opts.recentMotifUsage);
  const motifs = candidates.filter((c) => c.isBrandedMotif);
  const nonMotifs = candidates.filter((c) => !c.isBrandedMotif);

  const base = { role, recentRate: rate, minimumRate: min, maximumRate: max } as const;

  // Motifs disabled by policy (band collapsed to 0) or none eligible.
  if (max <= 0) return { ...base, action: "neutral", reason: "branded motifs disabled by policy/identity" };
  if (motifs.length === 0) return { ...base, action: "unavailable", reason: "no eligible branded motif in the frozen pool" };
  // The pool offers ONLY motifs: overuse is unavoidable — report it honestly.
  if (nonMotifs.length === 0) return { ...base, action: "unavoidable", reason: "every eligible variant is the branded motif (overuse unavoidable)" };

  if (rate < min) return { ...base, action: "prefer", reason: `recent motif rate ${rate.toFixed(2)} below minimum ${min} — prefer the motif` };
  if (rate > max) return { ...base, action: "penalize", reason: `recent motif rate ${rate.toFixed(2)} above maximum ${max} — penalize the motif` };
  return { ...base, action: "neutral", reason: `recent motif rate ${rate.toFixed(2)} within [${min}, ${max}]` };
}

/** Score delta applied to a branded-motif candidate for a motif action. Used by
 *  the selection scorer so motif rate steers WHICH variant wins deterministically. */
export function motifScoreDelta(action: MotifAction, policy: SoundDiversityPolicy): number {
  switch (action) {
    case "prefer": return policy.brandedContinuityBonus * 2;
    case "penalize": return -policy.brandedContinuityBonus * 2;
    case "neutral": return policy.brandedContinuityBonus; // the mild default continuity nudge
    case "unavoidable": return 0; // no point biasing a forced choice
    case "unavailable": return 0;
  }
}
