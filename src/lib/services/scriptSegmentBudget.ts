// Spoken-word ceilings that belong to a SEGMENT, enforced where a rewrite is
// committed rather than where it is requested.
//
// The cold-open tournament validates every finalist at 80-120 spoken words
// (scriptCreativePipeline.coldOpenLineContract) and the production gate
// re-measures that same number on the FINAL segments
// (productionInvariants.coldOpenQuality). In between, three separate passes
// rewrite individual lines — deterministic grounding, semantic grounding, and
// conversation repair — and every one of them bounded growth PER LINE while
// nothing at all bounded the SEGMENT.
//
// rewriteWordBudget's flat +3 is the right per-line allowance, and
// testRewriteBudget already proves it cannot compound proportionally. What that
// test could not express is that the flat allowance still SUMS: six lines each
// taking +3 is +18 on a segment whose ceiling had no headroom left. Its own
// final assertion records the worst case as `COLD_OPEN_MAX_WORDS + 18` — a
// documented overrun, not a prevented one.
//
// Script 9a8b00a3 was held at 126 words against a 120 ceiling: a cold open that
// left the tournament in band and was pushed out of it by two grounding
// rewrites, after all seven writing roles had already been paid for.
//
// The rule here is the one the per-line check already implements, lifted one
// level: a rewrite that would push its segment past the ceiling is REJECTED and
// the original line stands. The original is already written, already in band,
// and already flagged for human review if it had a grounding problem — keeping
// it costs nothing this pass had earned, and an unresolved flag on one line is
// strictly better than an episode nobody can release.
//
// A segment that is ALREADY over its ceiling is a separate case: there, a
// rewrite is accepted as long as it does not make the overrun worse. Refusing
// every rewrite in an over-budget segment would disable grounding exactly where
// the writing is most likely to need it.

import { COLD_OPEN_MAX_WORDS, spokenWords } from "./productionInvariants";

/**
 * Segment types whose spoken-word total is a downstream HOLD, keyed to the same
 * constant the gate measures against. A type absent from this table has no hard
 * ceiling and its lines are bounded only by the per-line rewrite budget.
 */
export const SEGMENT_WORD_CEILINGS: Readonly<Record<string, number>> = {
  cold_open: COLD_OPEN_MAX_WORDS,
};

export function segmentWordCeiling(segmentType: unknown): number | null {
  const key = typeof segmentType === "string" ? segmentType.trim() : "";
  return Object.prototype.hasOwnProperty.call(SEGMENT_WORD_CEILINGS, key)
    ? SEGMENT_WORD_CEILINGS[key]
    : null;
}

interface SegmentLike {
  type?: unknown;
  lines?: Array<{ lineIndex?: unknown; text?: unknown }> | null;
}

export interface SegmentBudgetRejection {
  lineIndex: number;
  segmentType: string;
  ceiling: number;
  segmentTotal: number;
  attemptedWords: number;
  allowedWords: number;
}

/**
 * Running spoken-word accounting for one script, so a chain of independent
 * rewrite passes cannot each stay inside its own budget while collectively
 * blowing a segment's.
 *
 * Constructed from the segments as they stand, then mutated as rewrites are
 * committed. Deliberately keyed by `lineIndex`, which is the identifier every
 * rewrite path already carries.
 */
export class SegmentBudgetLedger {
  private readonly ceilings = new Map<number, { ceiling: number; total: number; type: string }>();
  private readonly lineToSegment = new Map<number, number>();
  private readonly lineWords = new Map<number, number>();
  private readonly rejections: SegmentBudgetRejection[] = [];

  constructor(segments: SegmentLike[] | null | undefined) {
    (Array.isArray(segments) ? segments : []).forEach((segment, segmentIndex) => {
      const ceiling = segmentWordCeiling(segment?.type);
      let total = 0;
      for (const line of segment?.lines || []) {
        const words = spokenWords(typeof line?.text === "string" ? line.text : "").length;
        total += words;
        if (typeof line?.lineIndex === "number") {
          this.lineToSegment.set(line.lineIndex, segmentIndex);
          this.lineWords.set(line.lineIndex, words);
        }
      }
      if (ceiling !== null) {
        this.ceilings.set(segmentIndex, {
          ceiling,
          total,
          type: typeof segment?.type === "string" ? segment.type : "",
        });
      }
    });
  }

  private budgetFor(lineIndex: number) {
    const segmentIndex = this.lineToSegment.get(lineIndex);
    if (segmentIndex === undefined) return null;
    return this.ceilings.get(segmentIndex) ?? null;
  }

  /** True when this line sits in a segment carrying a hard spoken-word ceiling. */
  isBudgeted(lineIndex: number): boolean {
    return this.budgetFor(lineIndex) !== null;
  }

  /**
   * The most spoken words this line may occupy without putting its segment over
   * its ceiling; `null` when the line's segment has no ceiling.
   *
   * Never returns less than the line's CURRENT length: in an already-over
   * segment the honest instruction is "do not grow this line", not "write an
   * impossible line".
   */
  maxWordsFor(lineIndex: number): number | null {
    const budget = this.budgetFor(lineIndex);
    if (!budget) return null;
    const own = this.lineWords.get(lineIndex) ?? 0;
    return Math.max(own, budget.ceiling - budget.total + own);
  }

  /**
   * Commit a rewrite against the ledger.
   *
   * Returns false when the rewrite would push its segment past the ceiling
   * (and would make an already-over segment worse) — the caller must then keep
   * the original line, exactly as it does for a per-line budget overrun.
   */
  accept(lineIndex: number, newText: string): boolean {
    const budget = this.budgetFor(lineIndex);
    const next = spokenWords(newText).length;
    if (!budget) {
      this.lineWords.set(lineIndex, next);
      return true;
    }
    const own = this.lineWords.get(lineIndex) ?? 0;
    const projected = budget.total - own + next;
    // Over the ceiling is only fatal when it is also a REGRESSION. A segment
    // that arrived over budget still gets its grounding, as long as each
    // rewrite leaves it no worse than it found it.
    if (projected > budget.ceiling && projected > budget.total) {
      this.rejections.push({
        lineIndex,
        segmentType: budget.type,
        ceiling: budget.ceiling,
        segmentTotal: budget.total,
        attemptedWords: next,
        allowedWords: Math.max(own, budget.ceiling - budget.total + own),
      });
      return false;
    }
    budget.total = projected;
    this.lineWords.set(lineIndex, next);
    return true;
  }

  /** Rewrites refused because they would have broken a segment ceiling. */
  getRejections(): SegmentBudgetRejection[] {
    return [...this.rejections];
  }

  /** Current spoken-word total per budgeted segment type — for logging. */
  totals(): Array<{ segmentType: string; total: number; ceiling: number }> {
    return Array.from(this.ceilings.values()).map((b) => ({
      segmentType: b.type,
      total: b.total,
      ceiling: b.ceiling,
    }));
  }
}
