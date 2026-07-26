/* eslint-disable @typescript-eslint/no-explicit-any -- reads untyped Json brief/topic payloads */
// Phase 2 — betting-odds bias: classifier, quota, and the scorers.
//
// The bias was "fixed" once before and came back, so this pins the RULES rather
// than a keyword list on the display layer.
//
// What the root-cause measurement on the live pool actually found (95 topics):
//   · The stated hypothesis — talkability's `specificity` axis rewards the dense
//     cheap numbers in betting lines — is REFUTED. specificity scored 30.0/30
//     for betting and 29.7/30 for human topics, and tension 20.0 vs 20.0. Both
//     axes are SATURATED for anything with a brief and discriminate nothing.
//   · The real gaps were evidence (17.6 vs 13.8) and hook (1.5). Evidence gave
//     +2 simply for a brief HAVING an oddsContext field.
//   · The dominant scorer bias was elsewhere entirely: debateScore, which The
//     Board ranks by, weighted bettingRelevanceScore at 0.20.
//   · Upstream, OddsSnapshot was 68.4% of all ingested rows (40,102 all-time vs
//     4,963 NewsItem) — the generator is fed odds and little else.
//
// These tests encode the resulting rules. The real-batch assertion (a generated
// batch never exceeds quota) is the insert-loop logic, exercised via admitsBetting.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { classifyTopicFrame, BETTING_FRAME_THRESHOLD } from "../lib/services/bettingFrame";
import { admitsBetting, BETTING_QUOTA, BETTING_WINDOW_DAYS } from "../lib/services/bettingQuota";
import { scoreTopicTalkability } from "../lib/services/talkabilityService";

let passed = 0;
let failed = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ✗ ${name}\n      ${err instanceof Error ? err.message : String(err)}`);
    failed++;
  }
}
function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

console.log("Betting frame, quota, and scoring\n");

// Verbatim titles pulled from the live production board during the audit.
const REAL_BETTING = [
  "Is Chargers-Broncos the Perfect 2.5-Point Argument?",
  "Is 49ers-Seahawks a 48.5-Point Firefight or a Divisional Knife Fight?",
  "Chargers-Broncos: Is This Line Begging You to Take Denver?",
  "Are the 49ers Really Worth Laying 3.5 in Seattle?",
  "Would You Lay the Dodgers-A's Run Line or Are You Asking for Pain?",
  "Giants-Diamondbacks Run Line: Is Paying -189 for +1.5 Cowardly or Smart?",
  "Dodgers-Athletics Total at 9.5: Fireworks or Sucker Over?",
  "Is Ohio State-Michigan Already a Disrespect Line?",
  "Are Commanders-Giants being priced like chaos?",
  "Is 49ers-Seahawks Being Priced Like a Track Meet?",
  "Does a 2.5-Point Chargers-Broncos Line Mean Nobody Trusts Either Side?",
  "Are Giants-Commanders Odds Too Respectful to New York?",
  // Found by the Phase 4 verification run: scored 0 under the original rules and
  // reached the customer top 10 after the purge. No article before "Total", no
  // unit word after the number.
  "Giants-Diamondbacks Total at 9.5: Desert Runs or Public Bait?",
];
// Deliberately NOT in the list above: "Is Chargers-Broncos a toss-up or a trap?"
// is not classifiable from its title — "trap" is ordinary sports-radio language
// for a letdown spot as often as it is a betting term. The purge caught it from
// its SUMMARY, which is the right mechanism. Forcing a title-only rule to fire on
// it would start retiring human-stakes topics, which is the failure mode that
// matters more.
const REAL_HUMAN = [
  "Did the Bucks make a smart win-now move with Gary Trent Jr., or just buy comfort?",
  "Are the Braves allowed to be 'free-falling' and still treated like contenders?",
  "Should Mets fans trust another bullpen patch?",
  "Did Jordan Walker Save the Home Run Derby—or Expose It as a Gimmick?",
  "Is Paolo Banchero actually rejuvenated, or is this offseason optimism theater?",
  "Should the NBA Freeze the Kawhi Trade Until the Clippers Probe Ends?",
  "Kyle Shanahan misses camp after a car wreck — does the product owe fans an explanation?",
  "Did the Dolphins Overpay Malik Willis, or Is This What a Rebuild Costs?",
  "Is the Yankees' six-game skid a heart problem or just one ugly week?",
  "Are We Really Doing Another LeBron Free Agency Watch?",
  "Did Kyle Schwarber Choke Away His Philly Moment?",
  "Should the Rockies Extend Young Players Before Proving the Plan Works?",
];

check("every real betting-framed title from production classifies as betting", () => {
  const missed = REAL_BETTING.filter((t) => classifyTopicFrame({ title: t }).frame !== "betting");
  assert(missed.length === 0, `missed ${missed.length}: ${missed.join(" | ")}`);
});

check("every real human-stakes title from production classifies as human", () => {
  const wrong = REAL_HUMAN.filter((t) => classifyTopicFrame({ title: t }).frame !== "human");
  assert(wrong.length === 0, `false positives: ${wrong.join(" | ")}`);
});

check("odds as a supporting FACT do not make a topic betting-framed", () => {
  // This is the whole spec: odds may appear as a fact, never as the frame.
  const r = classifyTopicFrame({
    title: "Did the Ravens rush Nnamdi Madubuike back too soon?",
    summary:
      "Baltimore placed him on PUP with a vague timeline. The market moved a point and a half on the news, and the total dropped to 44.5.",
  });
  assert(r.frame === "human", `a human story citing odds must stay human (score ${r.score}: ${r.signals.join(", ")})`);
});

check("a betting frame is caught even when the title hides behind a team story", () => {
  const r = classifyTopicFrame({
    title: "Are the Giants Being Disrespected Again?",
    summary: "Washington is favored by 2.5 with the total at 48.5. Is the number an insult or is the market right?",
  });
  assert(r.frame === "betting", `market-as-subject summary should flip it (score ${r.score})`);
});

check("the quota admits exactly one betting topic per window", () => {
  assert(BETTING_QUOTA === 1, `quota must be 1, got ${BETTING_QUOTA}`);
  assert(BETTING_WINDOW_DAYS === 30, `window must be 30 days, got ${BETTING_WINDOW_DAYS}`);
  assert(admitsBetting(0, 0), "an empty window must admit the first betting topic");
  assert(!admitsBetting(1, 0), "an existing in-window betting topic must block a second");
  assert(!admitsBetting(0, 1), "one already admitted THIS BATCH must block a second in the same batch");
});

check("REGRESSION: a full generated batch never exceeds quota", () => {
  // Today's behaviour without the gate: every betting-framed topic in the batch
  // was inserted. The live board carried a dozen simultaneously.
  const batch = [...REAL_BETTING, ...REAL_HUMAN];
  const usedInWindow = 0;
  let admittedThisBatch = 0;
  let inserted = 0;
  let rejected = 0;
  for (const title of batch) {
    const frame = classifyTopicFrame({ title }).frame;
    if (frame === "betting" && !admitsBetting(usedInWindow, admittedThisBatch)) {
      rejected++;
      continue;
    }
    if (frame === "betting") admittedThisBatch++;
    inserted++;
  }
  assert(admittedThisBatch <= BETTING_QUOTA, `batch admitted ${admittedThisBatch} betting topics, quota is ${BETTING_QUOTA}`);
  assert(rejected === REAL_BETTING.length - BETTING_QUOTA, `expected ${REAL_BETTING.length - BETTING_QUOTA} rejections, got ${rejected}`);
  assert(inserted === REAL_HUMAN.length + BETTING_QUOTA, `human topics must be unaffected: inserted ${inserted}`);
});

check("debateScore no longer weights betting relevance", () => {
  // The Board ranks by debateScore. A 0.20 weight there meant the product's
  // front page was ordered one-fifth by how betting-relevant a story was.
  const worker = readFileSync(join(__dirname, "..", "lib", "queue", "worker.ts"), "utf8");
  const formula = worker.slice(worker.indexOf("const debateScore ="), worker.indexOf("const debateScore =") + 400);
  assert(
    !/bettingRelevance\s*\*/.test(formula),
    "bettingRelevance must not be a term in debateScore — it decides what the board shows first"
  );
  assert(/controversy \* 0\.40/.test(formula), "controversy should carry the redistributed weight");
});

check("talkability no longer pays a bonus for merely having odds attached", () => {
  const withOdds = scoreTopicTalkability({
    title: "Does the coach survive the bye week?",
    brief: { sourceIds: [{ type: "newsItem", id: "1" }], oddsContext: "Line moved 2.5 points.", facts: [], stats: [] } as any,
  });
  const withoutOdds = scoreTopicTalkability({
    title: "Does the coach survive the bye week?",
    brief: { sourceIds: [{ type: "newsItem", id: "1" }], facts: [], stats: [] } as any,
  });
  assert(
    withOdds.axes.evidence.score === withoutOdds.axes.evidence.score,
    `an oddsContext field must not add evidence points (${withOdds.axes.evidence.score} vs ${withoutOdds.axes.evidence.score})`
  );
});

check("injury context still counts — it is a fact about people", () => {
  const withInjury = scoreTopicTalkability({
    title: "Does the coach survive the bye week?",
    brief: { sourceIds: [{ type: "newsItem", id: "1" }], injuryContext: "Starter out 6 weeks.", facts: [], stats: [] } as any,
  });
  const without = scoreTopicTalkability({
    title: "Does the coach survive the bye week?",
    brief: { sourceIds: [{ type: "newsItem", id: "1" }], facts: [], stats: [] } as any,
  });
  assert(withInjury.axes.evidence.score > without.axes.evidence.score, "injury context should still add evidence");
});

check("the generator is told the frame rule AND warned about the odds firehose", () => {
  const worker = readFileSync(join(__dirname, "..", "lib", "queue", "worker.ts"), "utf8");
  assert(/THE FRAME RULE/.test(worker), "the topic prompt must carry the frame rule");
  assert(/never be the FRAME/i.test(worker), "the prompt must forbid odds as the frame explicitly");
  // Root cause: 68.4% of ingested rows are odds. Without this the model reads
  // that volume as a signal about what fans argue about.
  assert(/dominated by odds records/i.test(worker), "the prompt must tell the model the evidence mix is skewed");
});

check("the pool composition is reported on every generation run", () => {
  const worker = readFileSync(join(__dirname, "..", "lib", "queue", "worker.ts"), "utf8");
  assert(/poolBettingPercent/.test(worker), "each run must report the pool's betting share");
  assert(/overQuotaRejected/.test(worker), "each run must report what the quota turned away");
});

check("threshold is a named constant, not a magic number", () => {
  assert(typeof BETTING_FRAME_THRESHOLD === "number" && BETTING_FRAME_THRESHOLD > 0, "threshold must be exported and positive");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
