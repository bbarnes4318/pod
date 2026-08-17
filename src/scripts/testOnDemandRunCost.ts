// Telling someone what a run costs, or admitting you don't know.
//
//   npm run test:on-demand-cost
//
// NETWORK-FREE.
//
// WHY IT EXISTS. Scheduled topic generation dropped from eight runs a day to
// two, because the background fan-out (47 topic jobs and 225 research briefs in
// 24 hours on 2026-08-16) was spending the provider rate limits that the
// operator's own episodes then failed on. Extra runs are still available on
// demand — but a button that spends money silently is how the eight-a-day habit
// forms in the first place, so it has to state a price.
//
// The one thing this must never do is invent a number. An estimate attached to
// a real spend decision is only useful if it is measured, so "unknown" is a
// first-class answer here rather than a fallback to something plausible.

import assert from "node:assert/strict";
import {
  costOfRun,
  estimateOnDemandRunCost,
  formatUsd,
  median,
  summarize,
} from "../lib/services/onDemandRunCost";
import { scheduledTopicRunsPerDay, topicsGenerateCron } from "../lib/services/sportsIngestSchedule";

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

async function main() {
  console.log("\nOn-demand run cost — measured, or honestly unknown\n");

  console.log("  -- the schedule actually dropped --");

  await check("topic generation is scheduled a couple of times a day, not eight", () => {
    const runs = scheduledTopicRunsPerDay(topicsGenerateCron());
    assert.ok(
      runs <= 3,
      `${runs} scheduled runs/day (cron '${topicsGenerateCron()}') — the background sweep is what starved the foreground pipeline`
    );
    assert.ok(runs >= 1, "topics still have to refresh on their own at least daily");
  });

  await check("the per-day count reads both step and list crons", () => {
    assert.equal(scheduledTopicRunsPerDay("30 */3 * * *"), 8, "the old cadence");
    assert.equal(scheduledTopicRunsPerDay("30 5,17 * * *"), 2, "the new one");
    assert.equal(scheduledTopicRunsPerDay("0 6 * * *"), 1);
    assert.equal(scheduledTopicRunsPerDay("0 * * * *"), 24);
  });

  console.log("\n  -- reading a real ledger row --");

  await check("a recorded ledger total is read", () => {
    assert.equal(costOfRun({ llmCost: { totalUsd: 0.42 } }), 0.42);
  });

  await check("a genuinely free run counts as zero, not as missing data", () => {
    // Every free-tier provider is unpriced. Discarding zeros would leave the
    // free tier permanently "unknown" while it is in fact the known case.
    assert.equal(costOfRun({ llmCost: { totalUsd: 0 } }), 0);
  });

  await check("rows without a ledger are skipped rather than counted as free", () => {
    assert.equal(costOfRun(null), null);
    assert.equal(costOfRun({}), null);
    assert.equal(costOfRun({ llmCost: {} }), null);
    assert.equal(costOfRun({ llmCost: { totalUsd: "not a number" } }), null);
  });

  console.log("\n  -- the figure itself --");

  await check("the median is used, so one runaway run cannot set the price", () => {
    // A 970s topic sweep that failed at the last rung paid for every rung
    // before it. Under a mean, that single row would define the estimate.
    const m = median([0.10, 0.12, 0.11, 9.90])!;
    assert.ok(Math.abs(m - 0.115) < 1e-9, `median was ${m}; a mean would have been ~2.56`);
  });

  await check("a wide spread is disclosed instead of hidden behind one number", () => {
    const s = summarize([0.05, 0.10, 1.60], "topic generation");
    assert.match(s.summary, /ranged/, `spread must be surfaced: "${s.summary}"`);
    assert.match(s.summary, /\$1\.60/);
  });

  await check("a tight spread just states the median", () => {
    const s = summarize([0.10, 0.11, 0.12], "topic generation");
    assert.doesNotMatch(s.summary, /ranged/);
    assert.match(s.summary, /3 runs/);
  });

  await check("no history says so, and quotes no price", () => {
    const s = summarize([], "topic generation");
    assert.equal(s.medianUsd, null);
    assert.equal(s.sampleSize, 0);
    assert.match(s.summary, /unknown/i);
    assert.doesNotMatch(s.summary, /\$\d/, `an unknown cost must not carry a figure: "${s.summary}"`);
  });

  await check("sub-cent runs are not rounded away to $0.00", () => {
    assert.equal(formatUsd(0), "$0.00");
    assert.equal(formatUsd(0.004), "<$0.01");
    assert.equal(formatUsd(0.42), "$0.42");
  });

  console.log("\n  -- against a database --");

  await check("only completed runs of the requested type are sampled", async () => {
    let seen: any = null;
    const db = {
      jobLog: {
        findMany: async (args: any) => {
          seen = args;
          return [{ output: { llmCost: { totalUsd: 0.2 } } }, { output: { llmCost: { totalUsd: 0.4 } } }];
        },
      },
    };
    const est = await estimateOnDemandRunCost(db, "generate:topics");
    assert.equal(seen.where.jobType, "generate:topics");
    assert.equal(seen.where.status, "completed", "a failed run's partial spend is not the price of a run");
    assert.ok(Math.abs(est.medianUsd! - 0.3) < 1e-9, `median of the two runs, got ${est.medianUsd}`);
    assert.equal(est.sampleSize, 2);
  });

  await check("a database failure degrades to 'unknown', never to a made-up price", async () => {
    const db = { jobLog: { findMany: async () => { throw new Error("db down"); } } };
    const est = await estimateOnDemandRunCost(db, "generate:topics");
    assert.equal(est.medianUsd, null);
    assert.match(est.summary, /unknown/i);
  });

  console.log(failed === 0 ? "\nAll on-demand cost checks passed.\n" : `\n${failed} check(s) FAILED.\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
