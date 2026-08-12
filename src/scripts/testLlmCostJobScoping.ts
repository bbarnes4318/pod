// The cost ledger must attribute a call to the job that made it.
//
//   npm run test:llm-cost-job-scoping
//
// NETWORK-FREE.
//
// WHY IT EXISTS. `llmCostSince(mark)` used to filter on `id >= mark` and nothing
// else — a process-wide watermark. The worker runs background jobs CONCURRENTLY,
// so "every call since I started" meant "every call the whole worker made while I
// ran", including other jobs' work.
//
// That is not hypothetical. On 2026-08-10 a `generate:script` JobLog carried
// 105,946 input and 36,169 output tokens belonging to concurrent
// `generate:research-brief` jobs — 50% more input than the episode actually
// used. The number survived into a costing exercise and produced a per-episode
// figure that was wrong by half before anyone checked which stages were even in
// it.
//
// The bug is only visible under INTERLEAVING, which is why these tests interleave
// rather than running jobs end to end one after another. A sequential test would
// have passed against the broken implementation.

import assert from "node:assert/strict";
import { llmCostMark, llmCostSince, recordLlmCall, withLlmJob, withLlmStage } from "../lib/providers/llm/costLedger";

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

const call = (stage: string, tkIn: number, tkOut: number) =>
  withLlmStage(stage, () =>
    recordLlmCall({ provider: "stub", model: "m", tkIn, tkOut, durationMs: 1 })
  );

/** Yield to the event loop so two "jobs" genuinely interleave. */
const tick = () => new Promise((r) => setTimeout(r, 0));

async function main() {
  console.log("\nLLM cost ledger — job scoping\n");

  // =========================================================================
  console.log("  -- the concurrency bug this exists to prevent --");

  await check("two interleaved jobs do not see each other's tokens", async () => {
    const markA = llmCostMark();
    let snapA: ReturnType<typeof llmCostSince> | null = null;
    let snapB: ReturnType<typeof llmCostSince> | null = null;

    const jobA = withLlmJob("job-A", async () => {
      call("script:host-writer", 1000, 500);
      await tick();
      call("script:turn-plan", 2000, 1500);
    });

    // Job B starts AFTER A's mark and finishes inside A's window — exactly the
    // shape that corrupted the real measurement.
    const jobB = withLlmJob("job-B", async () => {
      await tick();
      call("topics:research-brief", 100000, 30000);
    });

    await Promise.all([jobA, jobB]);
    snapA = llmCostSince(markA, { jobId: "job-A" });
    snapB = llmCostSince(markA, { jobId: "job-B" });

    assert.equal(snapA.totals.tkIn, 3000, "job A must see ONLY its own 3,000 input tokens");
    assert.equal(snapA.totals.tkOut, 2000);
    assert.equal(snapA.callCount, 2);
    assert.equal(snapB.totals.tkIn, 100000, "job B must see only its own");
    assert.equal(snapB.callCount, 1);
  });

  await check("the unscoped snapshot still sees everything (the old behaviour)", () => {
    // Proves the two really did overlap in one window — without this, the test
    // above could pass simply because nothing concurrent happened.
    const mark = llmCostMark();
    withLlmJob("x", () => call("a", 10, 1));
    withLlmJob("y", () => call("b", 20, 2));
    const all = llmCostSince(mark);
    assert.equal(all.totals.tkIn, 30, "an unscoped caller aggregates every job — that is the bug, reproduced");
  });

  // =========================================================================
  console.log("\n  -- scoping mechanics --");

  await check("jobId propagates across async boundaries", async () => {
    const mark = llmCostMark();
    await withLlmJob("deep", async () => {
      await tick();
      await (async () => {
        await tick();
        call("nested", 7, 3); // several awaits deep
      })();
    });
    const snap = llmCostSince(mark, { jobId: "deep" });
    assert.equal(snap.totals.tkIn, 7, "AsyncLocalStorage must carry the job id through awaits");
  });

  await check("an explicit jobId beats the ambient one", () => {
    const mark = llmCostMark();
    withLlmJob("ambient", () => call("s", 5, 5));
    withLlmJob("other", () => call("s", 9, 9));
    const snap = withLlmJob("ambient", () => llmCostSince(mark, { jobId: "other" }));
    assert.equal(snap.totals.tkIn, 9, "the explicit argument must win over the surrounding context");
  });

  await check("calls made outside any job are not attributed to a job", () => {
    const mark = llmCostMark();
    call("loose", 11, 1); // no withLlmJob wrapper
    withLlmJob("j", () => call("owned", 22, 2));
    assert.equal(llmCostSince(mark, { jobId: "j" }).totals.tkIn, 22);
    assert.equal(llmCostSince(mark).totals.tkIn, 33, "unscoped still totals both");
  });

  await check("scripts with no job context keep the old behaviour", () => {
    // The harnesses and one-off scripts have no jobs and nothing concurrent, so
    // scoping must not silently zero them out.
    const mark = llmCostMark();
    call("standalone", 40, 4);
    const snap = llmCostSince(mark);
    assert.equal(snap.totals.tkIn, 40);
    assert.equal(snap.callCount, 1);
  });

  await check("the mark still bounds the window", () => {
    withLlmJob("k", () => call("before", 500, 50));
    const mark = llmCostMark();
    withLlmJob("k", () => call("after", 6, 1));
    assert.equal(
      llmCostSince(mark, { jobId: "k" }).totals.tkIn,
      6,
      "scoping by job must not resurrect calls from before the mark"
    );
  });

  console.log(failed === 0 ? "\nAll job-scoping checks passed.\n" : `\n${failed} check(s) FAILED.\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
