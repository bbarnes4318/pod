// Executed tests for the episode-wide semantic repeated-point detector.
//
//   npx tsx --conditions=react-server src/scripts/testSemanticRepetition.ts
//   (add --verbose to dump full reports)
//
// These are REAL runs of analyzeSemanticRepetition against two inline
// fixtures, not source scanning:
//
//   FAILED FIXTURE  — reproduces the production episode that shipped while
//                     repeating itself: one rhetorical frame ("that's not X,
//                     that's Y") used six times, one proposition ("the game
//                     was over before it started") restated five different
//                     ways across seven segments, two statistics recycled as
//                     if fresh, one metaphor flogged, and a handful of
//                     content words hammered far past any sane budget.
//
//   CLEAN FIXTURE   — a varied episode of comparable length. It must PASS.
//                     Without this control the detector would be worthless:
//                     an always-fail checker is not a checker.
//
// No network, no DB, no API keys — the detector is pure and deterministic.

import assert from "node:assert/strict";

import {
  analyzeSemanticRepetition,
  SEMANTIC_REPETITION_THRESHOLD,
  type SemanticRepetitionCategory,
  type SemanticRepetitionReport,
  type SemanticRepetitionSegmentInput,
} from "../lib/services/semanticRepetition";

const VERBOSE = process.argv.includes("--verbose");

let passedCount = 0;
let failedCount = 0;
const failures: string[] = [];

function check(name: string, fn: () => void) {
  try {
    fn();
    passedCount++;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failedCount++;
    const message = err instanceof Error ? err.message : String(err);
    failures.push(`${name}\n       ${message.split("\n").join("\n       ")}`);
    console.log(`  FAIL ${name}`);
    console.log(`       ${message.split("\n").join("\n       ")}`);
  }
}

const seg = (title: string, lines: Array<[string, string]>): SemanticRepetitionSegmentInput => ({
  type: "discussion",
  title,
  topicId: title.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
  lines: lines.map(([speakerName, text]) => ({ speakerName, text })),
});

// ---------------------------------------------------------------------------
// FIXTURE A — the episode that shipped broken
// ---------------------------------------------------------------------------

const FAILED_EPISODE: SemanticRepetitionSegmentInput[] = [
  seg("Cold open: the schedule", [
    ["Zabala", "So they stacked four games into three days and called it a festival of baseball."],
    ["Mercer", "That's not a scheduling error, that's the modern game."],
    ["Zabala", "The drama ended before the second inning even started."],
    ["Mercer", "Look at the grid they published. It's basically a spreadsheet that occasionally throws a baseball at somebody."],
    ["Zabala", "Every single fan in that building paid full price for a product instead of a contest."],
  ]),
  seg("The doubleheader", [
    ["Mercer", "Seven hours of baseball in that stadium and the only thing anybody remembers is the parking situation."],
    ["Zabala", "By the time the second batter came up to the plate, the outcome was already settled."],
    ["Mercer", "That's not a spreadsheet, that's execution."],
    ["Zabala", "The fan who drove ninety minutes got handed a product, and the product was fine, and that is exactly the problem."],
    ["Mercer", "At the end of the day, the product got made and the sport got skipped entirely."],
  ]),
  seg("The pregame ceremony", [
    ["Zabala", "They gave the fan a ceremony instead of giving the fan a contest."],
    ["Mercer", "That's not a ceremony, that's a product launch."],
    ["Zabala", "The ceremony ran eleven minutes. This one was decided in the opening minutes and everybody in the building could feel it."],
    ["Mercer", "$3.2 million in ticket revenue that night and the fan went home with a video board tribute."],
    ["Zabala", "It is a ceremony for the fan and a spreadsheet for the accountants upstairs."],
  ]),
  seg("Television windows", [
    ["Mercer", "Get this — 41 percent of the fan base never saw the ninth inning of that game."],
    ["Zabala", "There was no suspense left in the ballpark once the first frame wrapped up."],
    ["Mercer", "That's not a showcase, that's a logistics problem."],
    ["Zabala", "The whole night felt like a spreadsheet with a mascot standing next to it."],
  ]),
  seg("The standings", [
    ["Mercer", "The standings say one thing about the season and the product says something completely different."],
    ["Zabala", "That's not a rivalry, that's a content calendar."],
    ["Mercer", "The result was locked in early and the rest of the night was filler for the paying fan."],
    ["Zabala", "Turns out 41 percent of the fan base never saw the ninth inning of that game."],
  ]),
  seg("Ratings", [
    ["Mercer", "Ratings are a product metric and the fan in the stands is a product input."],
    ["Zabala", "That's not a crowd, that's a focus group."],
    ["Mercer", "$3.2 million says the product worked, which is why nobody in that room will ever change it."],
    ["Zabala", "The spreadsheet won again, the fan lost again, and we are all supposed to clap about it."],
  ]),
  seg("Close", [
    ["Mercer", "The point is, the product got made and nobody in that stadium remembered the sport."],
    ["Zabala", "The drama was over early, the ceremony ran long, and the fan paid full price for both of them."],
    ["Mercer", "That's the story of the season. Spreadsheet baseball sold to a spreadsheet audience."],
  ]),
];

// ---------------------------------------------------------------------------
// FIXTURE B — the control: varied, comparable length, must PASS
// ---------------------------------------------------------------------------

const CLEAN_EPISODE: SemanticRepetitionSegmentInput[] = [
  seg("Deadline deal", [
    ["Zabala", "Cleveland moved their setup man for a nineteen-year-old shortstop who has not played above A-ball yet."],
    ["Mercer", "Bold. The scouting reports on that kid are split right down the middle, which is precisely why the price stayed reasonable."],
    ["Zabala", "Their bullpen ERA sat at 3.41 before the swap, so they were dealing from a position of strength."],
    ["Mercer", "I would have asked for the catcher instead, but I understand wanting up-the-middle athleticism."],
  ]),
  seg("Pitch timer", [
    ["Mercer", "The pitch timer drops to seventeen seconds with runners aboard starting next April."],
    ["Zabala", "Umpires have already asked for a review window and I do not blame them after what happened in Milwaukee."],
    ["Mercer", "Two seconds sounds trivial until you watch a catcher try to set up a backpick."],
    ["Zabala", "My worry is the shoulder workload, honestly. Nobody has modeled what a faster tempo does over five months."],
  ]),
  seg("Delgado debut", [
    ["Zabala", "Delgado's debut was the finest pure hitting performance I have seen from a call-up in a decade."],
    ["Mercer", "He fouled off eight straight breaking balls in the sixth. You cannot teach that kind of barrel control."],
    ["Zabala", "The swing decisions convinced me more than the contact did. He laid off the slider away all evening."],
    ["Mercer", "Watch how he handles the second look around the league. Scouting departments adjust fast."],
  ]),
  seg("Stadium financing", [
    ["Mercer", "The county wants a hotel tax to cover four hundred million dollars of the renovation."],
    ["Zabala", "Voters rejected a similar package in 2019 and nothing about the neighborhood's economics has improved since then."],
    ["Mercer", "If the roof comes out of public money, the naming rights should flow back to the county. I will die on that hill."],
    ["Zabala", "Tell me where the parking structure fits, because the current drawings quietly erase two blocks of housing."],
  ]),
  seg("Bullpen management", [
    ["Zabala", "Pulling Rivas after seventy-eight pitches with a two-run lead was defensible. The third trip through that order was going to get ugly."],
    ["Mercer", "Defensible, sure, except the guy warming up had thrown on back-to-back nights already."],
    ["Zabala", "Managers get graded on outcomes and the outcome was a blown save, so he will wear it in the press conference."],
    ["Mercer", "I would rather lose with my best arm throwing than protect a reliever nobody trusts in October."],
  ]),
  seg("Listener mail", [
    ["Mercer", "Karen from Duluth asks whether wooden bats will ever return to college baseball."],
    ["Zabala", "Cost, mostly. A program burning through forty bats a weekend cannot justify the switch without a sponsor writing checks."],
    ["Mercer", "Send more of those questions. Next week we are mapping minor league affiliations, which sounds dull and absolutely is not."],
  ]),
];

// ---------------------------------------------------------------------------
// FIXTURE C — pure paraphrase: two lines, near-zero shared wording, one claim
// ---------------------------------------------------------------------------

const PARAPHRASE_ONLY: SemanticRepetitionSegmentInput[] = [
  seg("Paraphrase", [
    ["Zabala", "The drama ended before the second inning even started."],
    ["Mercer", "By the time the bottom of the first wrapped up, nobody watching had any doubt about the final result."],
  ]),
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function describe(label: string, report: SemanticRepetitionReport) {
  console.log(
    `\n  ${label}: score ${report.repetitionScore}/100 (threshold ${report.threshold}) -> ${report.passed ? "PASS" : "FAIL"}` +
      `  [${report.totals.words} words, ${report.totals.lines} lines, ${report.totals.segments} segments, TTR ${report.totals.typeTokenRatio}]`,
  );
  if (report.findings.length === 0) {
    console.log("    (no findings)");
    return;
  }
  for (const finding of report.findings) {
    console.log(`    -${finding.penalty.toFixed(1).padStart(5)}  [${finding.severity}] ${finding.category}: ${finding.message}`);
    if (VERBOSE) {
      for (const item of finding.evidence.slice(0, 4)) {
        console.log(`             seg${item.segmentIndex + 1}/line${item.lineIndex}: ${item.text}`);
      }
    }
  }
}

function has(report: SemanticRepetitionReport, category: SemanticRepetitionCategory): boolean {
  return report.findingsByCategory[category] > 0;
}

function findingsIn(report: SemanticRepetitionReport, category: SemanticRepetitionCategory) {
  return report.findings.filter((finding) => finding.category === category);
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

console.log("\nSEMANTIC REPETITION DETECTOR\n" + "=".repeat(72));

const failedReport = analyzeSemanticRepetition(FAILED_EPISODE, { diagnostics: VERBOSE });
const cleanReport = analyzeSemanticRepetition(CLEAN_EPISODE, { diagnostics: VERBOSE });
const paraphraseReport = analyzeSemanticRepetition(PARAPHRASE_ONLY, { diagnostics: VERBOSE });

describe("FAILED fixture", failedReport);
describe("CLEAN fixture", cleanReport);

if (VERBOSE) {
  console.log("\n  clean diagnostics:", JSON.stringify(cleanReport.diagnostics, null, 2));
  console.log("\n  paraphrase diagnostics:", JSON.stringify(paraphraseReport.diagnostics, null, 2));
}

console.log("\n" + "-".repeat(72) + "\nassertions\n");

// --- the failed episode must fail -----------------------------------------
check("failed fixture does not pass", () => {
  assert.equal(failedReport.passed, false, `expected passed=false, got score ${failedReport.repetitionScore}`);
  assert.ok(
    failedReport.repetitionScore < SEMANTIC_REPETITION_THRESHOLD,
    `score ${failedReport.repetitionScore} should be below threshold ${SEMANTIC_REPETITION_THRESHOLD}`,
  );
});

check("failed fixture scores badly, not marginally", () => {
  assert.ok(failedReport.repetitionScore <= 40, `expected a heavily penalised score, got ${failedReport.repetitionScore}`);
});

const REQUIRED_CATEGORIES: SemanticRepetitionCategory[] = [
  "repeated_claim",
  "repeated_evidence",
  "repeated_metaphor",
  "repeated_conclusion",
  "repeated_frame",
  "phrase_budget",
  "segment_recap",
  "duplicate_thesis",
];

for (const category of REQUIRED_CATEGORIES) {
  check(`failed fixture names category: ${category}`, () => {
    assert.ok(has(failedReport, category), `missing ${category}; got [${failedReport.categoriesTriggered.join(", ")}]`);
  });
}

check("repeated 'that's not X, that's Y' frame is caught with its usage count", () => {
  const frames = findingsIn(failedReport, "repeated_frame");
  const tic = frames.find((finding) => /that's not/.test(finding.message));
  assert.ok(tic, `no frame finding mentioning the tic; got: ${frames.map((f) => f.message).join(" | ")}`);
  assert.ok(tic.occurrences >= 5, `expected the frame in >=5 lines, got ${tic.occurrences}`);
  assert.ok(tic.allowance !== undefined && tic.occurrences > tic.allowance, "occurrences should exceed the derived budget");
});

check("the restated 'it was over early' proposition is clustered", () => {
  const claims = findingsIn(failedReport, "repeated_claim");
  const biggest = claims.reduce((best, finding) => (finding.occurrences > best.occurrences ? finding : best), claims[0]);
  assert.ok(biggest.occurrences >= 4, `expected a cluster of >=4 restatements, got ${biggest.occurrences}`);
  const spannedSegments = new Set(biggest.evidence.map((item) => item.segmentIndex));
  assert.ok(spannedSegments.size >= 3, `expected the cluster to span >=3 segments, got ${spannedSegments.size}`);
});

check("recycled statistics are itemised", () => {
  const evidence = findingsIn(failedReport, "repeated_evidence");
  assert.ok(evidence.length >= 2, `expected both recycled stats, got ${evidence.length}`);
  assert.ok(
    evidence.some((finding) => /fresh revelation/.test(finding.message)),
    "a stat re-introduced with 'Turns out' should be flagged as presented-as-new",
  );
});

check("the overworked metaphor vehicle is named", () => {
  const metaphors = findingsIn(failedReport, "repeated_metaphor");
  assert.ok(metaphors.length >= 1, "expected a repeated metaphor finding");
  assert.ok(metaphors[0].occurrences >= 3, `expected >=3 uses of one vehicle, got ${metaphors[0].occurrences}`);
});

check("content-word budget is derived from length, not a word list", () => {
  const budgetFindings = findingsIn(failedReport, "phrase_budget");
  assert.ok(budgetFindings.length >= 3, `expected several over-budget lemmas, got ${budgetFindings.length}`);
  const worst = budgetFindings[0];
  assert.ok(worst.measure !== undefined && worst.measure > 6, `expected a rate above 6/1000, got ${worst.measure}`);
  assert.equal(failedReport.budgets.lemmaPer1000, 6, "the documented rate is 6 per 1000 words");
  assert.ok(
    failedReport.budgets.lemmaAllowance >= Math.ceil((6 * failedReport.totals.words) / 1000),
    "the allowance must never be tighter than the documented rate",
  );
  // On a long episode the small-sample floor stops binding and the allowance
  // is exactly the rate — proving the budget is derived, not hardcoded.
  const longLine = "Milwaukee traded a catcher for two arms nobody outside the organisation had scouted properly this winter.";
  const longEpisode = [{ title: "Long", topicId: "long", lines: Array.from({ length: 120 }, () => ({ speakerName: "Zabala", text: longLine })) }];
  const longReport = analyzeSemanticRepetition(longEpisode);
  assert.equal(
    longReport.budgets.lemmaAllowance,
    Math.ceil((6 * longReport.totals.words) / 1000),
    `allowance should equal the rate on a ${longReport.totals.words}-word episode`,
  );
});

check("evidence points at real lines", () => {
  for (const finding of failedReport.findings) {
    assert.ok(finding.evidence.length > 0, `${finding.category} finding has no evidence`);
    for (const item of finding.evidence) {
      assert.ok(item.text.length > 0, "evidence text is empty");
      assert.ok(item.lineIndex >= 0 && item.lineIndex < failedReport.totals.lines, `line index ${item.lineIndex} out of range`);
    }
  }
});

// --- the clean episode must pass ------------------------------------------
check("clean fixture passes on merit", () => {
  assert.equal(
    cleanReport.passed,
    true,
    `clean control failed with score ${cleanReport.repetitionScore}: ${cleanReport.findings.map((f) => f.message).join(" | ")}`,
  );
  assert.ok(
    cleanReport.repetitionScore >= 85,
    `clean control should score comfortably, got ${cleanReport.repetitionScore}`,
  );
});

check("clean fixture is not flagged for claims, frames or thesis duplication", () => {
  for (const category of ["repeated_claim", "repeated_frame", "duplicate_thesis", "segment_recap"] as SemanticRepetitionCategory[]) {
    assert.equal(
      has(cleanReport, category),
      false,
      `false positive ${category}: ${findingsIn(cleanReport, category).map((f) => f.message).join(" | ")}`,
    );
  }
});

check("the clean episode degrades when a single restatement is injected", () => {
  // Proves the pass above is earned rather than inert: one restated
  // proposition — different wording, same claim — must move the score.
  const injected = [
    ...CLEAN_EPISODE,
    seg("Injected restatement", [
      ["Zabala", "The blown save decided that game before the bullpen door had even closed behind him."],
      ["Mercer", "Once Rivas walked off the mound, the outcome of the game was already settled and the final result never moved."],
    ]),
  ];
  const report = analyzeSemanticRepetition(injected);
  assert.ok(
    report.repetitionScore < cleanReport.repetitionScore,
    `injecting a restatement should cost points, got ${report.repetitionScore} vs ${cleanReport.repetitionScore}`,
  );
  assert.ok(
    has(report, "repeated_claim"),
    `the injected restatement should surface as a repeated claim; got [${report.categoriesTriggered.join(", ")}]`,
  );
});

check("the detector separates the two episodes by a wide margin", () => {
  const gap = cleanReport.repetitionScore - failedReport.repetitionScore;
  assert.ok(gap >= 50, `expected a decisive gap between the fixtures, got ${gap}`);
});

// --- paraphrase --------------------------------------------------------
check("paraphrase with almost no shared wording is caught as a repeated claim", () => {
  assert.ok(
    has(paraphraseReport, "repeated_claim"),
    `paraphrase not detected; categories: [${paraphraseReport.categoriesTriggered.join(", ")}]`,
  );
  const claim = findingsIn(paraphraseReport, "repeated_claim")[0];
  const lines = claim.evidence.map((item) => item.lineIndex).sort();
  assert.deepEqual(lines, [0, 1], "the finding should cite both paraphrased lines");
});

check("the paraphrase pair really does share almost no wording", () => {
  // Guard against the fixture accidentally becoming a lexical near-duplicate:
  // if the two lines shared vocabulary, this test would prove nothing.
  const words = (text: string) => new Set(text.toLowerCase().replace(/[^a-z\s]/g, " ").split(/\s+/).filter((w) => w.length > 3));
  const lines = PARAPHRASE_ONLY[0].lines as Array<{ text: string }>;
  const a = words(lines[0].text);
  const b = words(lines[1].text);
  const shared = [...a].filter((word) => b.has(word));
  assert.ok(shared.length <= 1, `fixture lines share too much wording: ${shared.join(", ")}`);
});

// --- budget really is proportional ----------------------------------------
check("the same repetition count is fine in a long episode and not in a short one", () => {
  const repeatedLine = "The bullpen coach hates the new bullpen rule and says so to every bullpen reporter.";
  const filler = [
    "Milwaukee traded a catcher for two arms nobody outside the org had scouted properly.",
    "Voters in Sacramento rejected the arena package by nine points last November.",
    "Delgado laid off the slider away and drove the next fastball into the gap.",
    "Umpires want a review window before the timer shrinks again next April.",
    "The hotel tax proposal covers roughly four hundred million of the renovation.",
    "Karen from Duluth wants to know whether wooden bats return to college play.",
    "Rivas threw seventy-eight pitches and the manager pulled him at the right moment.",
    "Scouting departments adjust to a rookie faster than anybody expects them to.",
  ];
  const shortEpisode = [seg("Short", [["Zabala", repeatedLine], ["Mercer", repeatedLine], ["Zabala", repeatedLine], ["Mercer", filler[0]]])];
  const longLines: Array<[string, string]> = [];
  for (let i = 0; i < 3; i++) longLines.push(["Zabala", repeatedLine]);
  for (let i = 0; i < 90; i++) longLines.push(["Mercer", filler[i % filler.length]]);

  const shortReport = analyzeSemanticRepetition(shortEpisode);
  const longReport = analyzeSemanticRepetition([seg("Long", longLines)]);

  const overBudget = (report: SemanticRepetitionReport) =>
    findingsIn(report, "phrase_budget").some((finding) => /"bullpen"/.test(finding.message));

  assert.ok(shortReport.budgets.lemmaAllowance < longReport.budgets.lemmaAllowance, "budget must grow with episode length");
  assert.ok(overBudget(shortReport), "3 'bullpen' triples in a tiny episode must breach the budget");
  assert.ok(!overBudget(longReport), "the identical count in a long episode must stay inside the budget");
});

// --- hygiene ---------------------------------------------------------------
check("deterministic across runs", () => {
  const first = JSON.stringify(analyzeSemanticRepetition(FAILED_EPISODE));
  const second = JSON.stringify(analyzeSemanticRepetition(FAILED_EPISODE));
  assert.equal(first, second, "detector output must be byte-identical between runs");
});

check("empty and malformed input degrade safely", () => {
  for (const input of [[], null, undefined, [{}], [{ lines: [] }], [{ lines: [{ text: null }] }]]) {
    const report = analyzeSemanticRepetition(input as SemanticRepetitionSegmentInput[] | null | undefined);
    assert.equal(report.passed, true, "empty input should not be reported as repetitive");
    assert.equal(report.repetitionScore, 100);
    assert.equal(report.findings.length, 0);
  }
});

check("threshold is exported and honoured", () => {
  assert.equal(typeof SEMANTIC_REPETITION_THRESHOLD, "number");
  assert.equal(cleanReport.threshold, SEMANTIC_REPETITION_THRESHOLD);
  const strict = analyzeSemanticRepetition(CLEAN_EPISODE, { threshold: 101 });
  assert.equal(strict.passed, false, "passed must be computed against the supplied threshold");
  const lenient = analyzeSemanticRepetition(FAILED_EPISODE, { threshold: 0 });
  assert.equal(lenient.passed, true, "passed must be computed against the supplied threshold");
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log("\n" + "=".repeat(72));
console.log(
  `FAILED fixture: ${failedReport.repetitionScore}/100 (${failedReport.categoriesTriggered.length} categories triggered)   ` +
    `CLEAN fixture: ${cleanReport.repetitionScore}/100 (${cleanReport.categoriesTriggered.length} categories triggered)`,
);
if (failedCount === 0) {
  console.log(`PASS — ${passedCount}/${passedCount} assertions`);
  process.exit(0);
} else {
  console.log(`FAIL — ${failedCount} of ${passedCount + failedCount} assertions failed:`);
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exit(1);
}
