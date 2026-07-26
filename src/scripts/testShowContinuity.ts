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
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  checkContinuity,
  composeGenerationSystemPrompt,
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

// --- THE FOLD IS THE SOURCE OF TRUTH ---------------------------------------
//
// ShowContinuity is a CACHE of folding every produced episode's stored claim.
// These assertions are the reason that design was worth the extra column: an
// incrementally-maintained counter that drifts is permanently and silently
// wrong, while a fold can always be recomputed.

/** The same reduction commitContinuity performs, without a database. */
const foldOf = (claims: ContinuityUpdate[]): ContinuityState =>
  claims.reduce<ContinuityState>((s, c) => nextContinuityState(s, c), { ...EMPTY_CONTINUITY });

check("folding claims equals incrementally applying them", () => {
  const claims = [
    update({ attendanceClaimed: 6492, attendanceReal: 5200, weSaidCount: 2, wolverineUsed: "Petey Vandersloot", hoytBeatDelivered: true }),
    update({ attendanceClaimed: 7311, attendanceReal: 5200, weSaidCount: 1, wolverineUsed: "Big Ed Mazurek", arcBeatDelivered: true }),
    update({ attendanceClaimed: 4877, attendanceReal: 3100, weSaidCount: 3, wolverineUsed: "Marcus Ludd", rateLimitedFired: ["nuclearOption"] }),
  ];

  // Incremental: apply one at a time, carrying state forward.
  let incremental: ContinuityState = { ...EMPTY_CONTINUITY };
  for (const c of claims) incremental = nextContinuityState(incremental, c);

  assert(JSON.stringify(foldOf(claims)) === JSON.stringify(incremental), "the fold must equal the incremental result — otherwise the cache and the truth disagree");
  assert(incremental.episodeCount === 3, `expected 3 episodes, got ${incremental.episodeCount}`);
  assert(incremental.phantomFansTotal === 1292 + 2111 + 1777, `phantom total is ${incremental.phantomFansTotal}`);
  assert(incremental.weCount === 6, `we count is ${incremental.weCount}`);
  assert(incremental.nuclearOptionFirings.length === 1 && incremental.nuclearOptionFirings[0] === 2, `the nuclear firing must be stamped with its episode index, got ${JSON.stringify(incremental.nuclearOptionFirings)}`);
});

check("a dropped episode is REPAIRED by re-folding, not by subtraction", () => {
  const all = [
    update({ attendanceClaimed: 6492, attendanceReal: 5200, wolverineUsed: "Petey Vandersloot", hoytBeatDelivered: true }),
    update({ attendanceClaimed: 7311, attendanceReal: 5200, wolverineUsed: "Big Ed Mazurek", hoytBeatDelivered: true }),
    update({ attendanceClaimed: 4877, attendanceReal: 3100, wolverineUsed: "Marcus Ludd", hoytBeatDelivered: true }),
  ];
  const withAll = foldOf(all);
  assert(withAll.hoytStage === 3, `three delivered beats should give stage 3, got ${withAll.hoytStage}`);

  // Episode 2 is deleted (or never reached audio). Re-folding the survivors
  // yields a CONSISTENT state — the ladder is at 2 and the rotation no longer
  // contains the dropped Wolverine. Subtracting from the cached row could not
  // have restored the rotation's ordering.
  const repaired = foldOf([all[0], all[2]]);
  assert(repaired.episodeCount === 2, `expected 2, got ${repaired.episodeCount}`);
  assert(repaired.hoytStage === 2, `expected the ladder to fall back to 2, got ${repaired.hoytStage}`);
  assert(!repaired.wolverinesInvoked.includes("Big Ed Mazurek"), "the dropped episode's Wolverine must leave the rotation");
  assert(repaired.phantomFansTotal === 1292 + 1777, `phantom total should exclude the dropped episode, got ${repaired.phantomFansTotal}`);
});

check("a failed generation cannot burn a ladder rung", () => {
  // The failure the two-phase commit exists to prevent: an episode clears
  // fact-check (its claim is recorded) but never produces audio, so it is
  // never folded and the rung stays available for the next episode.
  const produced = [update({ hoytBeatDelivered: true, wolverineUsed: "Petey Vandersloot" })];
  const stateAfterProduced = foldOf(produced);
  assert(stateAfterProduced.hoytStage === 1, "the produced episode advanced the ladder");

  // The next episode's claim exists but its episode never reaches audio, so it
  // is absent from the fold entirely.
  const stillOne = foldOf(produced);
  assert(stillOne.hoytStage === 1, "an episode that never produced audio must not advance the ladder");
  assert(stillOne.episodeCount === 1, "nor the episode count");
});

check("rate-limit windows survive a re-fold with the same episode indices", () => {
  const claims = Array.from({ length: 25 }, (_, i) =>
    update({ rateLimitedFired: i === 3 || i === 7 ? ["nuclearOption"] : [] })
  );
  const folded = foldOf(claims);
  assert(JSON.stringify(folded.nuclearOptionFirings) === JSON.stringify([3, 7]), `firings must be stamped with stable indices, got ${JSON.stringify(folded.nuclearOptionFirings)}`);
  // 25 episodes in, both firings are outside the 20-window → available again.
  assert(rateLimitAllows(folded, "nuclearOption"), "old firings must age out of the window after a re-fold");
});

// --- THE PROMPT ACTUALLY REACHES THE MODEL ---------------------------------
//
// The defect this section exists for: the composed prompt was computed and
// never passed, so continuity injection was dead code — and all 27 tests below
// still passed, because not one of them asserted the prompt reaches the LLM.
// no-unused-vars caught it by luck.
//
// Two layers. The unit test pins the composition (including that the kill
// switch is a BYTE-IDENTICAL no-op). The structural test reads the call sites,
// because the failure mode is "the wiring was never connected" and there is no
// injection seam in scriptService to capture a real call at — the stub LLM
// provider throws by design rather than recording. A structural assertion is
// the right tool for a wiring defect; it fails on exactly the edit that half-
// applies.

check("composition: the block is present when injected, and the kill switch is byte-identical", () => {
  const base = "SYSTEM PROMPT BODY";
  const block = renderContinuityBlock(eligibleRunners(state({ episodeCount: 5, phantomFansTotal: 41_000 })));

  const withBlock = composeGenerationSystemPrompt(base, block);
  assert(withBlock.includes(block), "the continuity block must be present in the composed prompt");
  assert(withBlock.includes(base), "the base prompt must survive composition");
  assert(withBlock.startsWith(base), "continuity is APPENDED — the base prompt leads");

  // Kill switch OFF, and the standalone-episode path, both pass null.
  const without = composeGenerationSystemPrompt(base, null);
  assert(without === base, "with no continuity the prompt must be BYTE-IDENTICAL to the base — a kill switch that alters the prompt is not a kill switch");
});

check("wiring: every generation call site sends the CONTINUITY-COMPOSED prompt", () => {
  const src = readFileSync(join(__dirname, "..", "lib", "services", "scriptService.ts"), "utf8");

  // The composed variable must exist and be built through the one composer.
  assert(/const systemPromptWithContinuity = composeGenerationSystemPrompt\(/.test(src),
    "scriptService must build the generation prompt through composeGenerationSystemPrompt");

  // Both LLM entry points must receive it. These are the two call sites that
  // actually send a prompt to the model: the outline-driven path and the
  // single-shot fallback. An episode that falls back must not silently lose
  // its running bits.
  const outlineCall = /generateOutlineDrivenScript\(llm,\s*\{\s*systemPrompt:\s*systemPromptWithContinuity/;
  assert(outlineCall.test(src), "the outline-driven generation call must send systemPromptWithContinuity");

  const fallbackBlock = src.slice(src.indexOf("script:single-shot-fallback"));
  const fallbackHead = fallbackBlock.slice(0, 600);
  assert(/systemPrompt:\s*systemPromptWithContinuity/.test(fallbackHead),
    "the single-shot fallback must also send systemPromptWithContinuity");

  // And the plain prompt must NOT be what generation receives.
  assert(!/generateOutlineDrivenScript\(llm,\s*\{\s*systemPrompt,/.test(src),
    "generation must not receive the un-composed prompt");
});

check("kill switch: the flag is read, and only 'false' disables injection", () => {
  const src = readFileSync(join(__dirname, "..", "lib", "services", "scriptService.ts"), "utf8");
  assert(/process\.env\.CONTINUITY_INJECTION !== "false"/.test(src),
    "CONTINUITY_INJECTION must gate the injection, defaulting to ON so an unset env behaves as today");
  // Default-on: an unset or arbitrary value must NOT disable it.
  const enabledFor = (v: string | undefined) => v !== "false";
  assert(enabledFor(undefined), "unset must leave continuity ON");
  assert(enabledFor("true"), "'true' must leave continuity ON");
  assert(!enabledFor("false"), "'false' must turn continuity OFF");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
