// Operator-facing diversity SUMMARIES (PR 4, Part 13). Safe: policy numbers,
// counts, modes, reasons only — never URLs, keys, paths, credentials, or another
// podcast's private usage. Narrow, not a full analytics dashboard.

import type { SoundDiversityPolicy } from "@/lib/audio/soundDiversityPolicy";
import type { DiversityRollout } from "@/lib/audio/soundDiversityFlags";
import type { DiversityHistory } from "@/lib/services/diversityHistory";

export interface PodcastDiversitySummary {
  rolloutMode: string;
  engineEnabled: boolean;
  systemHistoryEnabled: boolean;
  invalidMode: string | null;
  policyVersion: number;
  historyWindowEpisodes: number;
  hardAssetCooldownEpisodes: number;
  softAssetCooldownEpisodes: number;
  familyCooldownEpisodes: number;
  introOutroBedStreaks: { intro: number; outro: number; bed: number };
  motifBounds: { min: number; max: number };
  maxCueSequenceSimilarity: number;
  /** Recent asset-usage histogram (asset id -> count) within the window. */
  recentAssetUsage: Record<string, number>;
  /** Recent family-usage histogram (family -> count). */
  recentFamilyUsage: Record<string, number>;
  latestRelaxations: string[];
}

/** Build the podcast-level diversity summary an operator sees. History is
 *  optional (may be omitted when only the config is being shown). */
export function summarizePodcastDiversity(opts: {
  policy: SoundDiversityPolicy;
  rollout: DiversityRollout;
  history?: DiversityHistory;
}): PodcastDiversitySummary {
  const { policy, rollout } = opts;
  const recentAssetUsage: Record<string, number> = {};
  const recentFamilyUsage: Record<string, number> = {};
  for (const e of opts.history?.episodes ?? []) {
    for (const id of [e.introAssetId, e.outroAssetId, e.bedAssetId, ...e.transitionAssetIds, ...e.reactionAssetIds]) if (id) recentAssetUsage[id] = (recentAssetUsage[id] ?? 0) + 1;
    for (const f of [e.introFamily, e.outroFamily, e.bedFamily, ...e.transitionFamilySequence, ...e.reactionFamilySequence]) if (f) recentFamilyUsage[f] = (recentFamilyUsage[f] ?? 0) + 1;
  }
  return {
    rolloutMode: rollout.mode,
    engineEnabled: rollout.engineEnabled,
    systemHistoryEnabled: rollout.systemHistoryEnabled,
    invalidMode: rollout.invalidMode,
    policyVersion: policy.version,
    historyWindowEpisodes: policy.historyWindowEpisodes,
    hardAssetCooldownEpisodes: policy.hardAssetCooldownEpisodes,
    softAssetCooldownEpisodes: policy.softAssetCooldownEpisodes,
    familyCooldownEpisodes: policy.familyCooldownEpisodes,
    introOutroBedStreaks: { intro: policy.maximumSameIntroStreak, outro: policy.maximumSameOutroStreak, bed: policy.maximumSameBedStreak },
    motifBounds: { min: policy.brandedMotifMinimumRate, max: policy.brandedMotifMaximumRate },
    maxCueSequenceSimilarity: policy.maximumCueSequenceSimilarity,
    recentAssetUsage,
    recentFamilyUsage,
    latestRelaxations: [],
  };
}
