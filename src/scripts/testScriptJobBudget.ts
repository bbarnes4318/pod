// A job with no wall clock is a job with no end.
//
//   npm run test:script-job-budget
//
// NETWORK-FREE.
//
// WHY IT EXISTS. On 2026-08-24 an operator clicked "generate script" and
// /admin/job-logs read "Running 4096s" — sixty-eight minutes — and kept
// climbing. Nothing was broken. Every timeout in the pipeline governs ONE HTTP
// request, and they multiply: 240s x 3 attempts x N chain rungs x 3 rate-window
// passes x 21 roles per episode. No layer ever multiplied those out and said
// no, so one degraded provider account did not fail an episode — it stretched
// it, without limit.
//
// The tests below pin the four properties that make the ceiling real:
//   1. the budget bounds the JOB, not the request;
//   2. nothing is STARTED once the clock is spent;
//   3. no wait is taken that is guaranteed to end past the deadline;
//   4. the last request a job makes cannot outlive the deadline (the clamp).
//
// And the property that keeps it honest: with no budget in scope — a script, a
// test, an admin action — every one of these functions is a no-op.

import assert from "node:assert/strict";
import {
  DEFAULT_SCRIPT_JOB_BUDGET_MS,
  JobBudgetExceededError,
  MAX_SCRIPT_JOB_BUDGET_MS,
  MIN_SCRIPT_JOB_BUDGET_MS,
  assertJobBudget,
  budgetedWaitMs,
  clampTimeoutToBudget,
  currentJobBudget,
  jobBudgetExpired,
  jobBudgetRemainingMs,
  scriptJobBudgetMs,
  withJobBudget,
} from "../lib/jobBudget";

let failed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL ${name}\n       ${(err as Error).message}`);
  }
}

const T0 = 1_000_000;
const MINUTE = 60_000;

async function main() {
  console.log("\nScript job wall-clock budget\n");

  console.log("  -- no budget in scope changes nothing --");

  await check("remaining time is Infinity outside a budget", () => {
    assert.equal(jobBudgetRemainingMs(T0), Number.POSITIVE_INFINITY);
    assert.equal(jobBudgetExpired(T0), false);
    assert.equal(currentJobBudget(), undefined);
  });

  await check("assert, wait and clamp are no-ops outside a budget", () => {
    assert.doesNotThrow(() => assertJobBudget("anywhere", T0));
    assert.equal(budgetedWaitMs(10 * MINUTE, "a long wait", T0), 10 * MINUTE);
    assert.equal(clampTimeoutToBudget(240_000, T0), 240_000);
  });

  console.log("\n  -- inside a budget --");

  await check("remaining time counts down from the budget", () => {
    withJobBudget({ label: "job", budgetMs: 10 * MINUTE, now: T0 }, () => {
      assert.equal(jobBudgetRemainingMs(T0), 10 * MINUTE);
      assert.equal(jobBudgetRemainingMs(T0 + 4 * MINUTE), 6 * MINUTE);
      assert.equal(jobBudgetExpired(T0 + 10 * MINUTE), true);
    });
  });

  await check("a spent budget stops the next step and names it", () => {
    withJobBudget({ label: "generate:script for episode e1", budgetMs: 5 * MINUTE, now: T0 }, () => {
      assert.doesNotThrow(() => assertJobBudget("the next rung", T0 + MINUTE));
      const err = (() => {
        try {
          assertJobBudget("role 'script_movement' fallback chain", T0 + 6 * MINUTE);
          return null;
        } catch (e) {
          return e as JobBudgetExceededError;
        }
      })();
      assert.ok(err instanceof JobBudgetExceededError, "must raise the typed budget error");
      assert.match(err!.message, /generate:script for episode e1/, "names the job");
      assert.match(err!.message, /script_movement/, "names the step that did NOT run");
      assert.match(err!.message, /SCRIPT_JOB_BUDGET_MS/, "names the knob the operator can turn");
      assert.equal(err!.elapsedMs, 6 * MINUTE);
      assert.equal(err!.budgetMs, 5 * MINUTE);
    });
  });

  console.log("\n  -- waits that cannot fit are not taken --");

  await check("a wait that fits is returned unchanged", () => {
    withJobBudget({ label: "job", budgetMs: 10 * MINUTE, now: T0 }, () => {
      assert.equal(budgetedWaitMs(60_000, "rate window", T0), 60_000);
    });
  });

  await check("a 60s rate-window wait with 10s left is refused, not shortened", () => {
    // Shortening would be worse than refusing: the chain would wake early,
    // still be inside the provider's window, and fail anyway — having spent
    // the last of the operator's patience to get there.
    withJobBudget({ label: "job", budgetMs: 10 * MINUTE, now: T0 }, () => {
      const at = T0 + 10 * MINUTE - 10_000;
      assert.throws(
        () => budgetedWaitMs(60_000, "role 'x' rate-window wait", at),
        (e: unknown) => {
          assert.ok(e instanceof JobBudgetExceededError);
          assert.match((e as Error).message, /needed 60s, 10s left/, "says what it declined to wait for");
          return true;
        }
      );
    });
  });

  console.log("\n  -- the clamp is what makes the ceiling hard --");

  await check("a request timeout is cut to the remaining budget", () => {
    withJobBudget({ label: "job", budgetMs: 10 * MINUTE, now: T0 }, () => {
      assert.equal(clampTimeoutToBudget(240_000, T0), 240_000, "full timeout while there is room");
      assert.equal(
        clampTimeoutToBudget(240_000, T0 + 10 * MINUTE - 30_000),
        30_000,
        "30s of budget left means a 30s timeout, not a 240s one"
      );
    });
  });

  await check("the clamp never returns a timeout that aborts instantly", () => {
    // An AbortController armed with 0 fires before the socket opens, and the
    // error categorizer reads a sub-second failure as evidence of a provider
    // defect. Our own deadline must not be able to forge that evidence.
    withJobBudget({ label: "job", budgetMs: MINUTE, now: T0 }, () => {
      assert.equal(clampTimeoutToBudget(240_000, T0 + 2 * MINUTE), 1_000);
    });
  });

  console.log("\n  -- nesting --");

  await check("an inner budget cannot extend an outer one", () => {
    // The outer budget is the promise made to the operator watching the job.
    withJobBudget({ label: "outer", budgetMs: 5 * MINUTE, now: T0 }, () => {
      withJobBudget({ label: "inner", budgetMs: 60 * MINUTE, now: T0 }, () => {
        assert.equal(jobBudgetRemainingMs(T0), 5 * MINUTE, "the tighter deadline wins");
      });
    });
  });

  console.log("\n  -- the configured budget --");

  await check("the default is 25 minutes", () => {
    assert.equal(scriptJobBudgetMs({} as NodeJS.ProcessEnv), DEFAULT_SCRIPT_JOB_BUDGET_MS);
    assert.equal(DEFAULT_SCRIPT_JOB_BUDGET_MS, 25 * MINUTE);
  });

  await check("a real 4096-second run is over the default budget", () => {
    // The run that prompted all of this. If this assertion ever stops holding,
    // the default has been raised past the failure it was chosen to catch.
    assert.ok(
      4096 * 1000 > DEFAULT_SCRIPT_JOB_BUDGET_MS,
      "the 2026-08-24 run must be outside the default budget"
    );
  });

  await check("SCRIPT_JOB_BUDGET_MS is honoured within a sane band", () => {
    assert.equal(scriptJobBudgetMs({ SCRIPT_JOB_BUDGET_MS: "600000" } as unknown as NodeJS.ProcessEnv), 10 * MINUTE);
    assert.equal(
      scriptJobBudgetMs({ SCRIPT_JOB_BUDGET_MS: "1000" } as unknown as NodeJS.ProcessEnv),
      MIN_SCRIPT_JOB_BUDGET_MS,
      "a too-small value is raised to the floor rather than failing every job"
    );
    assert.equal(
      scriptJobBudgetMs({ SCRIPT_JOB_BUDGET_MS: "999999999" } as unknown as NodeJS.ProcessEnv),
      MAX_SCRIPT_JOB_BUDGET_MS,
      "and a typo cannot restore 'no ceiling at all'"
    );
    assert.equal(
      scriptJobBudgetMs({ SCRIPT_JOB_BUDGET_MS: "not-a-number" } as unknown as NodeJS.ProcessEnv),
      DEFAULT_SCRIPT_JOB_BUDGET_MS
    );
  });

  console.log("\n  -- the budget survives async boundaries --");

  await check("nested async helpers see their caller's budget", async () => {
    await withJobBudget({ label: "job", budgetMs: 10 * MINUTE, now: T0 }, async () => {
      await Promise.resolve();
      assert.ok(Number.isFinite(jobBudgetRemainingMs()), "an awaited continuation is still inside the budget");
      assert.equal(currentJobBudget()?.label, "job");
    });
  });

  console.log(
    failed === 0
      ? "\nAll script job budget checks passed.\n"
      : `\n${failed} check(s) FAILED.\n`
  );
  if (failed > 0) process.exit(1);
}

void main();
