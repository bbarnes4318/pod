// Per-stage word accounting must be arithmetically honest.
//
//   npm run test:word-flow
//
// NETWORK-FREE.
//
// WHY IT EXISTS. An episode measured on 2026-08-10 spent 88,042 output tokens
// to ship ~1,100 spoken words — about 42 generated tokens per delivered word.
// The cost ledger says which STAGE spent it; it cannot say which stage spent it
// on words nobody hears, because it counts tokens rather than survival.
//
// These checks are about the arithmetic, not the pipeline: a measurement used to
// argue for cutting a stage has to be one nobody can wave away. In particular
// the loss classification is load-bearing — "we discard two thirds of the cold
// opens we write" is the tournament working as designed, while "the writers lost
// a third of their lines" is a defect. A summary that adds those together is
// worse than no summary.

import assert from "node:assert/strict";
import { WordFlow, wordsIn, wordsInText } from "../lib/services/scriptWordFlow";

let failed = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL ${name}\n       ${(err as Error).message}`);
  }
}

function main() {
  console.log("\nWord flow — per-stage emitted vs shipped\n");

  console.log("  -- counting --");

  check("production tags are not counted as spoken words", () => {
    assert.equal(wordsInText("[beat] three spoken words [laughs]"), 3);
  });

  check("a tag-only line counts zero", () => {
    assert.equal(wordsInText("[music sting]"), 0);
  });

  check("counting is stable across whitespace", () => {
    assert.equal(wordsInText("  two   words \n"), 2);
  });

  check("non-string and missing text are survivable", () => {
    assert.equal(wordsIn([{ text: undefined }, {}, { text: 5 as unknown as string }, { text: "one" }]), 1);
  });

  console.log("\n  -- classification --");

  check("losses are attributed to the right kind, never pooled", () => {
    const f = new WordFlow();
    f.record({ stage: "cold_open_tournament", kind: "selection", wordsEmitted: 300, wordsKept: 100 });
    f.record({ stage: "turn_plan", kind: "overhead", wordsEmitted: 500, wordsKept: 0 });
    f.record({ stage: "host_writers", kind: "attrition", wordsEmitted: 1200, wordsKept: 1000 });

    const t = f.totals();
    assert.equal(t.byKind.selection, 200, "two discarded cold opens are SELECTION, not waste");
    assert.equal(t.byKind.overhead, 500, "the turn plan ships nothing by design");
    assert.equal(t.byKind.attrition, 200, "dropped writer lines are the only straightforwardly bad loss");
    assert.equal(t.emitted, 2000);
    assert.equal(t.kept, 1100);
    assert.equal(t.lost, 900);
    assert.equal(
      t.byKind.selection + t.byKind.overhead + t.byKind.attrition + t.byKind.transform,
      t.lost,
      "every lost word must land in exactly one bucket — an unclassified remainder hides the defect"
    );
  });

  check("a transform that ADDS words does not show as negative loss", () => {
    // The dialogue director rewrites lines; a repair can be longer than what it
    // replaced. Letting that subtract from the loss total would let one stage
    // conceal another stage's attrition.
    const f = new WordFlow();
    f.record({ stage: "dialogue_director", kind: "transform", wordsEmitted: 100, wordsKept: 140 });
    f.record({ stage: "host_writers", kind: "attrition", wordsEmitted: 1000, wordsKept: 900 });
    const t = f.totals();
    assert.equal(t.byKind.transform, 0, "growth is clamped at zero rather than credited");
    assert.equal(t.byKind.attrition, 100, "and it cannot offset a real loss elsewhere");
  });

  console.log("\n  -- reporting --");

  check("the rendered block names every stage and the survival rate", () => {
    const f = new WordFlow();
    f.record({ stage: "turn_plan", kind: "overhead", wordsEmitted: 900, wordsKept: 0 });
    f.stage("host_writers", "attrition", [{ text: "a b c d" }], [{ text: "a b" }]);
    const out = f.render(100);
    assert.match(out, /\[WordFlow\]/);
    assert.match(out, /turn_plan/);
    assert.match(out, /host_writers/);
    assert.match(out, /TOTAL emitted 904, shipped 100/);
    assert.match(out, /11% survived/, "the survival rate is the headline number");
    assert.match(out, /overhead 900/);
  });

  check("stage() derives counts from the actual lines", () => {
    const f = new WordFlow();
    f.stage("x", "attrition", [{ text: "one two three" }, { text: "four" }], [{ text: "one two three" }]);
    const row = f.all()[0];
    assert.equal(row.wordsEmitted, 4);
    assert.equal(row.wordsKept, 3);
    assert.equal(row.linesEmitted, 2);
    assert.equal(row.linesKept, 1);
  });

  check("an empty flow renders without dividing by zero", () => {
    const out = new WordFlow().render(0);
    assert.match(out, /TOTAL emitted 0, shipped 0/);
    assert.match(out, /— survived/, "no denominator means no percentage, not NaN");
  });

  console.log(failed === 0 ? "\nAll word-flow checks passed.\n" : `\n${failed} check(s) FAILED.\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
