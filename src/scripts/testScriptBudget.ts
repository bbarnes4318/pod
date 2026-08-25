// The script-generation wall-clock ceiling.
//
// These are REAL calls into the rule, not greps of worker.ts. That distinction
// is the whole reason scriptBudget.ts is its own module: worker.ts builds a
// Redis connection at import, so everything asserting on it has to read its
// source as text, and a sibling test doing exactly that spent a release failing
// against correct code because a `for` header had been reworded.

import {
  BUDGET_MULTIPLE,
  MIN_BUDGET_MS,
  budgetExceededMessage,
  budgetExceededOperatorNote,
  fmtMinutes,
  scriptGenerationBudgetMs,
} from "../lib/queue/scriptBudget";
import { QUALITY_TIERS, tierInfo } from "../lib/providers/llm/qualityTiers";

let passed = 0;
let failed = 0;

function check(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : e}`);
  }
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

console.log("Script generation budget\n");

check("every tier gets a budget that clears its own promised window", () => {
  for (const tier of QUALITY_TIERS) {
    const [, upper] = tierInfo(tier).approxMinutes;
    const budget = scriptGenerationBudgetMs(tier, {} as NodeJS.ProcessEnv);
    assert(
      budget > upper * 60_000,
      `${tier}: a budget of ${fmtMinutes(budget)} would cut off runs inside the ${upper} min this tier openly ` +
        `promises the user — the ceiling must never fire on the wait the product asked them to accept`
    );
    // AT LEAST the multiple, not exactly it. MEASURED_FLOOR_MS may raise a
    // tier's budget above its advertised window (it does, for both paid
    // tiers) — a floor derived from what this deployment actually measures is
    // allowed to be more generous than the tier's promise, and must never be
    // less.
    assert(
      budget >= upper * BUDGET_MULTIPLE * 60_000,
      `${tier}: budget must be at least ${BUDGET_MULTIPLE}x the promised upper bound`
    );
  }
});

check("the free tier's slower window buys it a proportionally larger budget", () => {
  // Free honestly takes 8-12 minutes. A single ceiling for all tiers would
  // either kill free runs that were behaving exactly as advertised, or be so
  // loose on premium that it stopped bounding anything.
  const free = scriptGenerationBudgetMs("free", {} as NodeJS.ProcessEnv);
  const premium = scriptGenerationBudgetMs("premium", {} as NodeJS.ProcessEnv);
  assert(free > premium, "free must get more room than premium — its promised window is three times longer");
});

check("the paid budget clears the measured cold open, and is still bounded", () => {
  const premium = scriptGenerationBudgetMs("premium", {} as NodeJS.ProcessEnv);

  // THIS LOWER BOUND IS EVIDENCE, NOT TASTE, and it replaces a guess of mine
  // that production disproved. The original assertion here was `<= 20 min`,
  // written on the reasoning that a longer ceiling "stops being a bound a
  // waiting person benefits from". Then the worker log of 2026-08-25 timed a
  // Premium run's COLD OPEN alone at ~10.3 minutes, with no script movement
  // started — so a 12-minute ceiling (and a 20-minute one) cuts off runs that
  // were still working, and reports "a stuck AI provider" for a pipeline that
  // was not stuck. A bound that fires on healthy work is worse than no bound:
  // it destroys paid work AND misattributes the cause.
  assert(
    premium >= 25 * 60_000,
    `a paid ceiling of ${fmtMinutes(premium)} is under the ~10 min this deployment's cold open alone measured, ` +
      `with 3x headroom — it would kill runs mid-write and blame the provider`
  );

  // Still a stuck-detector: unbounded means "forever", which is the failure the
  // budget exists to convert into a real error.
  assert(premium <= 45 * 60_000, "a paid ceiling over 45 minutes is not bounding anything");
});

check("an operator override is honoured", () => {
  const env = { SCRIPT_GENERATION_BUDGET_MS: "900000" } as unknown as NodeJS.ProcessEnv;
  assert(scriptGenerationBudgetMs("premium", env) === 900_000, "an explicit, sane override must win over the tier default");
});

check("an override too small to be meaningful is refused, not obeyed", () => {
  // Below a minute the ceiling cannot tell a wedged run from a healthy one, so
  // honouring it would manufacture failures rather than bound them.
  for (const bad of ["0", "1000", "-5", "", "abc", "59999"]) {
    const env = { SCRIPT_GENERATION_BUDGET_MS: bad } as unknown as NodeJS.ProcessEnv;
    const got = scriptGenerationBudgetMs("premium", env);
    assert(
      got >= MIN_BUDGET_MS && got === scriptGenerationBudgetMs("premium", {} as NodeJS.ProcessEnv),
      `SCRIPT_GENERATION_BUDGET_MS=${JSON.stringify(bad)} must fall back to the tier default, got ${got}`
    );
  }
});

check("the creator's message survives the console's 220-character truncation", () => {
  // humanFailure() (studio/productionProgress.ts) cuts at 217 + "…". A message
  // longer than that reaches the user severed mid-sentence.
  for (const tier of QUALITY_TIERS) {
    const msg = budgetExceededMessage(17 * 60_000, tier);
    assert(msg.length <= 220, `${tier}: message is ${msg.length} chars and would be truncated in the console`);
  }
});

check("the creator is told it is not their fault and that retrying is safe", () => {
  const msg = budgetExceededMessage(17 * 60_000, "premium");
  assert(/not\s+your episode/i.test(msg), "the message must not read as though the user's episode was rejected");
  assert(/again is safe|retry/i.test(msg), "a stopped episode with no stated next step is just a dead end");
});

check("the operator is pointed at the role that stopped answering", () => {
  const note = budgetExceededOperatorNote(12 * 60_000, "premium");
  assert(/\[LLMRouting\]/.test(note), "the note must name the log lines that identify the stuck role");
  assert(/SCRIPT_GENERATION_BUDGET_MS/.test(note), "the note must name the knob that changes the ceiling");
});

check("durations read as minutes a person can act on", () => {
  assert(fmtMinutes(12 * 60_000) === "12 minutes", `got ${fmtMinutes(12 * 60_000)}`);
  assert(fmtMinutes(90_000) === "1.5 minutes", `got ${fmtMinutes(90_000)}`);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
