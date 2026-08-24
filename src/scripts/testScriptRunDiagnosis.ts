// A diagnosis that points the wrong way is worse than no diagnosis.
//
//   npm run test:script-run-diagnosis
//
// NETWORK-FREE. Plain objects shaped exactly as costLedger writes them; no
// database, no queue, no provider.
//
// WHY IT EXISTS. `diagnose:script-runs` answers one question about a slow run:
// was it WAITING on a saturated account, or were the CALLS themselves slow?
// Those have opposite fixes — provider headroom versus prompt and model choice
// — and an operator who is sent the wrong way spends a week tuning prompts on a
// quota problem. So the verdict is pinned here, including against the exact
// 4096-second shape that prompted the tool.

import assert from "node:assert/strict";
import {
  WAITING_ABSOLUTE_FLOOR_MS,
  analyzeScriptRun,
  formatScriptRunReport,
  type ScriptRunRow,
} from "../lib/services/scriptRunDiagnosis";

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

const T0 = new Date("2026-08-24T03:00:00.000Z");

/** A stage exactly as costLedger writes it. */
function stage(name: string, wallMs: number, over: Record<string, unknown> = {}) {
  return {
    stage: name,
    models: ["groq/gpt-oss-120b"],
    roles: ["script_movement"],
    calls: 3,
    wallMs,
    retries: 0,
    fallbacks: 0,
    failures: 0,
    ...over,
  };
}

function row(over: Partial<ScriptRunRow> & { stages?: unknown[]; totals?: unknown }): ScriptRunRow {
  const { stages, totals, ...rest } = over;
  return {
    id: "log-1",
    status: "failed",
    error: null,
    input: { episodeId: "ep-1" },
    output: stages ? { llmCost: { stages, ...(totals ? { totals } : {}) } } : {},
    createdAt: T0,
    updatedAt: new Date(T0.getTime() + 1000),
    ...rest,
  };
}

function main() {
  console.log("\nScript-run diagnosis — waiting vs calling\n");

  console.log("  -- the run that prompted the tool --");

  // 4096s wall, of which only ten minutes was spent inside provider calls.
  const slow = row({
    updatedAt: new Date(T0.getTime() + 4_096_000),
    stages: [stage("script_movement", 500_000), stage("self_verify", 100_000)],
    totals: { calls: 6, wallMs: 600_000, retries: 9, fallbacks: 4, failures: 5 },
    error:
      "[JobBudget] generate:script for episode ep-1 exceeded its 1500s wall-clock budget\n" +
      "WHERE THE TIME WENT (most recent chain, in order):\n" +
      "  - groq/gpt-oss-120b [profile_primary] failed (rate_limited): HTTP 429 token_quota_exceeded",
  });

  check("the waiting is computed, not guessed", () => {
    const a = analyzeScriptRun(slow);
    assert.equal(a.jobMs, 4_096_000, "the job's own wall time");
    assert.equal(a.llmMs, 600_000, "time inside provider calls, summed from the stages");
    assert.equal(a.waitMs, 3_496_000, "everything else was a hold or a backoff");
    assert.equal(a.waitPercent, 85);
  });

  check("a run that spent its life waiting is called a QUOTA problem", () => {
    const a = analyzeScriptRun(slow);
    assert.equal(a.verdict, "mostly_waiting");
    const report = formatScriptRunReport(a, slow.createdAt).join("\n");
    assert.match(report, /MOSTLY WAITING/);
    assert.match(report, /QUOTA problem/, "the right fix must be named");
    assert.match(report, /Prompt tuning will not help/, "and the wrong one ruled out");
  });

  check("wasted work is counted where an operator will see it", () => {
    const a = analyzeScriptRun(slow);
    assert.equal(a.retries, 9);
    assert.equal(a.fallbacks, 4);
    assert.equal(a.failures, 5);
    const report = formatScriptRunReport(a, slow.createdAt).join("\n");
    assert.match(report, /9 retry\(s\), 4 fallback\(s\), 5 failed call\(s\)/);
  });

  check("the routing chain's own history travels with the run", () => {
    const report = formatScriptRunReport(analyzeScriptRun(slow), slow.createdAt).join("\n");
    assert.match(report, /token_quota_exceeded/, "the provider's own words must survive");
    assert.match(report, /WHERE THE TIME WENT/);
  });

  check("the slowest stage ranks first, with its model", () => {
    const a = analyzeScriptRun(slow);
    assert.equal(a.stages[0].stage, "script_movement", "500s must outrank 100s");
    assert.equal(a.stages[0].sharePercent, 83);
    assert.deepEqual(a.stages[0].models, ["groq/gpt-oss-120b"]);
  });

  console.log("\n  -- the opposite case, which must NOT be blamed on quota --");

  check("a run that was genuinely computing is called a prompt/model problem", () => {
    const busy = row({
      status: "completed",
      updatedAt: new Date(T0.getTime() + 610_000),
      stages: [stage("script_movement", 600_000)],
    });
    const a = analyzeScriptRun(busy);
    assert.equal(a.verdict, "mostly_calling");
    const report = formatScriptRunReport(a, busy.createdAt).join("\n");
    assert.doesNotMatch(report, /MOSTLY WAITING/, "a busy run must never read as a quota problem");
    assert.match(report, /prompt size and model choice/);
  });

  check("a short idle run is not dressed up as a quota problem", () => {
    // 4s wall, 1s calling: 75% idle and completely uninteresting. Without the
    // absolute floor, every trivial run would shout about quota.
    const trivial = row({
      updatedAt: new Date(T0.getTime() + 4_000),
      stages: [stage("script_movement", 1_000)],
    });
    const a = analyzeScriptRun(trivial);
    assert.ok(a.waitPercent >= 50, "it IS mostly idle by share");
    assert.equal(a.verdict, "mostly_calling", "but far too small to be anyone's problem");
    assert.ok(a.waitMs < WAITING_ABSOLUTE_FLOOR_MS);
  });

  console.log("\n  -- what must never be concluded --");

  check("a row with no cost record yields NO verdict", () => {
    // A job that died before its first provider call has nothing to attribute.
    // "0s calling, 100% waiting" would be a confident lie.
    const empty = row({ error: "Episode has no topics linked." });
    const a = analyzeScriptRun(empty);
    assert.equal(a.verdict, "no_data");
    const report = formatScriptRunReport(a, empty.createdAt).join("\n");
    assert.match(report, /no per-call cost record/);
    assert.doesNotMatch(report, /MOSTLY/, "no verdict may be drawn from no data");
    assert.match(report, /no topics linked/, "but the real error must still be shown");
  });

  check("waiting can never be reported as negative", () => {
    // A cost record whose wallMs exceeds the row's own span (a late write, a
    // clock skew) must clamp rather than print a negative duration.
    const skewed = row({
      updatedAt: new Date(T0.getTime() + 10_000),
      stages: [stage("script_movement", 90_000)],
    });
    assert.equal(analyzeScriptRun(skewed).waitMs, 0);
  });

  check("a still-open run is timed to now and labelled unfinished", () => {
    const now = T0.getTime() + 120_000;
    const live = row({ status: "running", updatedAt: T0, stages: [stage("script_movement", 1_000)] });
    const a = analyzeScriptRun(live, now);
    assert.equal(a.stillOpen, true);
    assert.equal(a.jobMs, 120_000, "measured to now, not to a stale updatedAt");
    const report = formatScriptRunReport(a, live.createdAt).join("\n");
    assert.match(report, /still open — timed to now/, "an in-progress run is not a measurement");
  });

  check("malformed cost JSON degrades to no_data instead of throwing", () => {
    // JobLog.output is free-form JSON written across many releases. A reader
    // that throws on an old shape takes the whole diagnosis down with it.
    for (const output of [null, "nonsense", { llmCost: "nope" }, { llmCost: { stages: "no" } }]) {
      const a = analyzeScriptRun(row({ output }));
      assert.equal(a.verdict, "no_data", `output ${JSON.stringify(output)} must not throw`);
      assert.equal(a.llmMs, 0);
    }
  });

  check("a stage missing its numbers is counted as zero, not NaN", () => {
    const a = analyzeScriptRun(row({ stages: [{ stage: "script_movement" }] }));
    assert.equal(a.llmMs, 0);
    assert.equal(a.calls, 0);
    assert.ok(!Number.isNaN(a.waitPercent), "a missing field must never become NaN%");
  });

  check("totals are recovered from the stages when the totals block is absent", () => {
    const a = analyzeScriptRun(
      row({ stages: [stage("a", 10, { calls: 2, retries: 1 }), stage("b", 20, { calls: 3, retries: 4 })] })
    );
    assert.equal(a.calls, 5, "summed from stages when no totals block was written");
    assert.equal(a.retries, 5);
  });

  console.log(
    failed === 0 ? "\nAll script-run diagnosis checks passed.\n" : `\n${failed} check(s) FAILED.\n`
  );
  if (failed > 0) process.exit(1);
}

main();
