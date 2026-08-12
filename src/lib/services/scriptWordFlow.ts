// Where the words go — per-stage accounting of what a pipeline stage EMITTED
// against what survived into the shipped script.
//
// WHY THIS EXISTS. An episode measured on 2026-08-10 spent 88,042 output tokens
// to ship roughly 1,100 spoken words: about 42 generated tokens per delivered
// word. A per-stage COST ledger already exists (`costLedger.ts`) and answers
// "which stage spent it". It cannot answer the more useful question — "which
// stage spent it on something nobody ever hears" — because it counts tokens,
// not survival.
//
// The two are different in an important way. A stage that emits 4,000 words and
// ships 4,000 is expensive. A stage that emits 4,000 and ships 900 is WASTEFUL,
// and the remedy is not a cheaper model, it is a smaller ask. Only the second
// number tells you which one you are looking at, and nothing in this pipeline
// was recording it.
//
// Three kinds of loss are worth telling apart, so `record` takes a `kind`:
//
//   * "overhead"  — the stage ships nothing by design and never did. The turn
//                   plan is the case in point: pure scaffolding, billed twice
//                   (once written, once re-read by every writer call), zero
//                   spoken words. Its emitted words are 100% overhead and that
//                   is not a defect — but it should be VISIBLE, because it is
//                   where a surprising share of an episode's output lives.
//   * "selection" — the stage deliberately generates alternatives and keeps one.
//                   The cold-open tournament writes three candidates and ships
//                   one, so ~2/3 loss is the design working. Worth measuring so
//                   the price of the tournament is a known number rather than an
//                   assumption.
//   * "attrition" — the stage MEANT to ship what it emitted and did not. Lines
//                   dropped for foreign authorship, repeated text, unsupported
//                   claims, or a reverted director pass. This is the only kind
//                   that is straightforwardly bad, and the only one where a
//                   rising number means something is wrong.
//
// NETWORK-FREE, allocation-light, and it never throws: this is instrumentation,
// and instrumentation that can fail a run is worse than no instrumentation.

export type WordFlowKind = "overhead" | "selection" | "attrition" | "transform";

export interface WordFlowRow {
  stage: string;
  kind: WordFlowKind;
  /** Words the stage produced, including everything later discarded. */
  wordsEmitted: number;
  /** Words from this stage that are still present in the draft it handed on. */
  wordsKept: number;
  linesEmitted?: number;
  linesKept?: number;
  /** Free text for the specific reason lines went missing. */
  note?: string;
}

/** Spoken-word count for a set of lines. The one definition. */
export function wordsIn(lines: Array<{ text?: unknown }>): number {
  let total = 0;
  for (const line of lines) {
    const text = typeof line?.text === "string" ? line.text : "";
    // Bracketed production tags are not spoken, and counting them would inflate
    // exactly the number this module exists to keep honest.
    const spoken = text.replace(/\[[^\]]*\]/g, " ").trim();
    if (spoken) total += spoken.split(/\s+/).length;
  }
  return total;
}

/** Words in a single string, same rules. */
export function wordsInText(text: string): number {
  return wordsIn([{ text }]);
}

export class WordFlow {
  private readonly rows: WordFlowRow[] = [];

  record(row: WordFlowRow): void {
    this.rows.push(row);
  }

  /** Convenience for the common emitted/kept pair. */
  stage(
    stage: string,
    kind: WordFlowKind,
    emitted: Array<{ text?: unknown }>,
    kept: Array<{ text?: unknown }>,
    note?: string
  ): void {
    this.rows.push({
      stage,
      kind,
      wordsEmitted: wordsIn(emitted),
      wordsKept: wordsIn(kept),
      linesEmitted: emitted.length,
      linesKept: kept.length,
      note,
    });
  }

  all(): WordFlowRow[] {
    return [...this.rows];
  }

  totals(): { emitted: number; kept: number; lost: number; byKind: Record<WordFlowKind, number> } {
    const byKind: Record<WordFlowKind, number> = {
      overhead: 0,
      selection: 0,
      attrition: 0,
      transform: 0,
    };
    let emitted = 0;
    let kept = 0;
    for (const r of this.rows) {
      emitted += r.wordsEmitted;
      kept += r.wordsKept;
      byKind[r.kind] += Math.max(0, r.wordsEmitted - r.wordsKept);
    }
    return { emitted, kept, lost: Math.max(0, emitted - kept), byKind };
  }

  /**
   * A single log line per stage plus a total, in the shape the render checklist
   * greps for. Deliberately one block: an operator reading a job log should be
   * able to see the whole flow without correlating timestamps.
   */
  render(shippedWords: number): string {
    const t = this.totals();
    const pct = (n: number, d: number) => (d > 0 ? `${((n / d) * 100).toFixed(0)}%` : "—");
    const lines = [
      `[WordFlow] stage                     emitted   kept   lost  kind`,
    ];
    for (const r of this.rows) {
      const lost = Math.max(0, r.wordsEmitted - r.wordsKept);
      lines.push(
        `[WordFlow] ${r.stage.padEnd(24)} ${String(r.wordsEmitted).padStart(7)} ` +
          `${String(r.wordsKept).padStart(6)} ${String(lost).padStart(6)}  ${r.kind}` +
          (r.note ? ` — ${r.note}` : "")
      );
    }
    lines.push(
      `[WordFlow] TOTAL emitted ${t.emitted}, shipped ${shippedWords} ` +
        `(${pct(shippedWords, t.emitted)} survived). Lost: ` +
        `overhead ${t.byKind.overhead}, selection ${t.byKind.selection}, attrition ${t.byKind.attrition}.`
    );
    return lines.join("\n");
  }
}
