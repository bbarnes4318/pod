// Hard anti-repetition layer for generated scripts.
//
// Two distinct failure modes are covered:
//  1. INDEX COLLISIONS — the LLM restarts lineIndex numbering per segment.
//     AudioSegments are keyed (scriptId, lineIndex), so colliding lines all
//     map to ONE audio clip which the stitcher then inserts once per line:
//     the same sentence plays dozens of times in the final episode.
//     -> normalizeLineIndexes() assigns a single global, gap-free numbering.
//  2. CONTENT RESTATEMENT — the model says the same thing again in new
//     words (or verbatim). -> findRepetitions()/dedupeScriptLines() detect
//     near-duplicate lines via word-trigram Jaccard similarity and drop
//     everything after the first occurrence.

import { stripAudioTags } from "../audio/speechText";

export interface RepetitionHit {
  /** Global position (in flattened line order) of the repeated line. */
  index: number;
  /** Global position of the earlier line it duplicates. */
  ofIndex: number;
  similarity: number;
  text: string;
}

export interface RepetitionReport {
  totalLines: number;
  repeats: RepetitionHit[];
  /** repeats / totalLines — 0 is the target. */
  repetitionRatio: number;
}

function normalizeForComparison(text: string): string {
  return stripAudioTags(String(text))
    .toLowerCase()
    .replace(/[^a-z0-9\s']/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const STOPWORDS = new Set([
  "the", "and", "a", "an", "is", "are", "was", "were", "be", "been", "of", "in",
  "on", "at", "to", "for", "with", "that", "this", "these", "those", "it", "its",
  "he", "she", "they", "them", "his", "her", "their", "you", "your", "i", "we",
  "has", "have", "had", "do", "does", "did", "not", "no", "so", "but", "or",
  "if", "as", "by", "from", "about", "just", "like", "there", "here", "what",
]);

function stem(word: string): string {
  if (word.length <= 4) return word;
  return word.replace(/'s$/, "").replace(/(ing|ed|es|s)$/, "");
}

/** Content-word stems + "anchor" tokens (numbers and proper-noun-ish words). */
function contentProfile(originalText: string, normalized: string): { stems: Set<string>; anchors: Set<string> } {
  const stems = new Set<string>();
  for (const w of normalized.split(" ")) {
    if (!w || STOPWORDS.has(w)) continue;
    stems.add(stem(w));
  }
  const anchors = new Set<string>();
  for (const m of normalized.match(/\b(\d[\d,.]*|zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred)\b/g) || []) {
    anchors.add(m);
  }
  // Capitalized words not at the start of the line are proper-noun-ish
  const words = originalText.split(/\s+/);
  for (let i = 1; i < words.length; i++) {
    const w = words[i].replace(/[^A-Za-z]/g, "");
    if (w.length > 2 && /^[A-Z]/.test(w)) anchors.add(stem(w.toLowerCase()));
  }
  return { stems, anchors };
}

function trigrams(normalized: string): Set<string> {
  const words = normalized.split(" ").filter(Boolean);
  const grams = new Set<string>();
  if (words.length < 3) {
    if (normalized) grams.add(normalized);
    return grams;
  }
  for (let i = 0; i <= words.length - 3; i++) {
    grams.add(`${words[i]} ${words[i + 1]} ${words[i + 2]}`);
  }
  return grams;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const g of a) if (b.has(g)) inter++;
  return inter / (a.size + b.size - inter);
}

/**
 * Detect near-duplicate lines across the whole episode.
 *
 * - Long lines (>= 6 words): word-trigram Jaccard >= threshold marks a repeat.
 * - Short reaction lines ("Oh, come on."): exact normalized match allowed
 *   twice (humans do reuse tiny reactions), flagged from the 3rd occurrence.
 */
export function findRepetitions(
  texts: string[],
  opts: { similarityThreshold?: number } = {}
): RepetitionReport {
  const threshold = opts.similarityThreshold ?? 0.72;

  const kept: {
    index: number;
    normalized: string;
    grams: Set<string>;
    words: number;
    stems: Set<string>;
    anchors: Set<string>;
  }[] = [];
  const shortSeen = new Map<string, number[]>();
  const repeats: RepetitionHit[] = [];

  for (let i = 0; i < texts.length; i++) {
    const normalized = normalizeForComparison(texts[i]);
    const words = normalized.split(" ").filter(Boolean).length;

    if (words === 0) continue;

    if (words < 6) {
      // Tiny reaction line: exact-match budget of 2 occurrences.
      const prior = shortSeen.get(normalized) || [];
      if (prior.length >= 2) {
        repeats.push({ index: i, ofIndex: prior[0], similarity: 1, text: texts[i] });
      } else {
        prior.push(i);
        shortSeen.set(normalized, prior);
      }
      continue;
    }

    const grams = trigrams(normalized);
    const { stems, anchors } = contentProfile(texts[i], normalized);
    let hit: RepetitionHit | null = null;
    for (const prev of kept) {
      if (prev.words < 6) continue;

      // Path 1: verbatim / lightly-edited — trigram overlap.
      const sim = jaccard(grams, prev.grams);
      if (sim >= threshold) {
        hit = { index: i, ofIndex: prev.index, similarity: sim, text: texts[i] };
        break;
      }

      // Path 2: reworded restatement — same content words in a new order.
      // Containment of stemmed content words, requiring at least one shared
      // anchor (a number or proper noun) so topical overlap alone can't trip it.
      let stemInter = 0;
      for (const s of stems) if (prev.stems.has(s)) stemInter++;
      const containment = stemInter / Math.max(1, Math.min(stems.size, prev.stems.size));
      let anchorInter = 0;
      for (const a of anchors) if (prev.anchors.has(a)) anchorInter++;
      if (containment >= 0.6 && anchorInter >= 1 && Math.min(stems.size, prev.stems.size) >= 5) {
        hit = { index: i, ofIndex: prev.index, similarity: containment, text: texts[i] };
        break;
      }
    }

    if (hit) {
      repeats.push(hit);
    } else {
      kept.push({ index: i, normalized, grams, words, stems, anchors });
    }
  }

  const totalLines = texts.filter((t) => normalizeForComparison(t)).length;
  return {
    totalLines,
    repeats,
    repetitionRatio: totalLines === 0 ? 0 : repeats.length / totalLines,
  };
}

/**
 * Remove repeated lines from a segments[] structure (keeping first
 * occurrences), returning the cleaned structure plus a report.
 */
export function dedupeScriptSegments(segments: any[]): {
  segments: any[];
  removedCount: number;
  report: RepetitionReport;
} {
  const flat: { segIdx: number; lineIdx: number; text: string }[] = [];
  segments.forEach((seg, segIdx) => {
    (seg?.lines || []).forEach((line: any, lineIdx: number) => {
      flat.push({ segIdx, lineIdx, text: String(line?.text || "") });
    });
  });

  const report = findRepetitions(flat.map((f) => f.text));
  const dropPositions = new Set(report.repeats.map((r) => r.index));

  const cleaned = segments.map((seg, segIdx) => ({
    ...seg,
    lines: (seg?.lines || []).filter((_line: any, lineIdx: number) => {
      const flatPos = flat.findIndex((f) => f.segIdx === segIdx && f.lineIdx === lineIdx);
      return !dropPositions.has(flatPos);
    }),
  })).filter((seg) => (seg.lines || []).length > 0);

  return { segments: cleaned, removedCount: dropPositions.size, report };
}

/**
 * Assign a single global, gap-free lineIndex across all segments in order.
 * MUST run before persisting any script — audio segments are keyed by
 * (scriptId, lineIndex), and duplicate indexes cause one clip to be stitched
 * in for every colliding line (the catastrophic-repetition bug).
 */
export function normalizeLineIndexes(segments: any[]): { segments: any[]; hadCollisions: boolean } {
  const seen = new Set<number>();
  let hadCollisions = false;
  let counter = 0;

  for (const seg of segments) {
    if (!seg || !Array.isArray(seg.lines)) continue;
    for (const line of seg.lines) {
      if (!line || typeof line !== "object") continue;
      const idx = Number(line.lineIndex);
      if (!Number.isInteger(idx) || seen.has(idx)) hadCollisions = true;
      if (Number.isInteger(idx)) seen.add(idx);
      line.lineIndex = counter++;
    }
  }

  return { segments, hadCollisions };
}

/** True if any lineIndex appears more than once across all segments. */
export function hasLineIndexCollisions(segments: any[]): boolean {
  const seen = new Set<number>();
  for (const seg of segments) {
    if (!seg || !Array.isArray(seg.lines)) continue;
    for (const line of seg.lines) {
      const idx = Number(line?.lineIndex);
      if (seen.has(idx)) return true;
      seen.add(idx);
    }
  }
  return false;
}
