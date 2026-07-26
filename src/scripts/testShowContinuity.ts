// Continuity engine contracts (Tasks 3-5).
//
// The rolling-window rate limit is the piece most likely to be subtly wrong —
// off-by-one at the window edge gives either a device that fires twice in a row
// or one that never fires again — so its boundaries are pinned exactly.

import {
  AUTHORED_ARC_LENGTH,
  DODGE_LADDER,
  EMPTY_CONTINUITY,
  HOYT_LADDER_END,
  RATE_LIMITS,
  WOLVERINES_BANK,
  WOLVERINE_WINDOW,
  arcExhausted,
  eligibleRunners,
  eligibleWolverines,
  rateLimitAllows,
  rateLimitCooldown,
  type ContinuityState,
} from "../lib/services/showContinuity";
import {
  checkContinuity,
  continuityUpdateSchema,
  findHoytContradiction,
  nextContinuityState,
  renderContinuityBlock,
  type ContinuityUpdate,
} from "../lib/services/showContinuityService";

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

const state = (over: Partial<ContinuityState> = {}): ContinuityState => ({ ...EMPTY_CONTINUITY, ...over });
const update = (over: Partial<ContinuityUpdate> = {}): ContinuityUpdate =>
  continuityUpdateSchema.parse({ unityBeatPresent: true, ...over });

console.log("Continuity engine\n");

// --- RATE LIMITS: rolling window, no season boundary ------------------------

check("rate limit: a fresh show may fire", () => {
  assert(rateLimitAllows(state(), "nuclearOption"), "should be allowed at episode 0");
  assert(rateLimitCooldown(state(), "nuclearOption") === 0, "no cooldown when allowed");
});

check("rate limit: budget is spent after max firings inside the window", () => {
  const { max, window } = RATE_LIMITS.nuclearOption;
  assert(max === 2 && window === 20, "test assumes 2-in-20");
  // Fired at 5 and 9; now at episode 10. Both inside the window.
  const s = state({ episodeCount: 10, nuclearOptionFirings: [5, 9] });
  assert(!rateLimitAllows(s, "nuclearOption"), "two firings inside the window must block a third");
});

check("rate limit: the window EDGE is exact (no off-by-one)", () => {
  // Window 20. Fired at 0 and 1. At episode 20, the firing at 0 has just
  // dropped out (0 > 20-20 is false) so exactly one remains → allowed.
  const at20 = state({ episodeCount: 20, nuclearOptionFirings: [0, 1] });
  assert(rateLimitAllows(at20, "nuclearOption"), "a firing exactly `window` episodes ago must have expired");
  // One episode earlier, both are still inside → blocked.
  const at19 = state({ episodeCount: 19, nuclearOptionFirings: [0, 1] });
  assert(!rateLimitAllows(at19, "nuclearOption"), "at window-1 both firings still count");
  assert(rateLimitCooldown(at19, "nuclearOption") === 1, `expected 1 episode of cooldown, got ${rateLimitCooldown(at19, "nuclearOption")}`);
});

check("rate limit: an ancient firing never blocks (no accumulation over a long run)", () => {
  // 500 episodes in, with firings scattered through history. Only the last
  // window matters — this is what a season boundary would otherwise be for.
  const s = state({ episodeCount: 500, nuclearOptionFirings: [1, 40, 90, 200, 350] });
  assert(rateLimitAllows(s, "nuclearOption"), "firings outside the window must not accumulate");
});

check("rate limit: once-per-window devices allow exactly one", () => {
  const fresh = state({ episodeCount: 30 });
  assert(rateLimitAllows(fresh, "coldOpenFullRun"), "cold-open full run available on a fresh window");
  const used = state({ episodeCount: 30, coldOpenFullRuns: [25] });
  assert(!rateLimitAllows(used, "coldOpenFullRun"), "max is 1 — a second inside the window must block");
  assert(rateLimitAllows(state({ episodeCount: 46, coldOpenFullRuns: [25] }), "coldOpenFullRun"), "available again once the window passes");
});

// --- ROTATION ---------------------------------------------------------------

check("rotation: no Wolverine repeats inside the window, and the bank cannot starve", () => {
  const recent = WOLVERINES_BANK.slice(0, WOLVERINE_WINDOW).map((w) => w.name);
  const s = state({ episodeCount: 6, wolverinesInvoked: recent });
  const eligible = eligibleWolverines(s);
  for (const r of recent) assert(!eligible.includes(r), `${r} was used inside the window but is still eligible`);
  assert(eligible.length === WOLVERINES_BANK.length - WOLVERINE_WINDOW, `expected ${WOLVERINES_BANK.length - WOLVERINE_WINDOW} eligible, got ${eligible.length}`);
  assert(WOLVERINES_BANK.length > WOLVERINE_WINDOW, "the bank must be larger than the window or the runner starves");
});

check("rotation: only the WINDOW blocks, not the whole history", () => {
  // Used long ago, then 6 others since → eligible again.
  const s = state({
    episodeCount: 7,
    wolverinesInvoked: ["Duane Hoyt", ...WOLVERINES_BANK.slice(1, 1 + WOLVERINE_WINDOW).map((w) => w.name)],
  });
  assert(eligibleWolverines(s).includes("Duane Hoyt"), "a Wolverine outside the window must become eligible again");
});

check("guard: reusing a Wolverine inside six episodes is rejected", () => {
  const s = state({ episodeCount: 3, wolverinesInvoked: ["Skeeter Ganns"] });
  const v = checkContinuity(s, update({ wolverineUsed: "Skeeter Ganns" }));
  assert(v.some((x) => x.rule === "wolverine:repeat"), `expected a repeat violation, got ${JSON.stringify(v)}`);
});

check("guard: an invented Wolverine is rejected", () => {
  const v = checkContinuity(state(), update({ wolverineUsed: "Chuck Fabricated" }));
  assert(v.some((x) => x.rule === "wolverine:unknown"), "the bank is fixed; invented teammates must be rejected");
});

// --- LADDERS ----------------------------------------------------------------

check("ladder: advances by at most one rung and clamps at the authored end", () => {
  const s = state({ hoytStage: 2 });
  assert(nextContinuityState(s, update({ hoytBeatDelivered: true })).hoytStage === 3, "one rung per episode");
  assert(nextContinuityState(s, update({ hoytBeatDelivered: false })).hoytStage === 2, "no advance without delivery");
  const end = state({ hoytStage: HOYT_LADDER_END + 1 });
  assert(nextContinuityState(end, update({ hoytBeatDelivered: true })).hoytStage === HOYT_LADDER_END + 1, "an exhausted ladder never advances further");
});

check("ladder: an exhausted arc is reported, and inventing a new beat is rejected", () => {
  const spent = state({ arcBeat: AUTHORED_ARC_LENGTH, hoytStage: HOYT_LADDER_END + 1, badgeStage: 99 });
  assert(arcExhausted(spent), "every ladder spent should report exhausted");
  const runners = eligibleRunners(spent);
  assert(runners.allLaddersExhausted, "eligible runners must surface exhaustion");
  assert(!runners.arcBeat.available, "no arc beat is available once spent");
  const v = checkContinuity(spent, update({ arcBeatDelivered: true }));
  assert(v.some((x) => x.rule === "arc:exhausted"), "delivering a beat past the authored end must be rejected");
  // And the prompt must tell the model not to improvise one.
  assert(/RUNNERS-ONLY/.test(renderContinuityBlock(runners)), "the prompt must name the runners-only fallback");
  assert(/Do NOT invent a new arc beat/.test(renderContinuityBlock(runners)), "the prompt must forbid inventing a beat");
});

// --- CYCLE ------------------------------------------------------------------

check("cycle: the dodge ladder climbs, then backslides to 'we'", () => {
  const s = state({ currentDodge: "our group" });
  assert(nextContinuityState(s, update({ endedOnDodge: "those of us who were in the building" })).currentDodge === "those of us who were in the building", "the ladder climbs");
  const top = state({ currentDodge: DODGE_LADDER[DODGE_LADDER.length - 1] });
  assert(nextContinuityState(top, update({ topDodgeUncaught: true })).currentDodge === DODGE_LADDER[0], "the top rung surviving uncaught resets to 'we' — the reset is the bit");
});

check("cycle: weCountThisEpisode resets while the lifetime counter accumulates", () => {
  const s = state({ weCount: 40, weCountThisEpisode: 3 });
  const next = nextContinuityState(s, update({ weSaidCount: 2 }));
  assert(next.weCount === 42, `lifetime counter should accumulate, got ${next.weCount}`);
  assert(next.weCountThisEpisode === 0, "the per-episode cycle must reset");
});

// --- COUNTERS ---------------------------------------------------------------

check("counter: phantom fans accumulate forever and never reset", () => {
  const s = state({ phantomFansTotal: 41_000, episodeCount: 12 });
  const next = nextContinuityState(s, update({ attendanceClaimed: 6492, attendanceReal: 5200 }));
  assert(next.phantomFansTotal === 41_000 + 1292, `expected 42292, got ${next.phantomFansTotal}`);
  assert(next.episodeCount === 13, "episodeCount is the index every window is measured against");
});

// --- GUARDS -----------------------------------------------------------------

check("guard: the unity beat is mandatory", () => {
  const v = checkContinuity(state(), continuityUpdateSchema.parse({ unityBeatPresent: false }));
  assert(v.some((x) => x.rule === "unity:missing"), "a missing unity beat must be rejected");
});

check("guard: the nuclear option is blocked once its budget is spent", () => {
  const s = state({ episodeCount: 10, nuclearOptionFirings: [5, 9] });
  const v = checkContinuity(s, update({ rateLimitedFired: ["nuclearOption"] }));
  assert(v.some((x) => x.rule === "rateLimit:nuclearOption"), `expected a rate-limit violation, got ${JSON.stringify(v)}`);
});

check("guard: attendance must be inflated, unrounded, and not a repeat", () => {
  const notInflated = checkContinuity(state(), update({ attendanceClaimed: 4000, attendanceReal: 5200 }));
  assert(notInflated.some((x) => x.rule === "attendance:not-inflated"), "the bit is that he inflates");
  const rounded = checkContinuity(state(), update({ attendanceClaimed: 6500, attendanceReal: 5200 }));
  assert(rounded.some((x) => x.rule === "attendance:rounded"), "he has never once rounded — the joke is the precision");
  const repeat = checkContinuity(state({ lastAttendanceClaim: 6492 }), update({ attendanceClaimed: 6492, attendanceReal: 5200 }));
  assert(repeat.some((x) => x.rule === "attendance:repeat"), "each night gets its own invented number");
  const good = checkContinuity(state(), update({ attendanceClaimed: 6492, attendanceReal: 5200 }));
  assert(good.length === 0, `a proper claim must pass, got ${JSON.stringify(good)}`);
});

check("guard: a contradicted Hoyt fact is rejected, a compatible one is not", () => {
  const s = state({ hoytFactsEstablished: ["Duane Hoyt played four games in 2004"] });
  const contradicted = checkContinuity(s, update({ hoytFactsAdded: ["Duane Hoyt never played four games in 2004"] }));
  assert(contradicted.some((x) => x.rule === "hoyt:contradiction"), "a direct negation must be caught — she catches contradictions, that is her whole thing");
  const compatible = checkContinuity(s, update({ hoytFactsAdded: ["Duane Hoyt is an orthodontist in Tulsa"] }));
  assert(!compatible.some((x) => x.rule === "hoyt:contradiction"), `an unrelated new fact must pass, got ${JSON.stringify(compatible)}`);
});

check("contradiction detection is conservative — similarity alone is not a contradiction", () => {
  const est = ["Duane Hoyt caught one pass"];
  assert(findHoytContradiction(est, "Duane Hoyt caught one pass in the rain") === null, "elaboration is not contradiction");
  assert(findHoytContradiction(est, "Duane Hoyt did not catch one pass") !== null, "a polarity flip IS contradiction");
  // Auxiliaries and irregular inflection must not defeat it.
  assert(findHoytContradiction(["Duane Hoyt played four games"], "Duane Hoyt never played four games") !== null, "regular-verb negation");
  assert(findHoytContradiction(["Duane Hoyt is real"], "Duane Hoyt is not real") !== null, "copula negation");
});

// KNOWN LIMITATION, pinned deliberately. This is a LEXICAL check: it catches a
// polarity flip on a similarly-worded claim. It does NOT do semantic entailment,
// so a contradiction expressed as a paraphrase with no negator gets through.
// That is the honest boundary of a deterministic check, and it is pinned here so
// the gap is documented rather than discovered in an episode. Real semantic
// contradiction belongs to the LLM fact-check layer, not to this function.
check("KNOWN GAP: paraphrased contradiction with no negator is NOT caught", () => {
  const est = ["Duane Hoyt is an orthodontist in Tulsa"];
  assert(
    findHoytContradiction(est, "Duane Hoyt works as a dentist in Oklahoma City") === null,
    "if this now returns a hit the detector gained semantic reach — good, but update this test and its comment deliberately"
  );
});

// --- THE MODEL CANNOT INVENT STATE -----------------------------------------

check("the update contract cannot express an invented absolute value", () => {
  // No field lets the generator set a total, a stage number, or a phantom count.
  const rejected = continuityUpdateSchema.safeParse({ unityBeatPresent: true, phantomFansTotal: 999_999 });
  assert(!rejected.success, "the schema is strict — unknown fields must be rejected");
  const badDodge = continuityUpdateSchema.safeParse({ unityBeatPresent: true, endedOnDodge: "the franchise family" });
  assert(!badDodge.success, "a dodge rung outside the authored ladder must be rejected");
  const tooManyWes = continuityUpdateSchema.safeParse({ unityBeatPresent: true, weSaidCount: 9 });
  assert(!tooManyWes.success, "the per-episode 'we' count is capped at 3");
});

check("the prompt block names the required runners and forbids invention", () => {
  const block = renderContinuityBlock(eligibleRunners(state({ episodeCount: 5, phantomFansTotal: 41_000, lastAttendanceClaim: 6492 })));
  assert(/Never invent a continuity value/.test(block), "the prompt must forbid invention outright");
  assert(/ATTENDANCE FIGURE/.test(block) && /PRONOUN HUNT/.test(block) && /DUANE HOYT/.test(block) && /UNITY BEAT/.test(block), "every mandatory runner must appear");
  assert(/do not reuse that number/.test(block), "the last claim must be named so it is not repeated");
  assert(/41,000/.test(block), "the running phantom total must be in the prompt");
});

check("rate-limited devices that are on cooldown are named as FORBIDDEN in the prompt", () => {
  const block = renderContinuityBlock(eligibleRunners(state({ episodeCount: 10, nuclearOptionFirings: [5, 9] })));
  assert(/FORBIDDEN THIS EPISODE/.test(block), "blocked devices must be listed");
  assert(/You weren't there/.test(block), "the blocked device must be named");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
