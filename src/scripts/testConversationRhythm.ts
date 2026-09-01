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
import {
  makeTurnPlanValidator,
  repairTurnPlanRhythm,
  turnPlanAlternation,
} from "../lib/services/scriptCreativePipeline";

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

  console.log("\nPacing stops being fatal once the model has genuinely tried\n");

  // WHY THIS SECTION EXISTS. The rules above are a joint constraint on the
  // speaker sequence, and the fixture two checks up had to be hand-built to
  // satisfy them — that is how narrow the band is. A frontier model lands in it;
  // gpt-oss-120b, which is what the FREE tier has for this role, often does not,
  // and on the free tier there is no third rung to fall to. Three consecutive
  // episodes died at this role. A flat conversation is a worse episode; a
  // rejected plan is no episode.
  check("a metronome is rejected for the attempt AND its repair, then accepted", () => {
    const budgeted = makeTurnPlanValidator(1200, { rhythmAttempts: 2 });
    const metronome = plan(Array(30).fill(2));
    assert(budgeted(metronome) !== null, "the first attempt must still be rejected");
    assert(budgeted(metronome) !== null, "the repair attempt must still be rejected");
    assert(
      budgeted(metronome) === null,
      "after the attempt and its repair, a structurally sound plan must be taken rather than lose the episode"
    );
  });

  check("the budget relaxes PACING only — content rules stay fatal for ever", () => {
    const budgeted = makeTurnPlanValidator(1200, { rhythmAttempts: 2 });
    const fourInARow = plan([4, 1, 2, 1, 3, 1, 2, 1, 2, 1, 3, 1, 2, 2, 1, 3, 1, 2, 1, 2, 1, 3, 1, 2, 1, 2]);
    for (let i = 0; i < 5; i++) {
      const err = budgeted(fourInARow);
      assert(err !== null && /four consecutive/i.test(err), `attempt ${i + 1} must still reject: got ${err}`);
    }
    // A plan too short to fill the episode is the other rule that never softens:
    // the writers only write the turns they are given, so a short plan is a short
    // episode, and that dies at the word floor after everything has been paid for.
    const tooShort = makeTurnPlanValidator(1200, { rhythmAttempts: 0 });
    const err = tooShort(plan([1, 2, 1, 2]));
    assert(err !== null && /at least/i.test(err), `a short plan must never be accepted, got: ${err}`);
  });

  console.log("\nA plan the model could not land is landed mechanically\n");

  // WHY. Softening the rhythm rules kept the episode alive at this role and
  // killed it two roles later instead: the dialogue director cannot change
  // speaker ownership or line count, so nothing downstream could undo the
  // ping-pong, and mechanicalAlternation is a HOLD rather than a repair. Script
  // 9a8b00a3 reached the gate at 93.8% strict alternation.

  const pingPong = (count: number, wordsAt: (i: number) => number) => {
    const turns = [];
    for (let i = 0; i < count; i++) {
      turns.push({
        turnIndex: i,
        beatIndex: 1 + (i % 5),
        speakerName: i % 2 === 0 ? "Bernadette Zabala" : "Cal Mercer",
        intent: "press the previous claim",
        factRefs: i % 4 === 0 ? [{ type: "newsItem", id: `n${i}` }] : [],
        targetWords: wordsAt(i),
      });
    }
    return turns;
  };
  // A realistic mix: the plan prompt asks for short reactions at 4-15 words and
  // arguments at 35-90, so a plan of uniform 20s is not the thing being fixed.
  const REAL_WORDS = [45, 12, 70, 8, 35, 20, 55, 9, 40, 25];
  const flat = pingPong(60, (i) => REAL_WORDS[i % REAL_WORDS.length]);

  const runLengthsOf = (turns: Array<{ speakerName: string }>) => {
    const runs: number[] = [];
    for (let i = 0; i < turns.length; i++) {
      if (i > 0 && turns[i].speakerName === turns[i - 1].speakerName) runs[runs.length - 1] += 1;
      else runs.push(1);
    }
    return runs;
  };

  check("pure ping-pong is brought inside the alternation ceiling", () => {
    const before = turnPlanAlternation(flat);
    assert(before > 0.99, `fixture should be pure alternation, got ${(before * 100).toFixed(1)}%`);
    const { turns, repair } = repairTurnPlanRhythm(flat);
    assert(repair.applied, "the repair must actually run");
    assert(repair.reachedCeiling, `expected to land in band, got ${(repair.alternationAfter * 100).toFixed(1)}%`);
    assert(turnPlanAlternation(turns) <= 0.55,
      `measured ${(turnPlanAlternation(turns) * 100).toFixed(1)}% after repair`);
    // And comfortably under the 65% the production invariant holds on, which is
    // the whole point of the plan ceiling being tighter than the gate's.
    assert(turnPlanAlternation(turns) <= 0.65, "must clear the production invariant with headroom");
  });

  check("the repaired plan satisfies the validator that rejected the original", () => {
    // The strongest statement available: repair output is not a special case
    // the rules are relaxed for, it is a plan the unrelaxed validator accepts.
    const { turns } = repairTurnPlanRhythm(flat);
    const strict = makeTurnPlanValidator(1200);
    const err = strict({ turns });
    assert(err === null, `the repaired plan must pass the strict validator, got: ${err}`);
  });

  check("repair splits turns and never reassigns them", () => {
    const { turns } = repairTurnPlanRhythm(flat);
    // The sequence of speakers, collapsed to runs, must be unchanged: a split
    // lengthens a run, it never moves a turn to the other host.
    const collapse = (t: Array<{ speakerName: string }>) =>
      t.filter((turn, i) => i === 0 || turn.speakerName !== t[i - 1].speakerName).map((turn) => turn.speakerName);
    assert(JSON.stringify(collapse(turns)) === JSON.stringify(collapse(flat)),
      "splitting must not change who speaks in what order");
    const before = flat.reduce((n, t) => n + t.targetWords, 0);
    const after = turns.reduce((n, t) => n + t.targetWords, 0);
    assert(before === after, `word budget must be divided, not created: ${before} -> ${after}`);
    assert(turns.every((t, i) => t.turnIndex === i), "turnIndex must be renumbered contiguously");
  });

  check("evidence stays on exactly one turn", () => {
    // The plan rules assign each fact to at most ONE turn; copying refs into the
    // continuation would quietly break that and put the same number in two mouths.
    const { turns } = repairTurnPlanRhythm(flat);
    const seen = new Set<string>();
    for (const turn of turns) {
      for (const ref of turn.factRefs) {
        const key = `${ref.type}:${ref.id}`;
        assert(!seen.has(key), `evidence ${key} was duplicated across turns by the repair`);
        seen.add(key);
      }
    }
    const originalRefs = flat.reduce((n, t) => n + t.factRefs.length, 0);
    assert(seen.size === originalRefs, `expected ${originalRefs} refs to survive, got ${seen.size}`);
  });

  check("repair respects every rule the validator enforces", () => {
    const { turns } = repairTurnPlanRhythm(flat);
    const runs = runLengthsOf(turns);
    assert(Math.max(...runs) <= 3, `no host may hold four turns, got a run of ${Math.max(...runs)}`);
    const threes = runs.filter((r) => r === 3).length;
    assert(threes <= Math.ceil(runs.length * 0.2), `${threes} of ${runs.length} runs are threes; the cap is one in five`);
    const histogram = new Map<number, number>();
    for (const r of runs) histogram.set(r, (histogram.get(r) ?? 0) + 1);
    const modal = Math.max(...Array.from(histogram.values()));
    assert(modal / runs.length <= 0.7, `${modal} of ${runs.length} runs share a length — that is a metronome`);
  });

  check("a plan already in band is returned untouched", () => {
    const varied = repairTurnPlanRhythm(flat).turns;
    const second = repairTurnPlanRhythm(varied);
    assert(!second.repair.applied, "repairing an in-band plan must be a no-op");
    assert(second.turns === varied, "an in-band plan must be returned by reference, not rebuilt");
  });

  check("a plan of pure short reactions is left alone rather than shredded", () => {
    // Two halves of an eight-word reaction are two fragments, not a host
    // building a point. Refusing to split is the honest outcome, and it is
    // reported rather than hidden.
    const tiny = pingPong(40, () => 8);
    const { turns, repair } = repairTurnPlanRhythm(tiny);
    assert(!repair.applied && !repair.reachedCeiling, "an unsplittable plan must report that it stayed out of band");
    assert(turns === tiny, "the original plan must be returned unchanged");
    assert(/no turn was long enough/i.test(repair.detail), `the reason must say why: ${repair.detail}`);
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main();
