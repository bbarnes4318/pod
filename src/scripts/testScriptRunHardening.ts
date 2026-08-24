// The fixes only work if they are still WIRED IN.
//
//   npm run test:script-run-hardening
//
// NETWORK-FREE. Reads source files; starts nothing.
//
// WHY IT EXISTS. Every piece of the 2026-08-24 repair — a wall-clock budget, an
// episode single-flight lock, a heartbeat, a BullMQ lock sized for LLM work, a
// timeout on the one transport that had none — is a few lines in a large file
// that is edited often. Each of them is individually easy to drop in a refactor
// and impossible to miss the absence of until an operator is watching a counter
// climb past an hour again. The unit tests prove the parts work; this proves
// they are still connected to the pipeline that needed them.
//
// It asserts on source text on purpose, the same way testPipelineChaining does:
// the alternative is booting a worker, a queue, and Redis to observe a wiring
// decision that is plainly visible in the file.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

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

const src = (rel: string) => readFileSync(join(process.cwd(), "src", rel), "utf8");

function main() {
  console.log("\nScript-run hardening — the wiring\n");

  const worker = src("lib/queue/worker.ts");
  const handler = (() => {
    const start = worker.indexOf("async function handleScriptGeneration");
    assert.ok(start > 0, "handleScriptGeneration must exist");
    const end = worker.indexOf("async function handleFactChecking", start);
    return worker.slice(start, end > start ? end : undefined);
  })();

  console.log("  -- two runs at once --");

  check("the script handler takes the episode lock", () => {
    assert.match(
      handler,
      /acquireEpisodeScriptLock\(\s*job\.data\.episodeId/,
      "without this, a stalled re-delivery or a second replica runs the same episode twice"
    );
  });

  check("the lock is taken BEFORE the running row is written", () => {
    const lockAt = handler.indexOf("acquireEpisodeScriptLock");
    const rowAt = handler.indexOf('status: "running"');
    assert.ok(lockAt > 0 && rowAt > 0);
    assert.ok(
      lockAt < rowAt,
      "a declined duplicate must never create a second row with a climbing timer — that is the symptom being fixed"
    );
  });

  check("a declined duplicate returns instead of throwing", () => {
    const blocked = handler.slice(handler.indexOf("isBlocked(lock)"), handler.indexOf("Create JobLog record"));
    assert.match(blocked, /return \{[^}]*skipped: true/, "a throw would hand the duplicate to BullMQ's retry policy");
    assert.doesNotMatch(blocked, /^\s*throw /m, "and would run it twice more");
  });

  check("the lock is always released", () => {
    assert.match(handler, /finally \{[\s\S]*lock\.release\(\)/, "a lock held after a crash strands the episode");
  });

  check("BullMQ's stall detector is sized for LLM work", () => {
    // The 30s default declares a twenty-minute job stalled on one hiccup and
    // re-delivers it while the original is still running.
    assert.match(worker, /lockDuration: JOB_LOCK_DURATION_MS/);
    assert.match(worker, /const JOB_LOCK_DURATION_MS = 5 \* 60_000/);
    const workers = worker.match(/new Worker\(/g) ?? [];
    const locks = worker.match(/lockDuration: JOB_LOCK_DURATION_MS/g) ?? [];
    assert.equal(locks.length, workers.length, "every worker lane needs the same lock duration");
  });

  console.log("\n  -- a run that never ends --");

  check("the script handler runs under a wall-clock budget", () => {
    assert.match(handler, /withJobBudget\(/, "the job itself must be bounded, not just each request");
    assert.match(handler, /scriptJobBudgetMs\(\)/);
  });

  check("a budget stop is recorded as a budget stop", () => {
    assert.match(handler, /budgetExceeded: true/, "'we stopped it' and 'it broke' are different operator questions");
  });

  check("the routing chain refuses to start a rung with no clock left", () => {
    const routing = src("lib/providers/llm/routing.ts");
    assert.match(routing, /jobBudgetRemainingMs\(\) <= 0/, "this is the multiplier that produced a 4096s run");
    assert.match(routing, /budgetedWaitMs\(/, "and the rate-window wait must fit inside the budget too");
  });

  check("provider request timeouts are clamped to the remaining budget", () => {
    const transport = src("lib/providers/llm/openaiCompatible.ts");
    assert.match(
      transport,
      /clampTimeoutToBudget\(this\.config\.timeoutMs\)/,
      "the clamp is what makes the budget a ceiling rather than a suggestion"
    );
  });

  check("the Anthropic transport has a timeout at all", () => {
    // It had none: a bare fetch with no AbortSignal on the PAID rung, so a
    // connection that opened and went quiet held the job indefinitely.
    const anthropic = src("lib/providers/llm/anthropic.ts");
    assert.match(anthropic, /signal: controller\.signal/, "the request must be abortable");
    assert.match(anthropic, /clampTimeoutToBudget\(this\.timeoutMs\)/, "and bounded by the job budget");
    assert.match(anthropic, /ANTHROPIC_DEFAULT_TIMEOUT_MS = 240_000/);
  });

  check("a budget stop is not swallowed by a stage's error recovery", () => {
    // Each of these catches responds to failure by spending MORE time. Applied
    // to an over-budget job they would do the one thing the budget forbids, and
    // the creative one would ship a deliberately degraded script for a run whose
    // only defect was slowness.
    const service = src("lib/services/scriptService.ts");
    const rethrows = service.match(/if \((\w+) instanceof JobBudgetExceededError\) throw \1;/g) ?? [];
    assert.ok(
      rethrows.length >= 3,
      `every recovery path must let the budget error through (found ${rethrows.length}, expected the creative, self-verify and antithesis catches)`
    );
  });

  console.log("\n  -- a counter that means something --");

  check("the script handler heartbeats its row", () => {
    assert.match(handler, /startJobLogHeartbeat\(\{ db, jobLogId: jobLog\.id \}\)/);
    assert.match(handler, /heartbeat\.stop\(\)/, "and stops beating when the job ends");
  });

  check("the admin table reads the heartbeat", () => {
    const page = src("app/admin/job-logs/page.tsx");
    assert.match(page, /heartbeatState\(/, "a climbing counter with no liveness signal is what caused the panic");
    assert.match(page, /stranded/, "a stale row must be called what it is");
  });

  check("a skipped duplicate does not wear the running badge", () => {
    const page = src("app/admin/job-logs/page.tsx");
    assert.match(page, /status === "skipped"/);
  });

  console.log(
    failed === 0 ? "\nAll script-run hardening checks passed.\n" : `\n${failed} check(s) FAILED.\n`
  );
  if (failed > 0) process.exit(1);
}

main();
