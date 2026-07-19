// Within-episode CUE diversity (PR 4, Part 5). PURE + deterministic.
//
// PR 3's director decides WHETHER and WHERE a cue is structurally appropriate.
// This chooses WHICH eligible cue asset to place, avoiding mechanical repetition
// inside one episode (same reaction asset over and over, same transition family
// at every boundary) and across the recent catalog — without ever choosing an
// incompatible family merely for variety, and without turning a sparse format
// busy. A cue opportunity may deliberately remain EMPTY if every option is poor.
//
// Runs only on FRESH renders (the director). Reproduce replays the stored plan
// and never calls this. Uses the same FNV-1a/mulberry32 family.

import type { FrozenSoundAssetRef } from "@/lib/services/podcastSoundProfile";
import type { SoundDiversityPolicy, DiversityMode, DiversityRelaxationCode } from "@/lib/audio/soundDiversityPolicy";
import { DIVERSITY_BOUNDS } from "@/lib/audio/soundDiversityPolicy";

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

export interface CueDiversityCandidateDecision { assetId: string; family: string | null; score: number; excluded: boolean; reason: string | null }
export interface CueDiversityDecision {
  role: "transition" | "reaction";
  lineIndex: number;
  selectedAssetId: string | null;
  selectedFamily: string | null;
  reason: string;
  candidates: CueDiversityCandidateDecision[];
  relaxations: DiversityRelaxationCode[];
}

/** Running within-episode state the caller threads across cue placements. */
export interface WithinEpisodeCueState {
  assetCounts: Map<string, number>;
  familyCounts: Map<string, number>;
  lastAssetId: string | null;
  lastFamily: string | null;
}
export function newWithinEpisodeCueState(): WithinEpisodeCueState {
  return { assetCounts: new Map(), familyCounts: new Map(), lastAssetId: null, lastFamily: null };
}

export interface CrossEpisodeCueHistory {
  /** recent assetIds for this cue role, newest first (flattened across episodes). */
  recentAssetIds: string[];
  /** recent families for this cue role, newest first. */
  recentFamilies: string[];
}

export interface DiverseCueInput {
  role: "transition" | "reaction";
  lineIndex: number;
  candidates: FrozenSoundAssetRef[]; // ALREADY family/format/identity permitted
  policy: SoundDiversityPolicy;
  mode: Exclude<DiversityMode, "off" | "observe">;
  seed: string;
  within: WithinEpisodeCueState;
  history: CrossEpisodeCueHistory;
}

export interface DiverseCueResult { selected: FrozenSoundAssetRef | null; decision: CueDiversityDecision }

/** Choose the least-repetitive eligible cue asset (or none). Mutates nothing —
 *  the caller updates the within-episode state after a placement. */
export function selectDiverseCue(input: DiverseCueInput): DiverseCueResult {
  const { role, policy, mode, within } = input;
  const enforce = mode === "enforce";
  const candidates = input.candidates.slice(0, DIVERSITY_BOUNDS.maxCandidatesPerRole);
  const relaxations: DiversityRelaxationCode[] = [];
  const decisions: CueDiversityCandidateDecision[] = [];

  if (candidates.length === 0) {
    return { selected: null, decision: { role, lineIndex: input.lineIndex, selectedAssetId: null, selectedFamily: null, reason: "no permitted cue asset", candidates: [], relaxations } };
  }

  interface Scored { ref: FrozenSoundAssetRef; score: number; excluded: boolean }
  const scored: Scored[] = candidates.map((ref) => {
    const family = ref.cueFamily ?? null;
    const usedInEp = within.assetCounts.get(ref.assetId) ?? 0;
    const famInEp = family ? within.familyCounts.get(family) ?? 0 : 0;
    const weight = Math.max(0, ref.weight ?? 1);
    let excluded = false; let reason: string | null = null;
    const exclude = (r: string) => { if (!excluded) { excluded = true; reason = r; } };

    // Hard within-episode caps (apply in both soft + enforce — cheap to honor).
    if (usedInEp >= policy.withinEpisodeAssetCap) exclude(`within-episode asset cap ${policy.withinEpisodeAssetCap} reached`);
    if (family && famInEp >= policy.withinEpisodeFamilyCap) exclude(`within-episode family cap ${policy.withinEpisodeFamilyCap} reached`);
    // Per-assignment maximum uses per episode.
    if (ref.maxUsesPerEpisode != null && usedInEp >= ref.maxUsesPerEpisode) exclude(`assignment maxUsesPerEpisode ${ref.maxUsesPerEpisode} reached`);
    // Cross-episode min cooldown for this asset.
    const crossAgo = input.history.recentAssetIds.indexOf(ref.assetId);
    if (ref.minEpisodeCooldown != null && crossAgo >= 0 && crossAgo < ref.minEpisodeCooldown) {
      if (enforce) exclude(`asset cross-episode cooldown (${crossAgo} < ${ref.minEpisodeCooldown})`);
    }

    let score = weight;
    const penalties: string[] = [];
    // Avoid repeating the SAME asset back-to-back (esp. reactions).
    if (within.lastAssetId === ref.assetId) { score -= policy.assetReusePenalty; penalties.push("same_as_last_asset"); }
    // Avoid the SAME family at every boundary; prefer a different compatible one.
    if (family && within.lastFamily === family) { score -= policy.familyReusePenalty; penalties.push("same_as_last_family"); }
    else if (family && within.lastFamily && within.lastFamily !== family) { score += policy.familyReusePenalty * 0.5; }
    // Within-episode reuse penalty (each prior use).
    if (usedInEp > 0) { score -= policy.assetReusePenalty * usedInEp; penalties.push("used_in_episode"); }
    if (family && famInEp > 0) { score -= policy.familyReusePenalty * famInEp; }
    // Cross-episode recency (soft).
    if (crossAgo >= 0) { score -= policy.recentEpisodePenalty * (1 - crossAgo / Math.max(1, policy.historyWindowEpisodes)); }
    const famCrossAgo = family ? input.history.recentFamilies.indexOf(family) : -1;
    if (famCrossAgo >= 0 && famCrossAgo < policy.familyCooldownEpisodes) { score -= policy.familyReusePenalty * (1 - famCrossAgo / Math.max(1, policy.familyCooldownEpisodes)); }

    decisions.push({ assetId: ref.assetId, family, score, excluded, reason: excluded ? reason : (penalties.length ? penalties.join(",") : null) });
    return { ref, score: Math.max(0, score), excluded };
  });

  const survivors = scored.filter((s) => !s.excluded);
  if (survivors.length === 0) {
    // Every option is capped/cooled. A cue opportunity may remain EMPTY rather
    // than force a poor, repetitive choice — that is a valid, honest outcome.
    return { selected: null, decision: { role, lineIndex: input.lineIndex, selectedAssetId: null, selectedFamily: null, reason: "all candidates exceed within-episode caps / cooldowns — opportunity left empty", candidates: decisions, relaxations } };
  }

  const rand = mulberry32(fnv1a(`${input.seed}:cue:${role}:${input.lineIndex}`));
  const picked = weightedPick(rand, survivors.map((s) => ({ item: s.ref, weight: Math.max(0.001, s.score) })));
  const selected = picked ?? survivors[0].ref;
  return {
    selected,
    decision: { role, lineIndex: input.lineIndex, selectedAssetId: selected.assetId, selectedFamily: selected.cueFamily ?? null, reason: "diversity-weighted cue pick (within-episode + recent-catalog aware)", candidates: decisions.slice(0, DIVERSITY_BOUNDS.maxDiagnosticCandidateRecords), relaxations },
  };
}

/** Update the running state after a cue is placed. */
export function recordCuePlacement(state: WithinEpisodeCueState, assetId: string, family: string | null): void {
  state.assetCounts.set(assetId, (state.assetCounts.get(assetId) ?? 0) + 1);
  if (family) state.familyCounts.set(family, (state.familyCounts.get(family) ?? 0) + 1);
  state.lastAssetId = assetId;
  state.lastFamily = family;
}
