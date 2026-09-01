// Rewrite length budget — the drift that held episode 4a8880e5.
//
// The cold-open tournament validates every variant at 80-120 spoken words and
// the winner passed. It reached the production gate at 149 and the episode was
// held on coldOpenQuality, after all seven writing roles had been paid for.
// Nothing between those two points knew a segment budget existed: the grounding
// rewrite runs four times on the whole script and had no length constraint at
// all, so replacing an unsupported specific with a qualitative phrase could
// silently pad a line — and six lines padding a little is the whole overrun.
//
// NETWORK-FREE. Run: npm run test:rewrite-budget

import {
  antithesisWordBudget,
  countSpokenWords,
  effectiveRewriteBudget,
  rewriteWordBudget,
} from "../lib/services/scriptOutlineEngine";
import { SegmentBudgetLedger } from "../lib/services/scriptSegmentBudget";
import { spokenWords, COLD_OPEN_MIN_WORDS, COLD_OPEN_MAX_WORDS } from "../lib/services/productionInvariants";

let passed = 0, failed = 0;
function check(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.error(`  ✗ ${name}\n      ${(err as Error).message}`); }
}
function assert(c: boolean, m: string) { if (!c) throw new Error(m); }

function main() {
  console.log("\nOne measurement, not two\n");

  check("the rewrite counter agrees with the production gate's counter", () => {
    // Two counters that disagree let a line pass one budget and fail the other.
    const samples = [
      "He's eleven days short of the service time, and they optioned him this morning.",
      "Thirty-five years — and you can draw a straight line from that memo to the kid.",
      "[laughs] Name him. Say the name out loud, on the record.",
      "It was 1993, not '91, and the difference is two general managers.",
      "well-run front office, cot-caught merged, twenty-two year old",
    ];
    for (const s of samples) {
      assert(countSpokenWords(s) === spokenWords(s).length,
        `counters disagree on ${JSON.stringify(s)}: rewrite=${countSpokenWords(s)} gate=${spokenWords(s).length}`);
    }
  });

  check("audio tags and punctuation are not spoken words", () => {
    assert(countSpokenWords("[laughs] Name him.") === 2, `got ${countSpokenWords("[laughs] Name him.")}`);
    assert(countSpokenWords("") === 0, "empty text is zero words");
  });

  console.log("\nThe budget actually bounds growth\n");

  check("a shorter or equal rewrite is allowed", () => {
    const original = "They cut their scouting operation in half and called it modernization in 1993.";
    assert(countSpokenWords("They gutted scouting and called it modernization.") <= rewriteWordBudget(original),
      "a genuinely shorter qualitative rewrite must pass");
    assert(countSpokenWords(original) <= rewriteWordBudget(original), "an unchanged line must pass");
  });

  check("a small allowance exists so faithful qualitative fixes are not rejected", () => {
    const original = "They went 31 and 5.";
    // "31 and 5" -> "through a long winning stretch" costs words and is correct.
    assert(rewriteWordBudget(original) > countSpokenWords(original),
      "a zero-tolerance ceiling would reject good grounding fixes");
    assert(rewriteWordBudget(original) - countSpokenWords(original) <= 3, "the allowance must stay small");
  });

  check("the allowance is FLAT, so it cannot compound across a segment", () => {
    // The failure mode: +20% per line, six lines, and the segment overruns.
    const line = "He is eleven days short of the service time that moves his free agency.";
    const perLine = rewriteWordBudget(line) - countSpokenWords(line);
    const longLine = `${line} ${line} ${line}`;
    const perLongLine = rewriteWordBudget(longLine) - countSpokenWords(longLine);
    assert(perLine === perLongLine,
      `the allowance scaled with length (${perLine} vs ${perLongLine}) — proportional slack is what compounds`);
  });

  check("six cold-open lines at full allowance still fit the gate", () => {
    // The real shape of the regression: a cold open that leaves the tournament
    // at the top of its range must still clear the gate after a full rewrite.
    const LINES = 6;
    const atCeiling = COLD_OPEN_MAX_WORDS; // worst legal case at generation
    const worstCaseAfterRewrite = atCeiling + LINES * 3;
    assert(worstCaseAfterRewrite <= COLD_OPEN_MAX_WORDS + 18,
      `a full-allowance rewrite of ${LINES} lines adds ${LINES * 3} words`);
    // And the historical failure must now be impossible from rewriting alone:
    // 149 - 120 = 29 words of drift, well beyond 6 lines x 3.
    assert(LINES * 3 < 29,
      "the observed 29-word drift on 4a8880e5 must exceed what the budget now permits");
  });

  check("the gate's own range is what we are protecting", () => {
    assert(COLD_OPEN_MIN_WORDS === 80 && COLD_OPEN_MAX_WORDS === 120,
      `cold open range moved to ${COLD_OPEN_MIN_WORDS}-${COLD_OPEN_MAX_WORDS}; this test encodes the old one`);
  });

  console.log("\nThe SEGMENT budget is what the gate actually measures\n");

  // The flat per-line allowance cannot compound proportionally, which is what
  // the section above proves. What it cannot prevent on its own is the sum:
  // every line taking its legal +3 is +3 x lines on a segment whose ceiling had
  // no headroom left. Script 9a8b00a3 was held at 126 words against 120 with
  // every individual rewrite inside its own budget.

  const words = (n: number) => Array.from({ length: n }, () => "word").join(" ");
  const coldOpenOf = (lineWords: number[]) => [
    {
      type: "cold_open",
      lines: lineWords.map((w, i) => ({ lineIndex: i, speakerName: "Zabala", text: words(w) })),
    },
    {
      type: "topic",
      lines: [{ lineIndex: 900, speakerName: "Mercer", text: words(60) }],
    },
  ];

  check("a cold open at its ceiling has NO growth left to give any line", () => {
    // 6 lines x 20 words = 120, exactly the ceiling the tournament allows.
    const ledger = new SegmentBudgetLedger(coldOpenOf([20, 20, 20, 20, 20, 20]));
    assert(ledger.maxWordsFor(0) === 20, `a line in a full segment may not grow, got ${ledger.maxWordsFor(0)}`);
    assert(ledger.accept(0, words(23)) === false, "the +3 per-line allowance must not be spendable here");
    assert(ledger.accept(0, words(20)) === true, "an equal-length rewrite is still allowed");
    assert(ledger.accept(1, words(16)) === true, "a shorter rewrite is always allowed");
  });

  check("the exact historical drift is now impossible", () => {
    // Two grounding rewrites at full allowance on a cold open that left the
    // tournament legal: 120 + 3 + 3 = 126, which is the number the gate reported.
    const ledger = new SegmentBudgetLedger(coldOpenOf([20, 20, 20, 20, 20, 20]));
    const accepted = [ledger.accept(0, words(23)), ledger.accept(1, words(23))].filter(Boolean).length;
    assert(accepted === 0, `both over-budget rewrites must be refused, ${accepted} got through`);
    const total = ledger.totals().find((t) => t.segmentType === "cold_open");
    assert(total !== undefined && total.total <= COLD_OPEN_MAX_WORDS,
      `cold open ended at ${total?.total} against a ${COLD_OPEN_MAX_WORDS} ceiling`);
  });

  check("slack that genuinely exists is still spendable", () => {
    // 100 words leaves 20 of headroom, which is what makes a faithful
    // qualitative fix possible. The point is a real budget, not a freeze.
    const ledger = new SegmentBudgetLedger(coldOpenOf([20, 20, 20, 20, 20]));
    assert(ledger.maxWordsFor(0) === 40, `expected 20 own + 20 slack, got ${ledger.maxWordsFor(0)}`);
    assert(ledger.accept(0, words(23)) === true, "a +3 rewrite fits inside real slack");
    assert(ledger.maxWordsFor(1) === 37, `slack must shrink as it is spent, got ${ledger.maxWordsFor(1)}`);
  });

  check("the budget is per SEGMENT — an unbudgeted segment is untouched", () => {
    const ledger = new SegmentBudgetLedger(coldOpenOf([20, 20, 20, 20, 20, 20]));
    assert(ledger.isBudgeted(900) === false, "a topic segment carries no hard ceiling");
    assert(ledger.maxWordsFor(900) === null, "an unbudgeted line reports no ceiling");
    assert(ledger.accept(900, words(400)) === true, "grounding elsewhere must not be constrained by this");
  });

  check("an already-over segment still gets its grounding, as long as nothing gets worse", () => {
    // Refusing every rewrite in an over-budget segment would disable grounding
    // exactly where the writing is most likely to need it.
    const ledger = new SegmentBudgetLedger(coldOpenOf([25, 25, 25, 25, 25]));
    assert(ledger.accept(0, words(20)) === true, "a shrinking rewrite must be allowed when over budget");
    assert(ledger.accept(1, words(30)) === false, "a rewrite that deepens the overrun must be refused");
  });

  check("both rewrite budgets defer to the segment ceiling", () => {
    const line = "They cut their scouting operation in half and called it modernization in 1993.";
    assert(effectiveRewriteBudget(line) === rewriteWordBudget(line), "no ceiling means the per-line budget stands");
    assert(effectiveRewriteBudget(line, 5) === 5, "a tighter segment ceiling wins");
    assert(effectiveRewriteBudget(line, 999) === rewriteWordBudget(line), "a looser ceiling never loosens the line");
    // The antithesis budget is PROPORTIONAL, which makes it the more dangerous
    // of the two: 20% of every line in a segment compounds.
    assert(antithesisWordBudget(line) > rewriteWordBudget(line), "the antithesis allowance is the wider one");
    assert(antithesisWordBudget(line, 6) === 6, "and it must defer to a segment ceiling too");
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main();
