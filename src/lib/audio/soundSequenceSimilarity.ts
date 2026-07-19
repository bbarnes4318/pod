// Cue-sequence tokenization + bounded similarity (PR 4, Part 6). PURE +
// deterministic. Represents an episode's sound as an ordered ROLE:family token
// stream and scores how similar two streams are, so the engine can prefer a plan
// less like recent episodes without heavyweight ML.
//
// Similarity is a bounded [0,1] blend of order-insensitive UNIGRAM Jaccard and
// order-sensitive BIGRAM Jaccard — cheap, explainable, and stable. Identical
// sequences score 1; disjoint sequences score 0.

import { DIVERSITY_BOUNDS } from "@/lib/audio/soundDiversityPolicy";

export interface SequenceCue { role: string; family: string | null }

/** ROLE:family tokens for an ordered cue list, bounded to the token ceiling. */
export function tokenizeCueSequence(cues: SequenceCue[]): string[] {
  const out: string[] = [];
  for (const c of cues) {
    if (out.length >= DIVERSITY_BOUNDS.maxCueTokensPerEpisode) break;
    out.push(`${c.role.toUpperCase()}:${c.family ?? "none"}`);
  }
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1; // two empty sequences are identical
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

function ngrams(tokens: string[], n: number): Set<string> {
  const s = new Set<string>();
  if (tokens.length < n) { if (n === 1) return s; return s; }
  for (let i = 0; i + n <= tokens.length; i++) s.add(tokens.slice(i, i + n).join(">"));
  return s;
}

/** Bounded [0,1] similarity of two token streams: mean of unigram Jaccard
 *  (which cues appear) and bigram Jaccard (in what order). Deterministic. */
export function sequenceSimilarity(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 1;
  const uni = jaccard(new Set(a), new Set(b));
  // Bigrams need >=2 tokens on both sides to be meaningful; otherwise fall back
  // to the unigram score so a 1-cue episode is comparable.
  if (a.length < 2 || b.length < 2) return Math.max(0, Math.min(1, uni));
  const bi = jaccard(ngrams(a, 2), ngrams(b, 2));
  return Math.max(0, Math.min(1, (uni + bi) / 2));
}

export interface SimilarityToHistory { maxSimilarity: number; mostSimilarIndex: number | null; comparisons: number; truncated: boolean }

/** The maximum similarity of `seq` to any of `historySequences` (newest first),
 *  bounded to `maxSequenceComparisons`. */
export function maxSimilarityToHistory(seq: string[], historySequences: string[][]): SimilarityToHistory {
  const limit = Math.min(historySequences.length, DIVERSITY_BOUNDS.maxSequenceComparisons);
  let max = 0, idx: number | null = null;
  for (let i = 0; i < limit; i++) {
    const s = sequenceSimilarity(seq, historySequences[i]);
    if (s > max) { max = s; idx = i; }
  }
  return { maxSimilarity: max, mostSimilarIndex: idx, comparisons: limit, truncated: historySequences.length > limit };
}

export interface SequenceSimilarityDecision {
  maxSimilarity: number;
  threshold: number;
  overThreshold: boolean;
  comparisons: number;
  mostSimilarIndex: number | null;
  relaxation: "sequence_similarity_relaxed" | null;
}

/** Evaluate a plan's cue-sequence against recent history vs the policy ceiling.
 *  The maximum similarity is a soft target: over it, we RECORD a relaxation
 *  (the within-episode cue diversity already reduces repetition; we never
 *  reorder semantically required cues, and there is no hard-similarity flag to
 *  fail on). Deterministic + bounded. */
export function evaluateSequenceSimilarity(seq: string[], historySequences: string[][], maxSimilarity: number): SequenceSimilarityDecision {
  const m = maxSimilarityToHistory(seq, historySequences);
  const over = m.maxSimilarity > maxSimilarity;
  return {
    maxSimilarity: m.maxSimilarity, threshold: maxSimilarity, overThreshold: over,
    comparisons: m.comparisons, mostSimilarIndex: m.mostSimilarIndex,
    relaxation: over ? "sequence_similarity_relaxed" : null,
  };
}
