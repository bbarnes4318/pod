// Conversation rhythm guards.
//
// The owner's complaint after listening was that the hosts sound mechanical.
// The cause was a constraint system with exactly one solution: a hard cap of
// two consecutive turns plus an alternation ceiling of 55% forces runs of
// EXACTLY two everywhere (if every run has length r, alternation is 1/r, so
// r >= 1.82; capped at 2 leaves only 2). Episode 0c90db5b ran 28 of 39 speaker
// runs at length two. The continuity gate scored that 84/100 and paid it the
// full same-speaker-build bonus, because it measured strict A/B alternation
// (0.52 — healthy-looking) and never looked at the run-length distribution.
//
// NETWORK-FREE. Run: npm run test:conversation-rhythm

import { scoreConversationContinuity } from "../lib/services/scriptConversationDirector";
import { makeTurnPlanValidator } from "../lib/services/scriptCreativePipeline";

let passed = 0, failed = 0;
function check(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.error(`  ✗ ${name}\n      ${(err as Error).message}`); }
}
function assert(c: boolean, m: string) { if (!c) throw new Error(m); }

/** Build one segment from a run-length pattern, e.g. [2,2,2] -> AA BB AA. */
function scriptFromRuns(runs: number[]) {
  const lines: Array<Record<string, unknown>> = [];
  let speaker = 0, lineIndex = 0;
  for (const run of runs) {
    for (let i = 0; i < run; i++) {
      lines.push({
        lineIndex: lineIndex++,
        speakerName: speaker === 0 ? "Bernadette Zabala" : "Cal Mercer",
        // Deliberately responsive text so the ONLY thing under test is rhythm.
        text: i === 0 ? "But that is exactly the point you just made about the calendar." : "And the calendar is the thing nobody will name.",
      });
    }
    speaker = 1 - speaker;
  }
  return [{ type: "debate", title: "t", lines }];
}

function main() {
  console.log("\nRun-length distribution is measured\n");

  check("uniform PAIRS are detected as a metronome", () => {
    const m = scoreConversationContinuity(scriptFromRuns(Array(20).fill(2)) as never);
    assert(m.modalRunLength === 2, `modal run should be 2, got ${m.modalRunLength}`);
    assert(m.runLengthUniformity > 0.95, `uniformity should be ~1, got ${m.runLengthUniformity}`);
    // The exact trap: strict alternation looks perfectly healthy here.
    assert(m.strictAlternationRatio < 0.6, `strict alternation should look healthy (<0.6), got ${m.strictAlternationRatio}`);
  });

  check("uniform SINGLES are detected too", () => {
    const m = scoreConversationContinuity(scriptFromRuns(Array(24).fill(1)) as never);
    assert(m.modalRunLength === 1, `modal run should be 1, got ${m.modalRunLength}`);
    assert(m.runLengthUniformity > 0.95, `uniformity should be ~1, got ${m.runLengthUniformity}`);
  });

  check("a varied rhythm scores higher than a metronome", () => {
    const metronome = scoreConversationContinuity(scriptFromRuns(Array(20).fill(2)) as never);
    const varied = scoreConversationContinuity(scriptFromRuns([1, 2, 1, 3, 1, 2, 2, 1, 3, 1, 2, 1, 1, 2, 3, 1, 2, 1]) as never);
    assert(varied.runLengthUniformity < 0.7, `varied script should not be uniform, got ${varied.runLengthUniformity}`);
    assert(varied.score > metronome.score,
      `varied (${varied.score}) must outscore the metronome (${metronome.score}) — identical text, only rhythm differs`);
  });

  check("the same-speaker build bonus no longer subsidises uniform pairs", () => {
    const metronome = scoreConversationContinuity(scriptFromRuns(Array(20).fill(2)) as never);
    // 20 runs of 2 = maximum possible sameSpeakerBuilds ratio, which used to
    // collect the full 10-point bonus and zero penalty.
    assert(metronome.sameSpeakerBuilds >= 15, "fixture should be build-heavy");
    assert(metronome.score < 80, `a pure metronome must not score like a real conversation, got ${metronome.score}`);
  });

  console.log("\nThe turn-plan validator rejects the metronome at the plan stage\n");

  // 60 turns clears the turn floor for a modest word target.
  const plan = (runs: number[]) => {
    const turns: Array<Record<string, unknown>> = [];
    let speaker = 0;
    for (const run of runs) {
      for (let i = 0; i < run; i++) {
        turns.push({
          turnIndex: turns.length, beatIndex: 1,
          speakerName: speaker === 0 ? "Bernadette Zabala" : "Cal Mercer",
          intent: "press the previous claim", factRefs: [], targetWords: 20,
        });
      }
      speaker = 1 - speaker;
    }
    return { turns };
  };
  const validate = makeTurnPlanValidator(1200);

  check("uniform PAIRS are rejected by the plan validator", () => {
    const err = validate(plan(Array(30).fill(2)));
    assert(err !== null, "a plan of nothing but pairs must be rejected");
    assert(/metronome/i.test(err!), `rejection should name the metronome, got: ${err}`);
  });

  check("four consecutive turns is still rejected", () => {
    const err = validate(plan([4, 1, 2, 1, 3, 1, 2, 1, 2, 1, 3, 1, 2, 2, 1, 3, 1, 2, 1, 2, 1, 3, 1, 2, 1, 2]));
    assert(err !== null && /four consecutive/i.test(err), `expected a four-in-a-row rejection, got: ${err}`);
  });

  check("three-turn runs are allowed but capped at one in five", () => {
    const err = validate(plan(Array(20).fill(3)));
    assert(err !== null && /three-turn runs|one in five/i.test(err), `expected a three-run cap rejection, got: ${err}`);
  });

  check("a varied plan is ACCEPTED — the constraints are satisfiable without a metronome", () => {
    // The feasible region is narrow and worth stating explicitly: the
    // alternation ceiling of 55% requires a mean run length of at least
    // 1/0.55 = 1.82, while no run length may exceed 70% of the plan and threes
    // are capped at one in five. Roughly 25% singles / 55% pairs / 20% triples
    // satisfies all three at once — mean 1.95, uniformity 0.57.
    const varied = [2, 1, 2, 3, 2, 2, 1, 2, 3, 2, 1, 2, 2, 3, 2, 1, 2, 2, 3, 2, 1, 2, 3, 2, 2, 1, 2, 3, 2, 1];
    const err = validate(plan(varied));
    assert(err === null, `a varied plan must pass, got: ${err}`);
    const m = scoreConversationContinuity(scriptFromRuns(varied) as never);
    assert(m.runLengthUniformity <= 0.7, `fixture should be non-uniform, got ${m.runLengthUniformity.toFixed(2)}`);
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main();
