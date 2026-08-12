// The render verifier, verified.
//
//   npm run test:llm-cost-render-parser
//
// NETWORK-FREE. Drives verifyLlmCostRender's parser and evaluator over synthetic
// logs whose answers are known.
//
// WHY IT EXISTS. verify:llm-cost-render is the thing that decides whether the
// prompt-caching and cost-telemetry work actually landed. A checker that returns
// "pass" because it parsed nothing, or because it silently skipped the condition
// it could not evaluate, is worse than no checker: it converts "unproven" into
// "verified" and nobody looks again. So the cases below deliberately include the
// ways this could report a false green.

import assert from "node:assert/strict";
import { evaluateRender, parseCostLines } from "./verifyLlmCostRender";

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

/** Build a `[LLMCost]` line in the exact shape costLedger.ts emits. */
function costLine(o: {
  stage: string;
  role?: string;
  provider: string;
  model: string;
  tkIn?: number;
  tkOut?: number;
  cacheRead?: number;
  cacheWrite?: number;
  retries?: number;
  fallbacks?: number;
  failed?: string;
  cost?: number | null;
  prefix?: string;
}): string {
  const parts = [
    `[LLMCost] stage=${o.stage}`,
    o.role ? ` role=${o.role}` : "",
    ` provider=${o.provider} model=${o.model}`,
    ` in=${o.tkIn ?? 100} out=${o.tkOut ?? 50}`,
    ` cacheRead=${o.cacheRead ?? 0} cacheWrite=${o.cacheWrite ?? 0}`,
    ` reasoning=0 ms=1200`,
    o.retries ? ` retries=${o.retries}` : "",
    o.fallbacks ? ` fallbacks=${o.fallbacks}` : "",
    o.failed ? ` FAILED=${o.failed}` : "",
    o.cost === null || o.cost === undefined ? " cost=unpriced" : ` cost=$${o.cost.toFixed(4)}`,
  ];
  return (o.prefix ?? "") + parts.join("");
}

const status = (fs: ReturnType<typeof evaluateRender>, id: string) => fs.find((f) => f.id === id)!.status;

console.log("\nLLM cost render verifier\n");

// =============================================================================
console.log("  -- parsing --");

check("parses a well-formed line into every field", () => {
  const [l] = parseCostLines(
    costLine({ stage: "script:host-writer:Zabala", role: "script_host_a_writer", provider: "anthropic", model: "claude-opus-5", tkIn: 1200, tkOut: 800, cacheRead: 9000, cacheWrite: 120, cost: 0.0421 })
  );
  assert.equal(l.stage, "script:host-writer:Zabala");
  assert.equal(l.role, "script_host_a_writer");
  assert.equal(l.provider, "anthropic");
  assert.equal(l.model, "claude-opus-5");
  assert.equal(l.tkIn, 1200);
  assert.equal(l.cacheRead, 9000);
  assert.equal(l.costUsd, 0.0421);
});

check("survives real log furniture around the marker", () => {
  // Captured logs carry container ids and timestamps; the marker is not at the
  // start of the line and a parser anchored to ^ would find nothing at all.
  const lines = parseCostLines(
    costLine({ stage: "s", provider: "zai", model: "glm-4.7-flash", prefix: "2026-08-11T19:04:02.113Z worker-1 | " })
  );
  assert.equal(lines.length, 1);
  assert.equal(lines[0].provider, "zai");
});

check("ignores unrelated log lines", () => {
  assert.equal(parseCostLines("just some log\n[LLMRouting] role=x advancing\nanother line").length, 0);
});

check("reads cost=unpriced as null, not as zero", () => {
  // The distinction the whole telemetry change rests on: "we did not price this"
  // is not "this was free".
  const [l] = parseCostLines(costLine({ stage: "s", provider: "anthropic", model: "claude-opus-5", cost: null }));
  assert.equal(l.costUsd, null);
  const [z] = parseCostLines(costLine({ stage: "s", provider: "nvidia", model: "m", cost: 0 }));
  assert.equal(z.costUsd, 0, "an explicit $0.0000 is a measurement and must not be read as unpriced");
});

// =============================================================================
console.log("\n  -- condition 1: cache reads --");

const anthropicRun = (reads: number[]) =>
  reads
    .map((cacheRead, i) =>
      costLine({ stage: "script:host-writer:Zabala", role: "script_host_a_writer", provider: "anthropic", model: "claude-opus-5", cacheRead, cacheWrite: i === 0 ? 8000 : 0, cost: 0.02 })
    )
    .join("\n");

check("passes when every call after the first reads cache", () => {
  assert.equal(status(evaluateRender(parseCostLines(anthropicRun([0, 8000, 8000, 8000]))), "cache-read"), "pass");
});

check("FAILS when a later call reads nothing", () => {
  // The regression this exists to catch: a per-call value leaking into the
  // static block, so the prefix changes and nothing ever hits.
  assert.equal(status(evaluateRender(parseCostLines(anthropicRun([0, 0, 0, 0]))), "cache-read"), "fail");
});

check("a single Anthropic call is INCONCLUSIVE, not pass", () => {
  // One call can only write the cache. Reporting green here would claim proof
  // from a run that could not have produced any.
  assert.equal(status(evaluateRender(parseCostLines(anthropicRun([0]))), "cache-read"), "inconclusive");
});

check("no Anthropic calls at all is INCONCLUSIVE, not pass", () => {
  // The most likely real outcome: under verified_development the free chain
  // serves everything and the paid rung never fires. A healthy episode proves
  // nothing about caching, and must not be reported as if it did.
  const log = [
    costLine({ stage: "script:host-writer:Zabala", role: "script_host_a_writer", provider: "zai", model: "glm-4.7-flash", cost: 0 }),
    costLine({ stage: "script:host-writer:Mercer", role: "script_host_b_writer", provider: "nvidia", model: "mistralai/mistral-medium-3.5-128b", cost: 0 }),
  ].join("\n");
  assert.equal(status(evaluateRender(parseCostLines(log)), "cache-read"), "inconclusive");
});

// =============================================================================
console.log("\n  -- condition 2: the broken model --");

check("passes when deepseek-v4-pro never appears", () => {
  const log = costLine({ stage: "s", role: "continuity_report", provider: "zai", model: "glm-4.7-flash", cost: 0 });
  assert.equal(status(evaluateRender(parseCostLines(log)), "no-deepseek-pro"), "pass");
});

check("FAILS on even one attempt, including a failed one", () => {
  // A failed attempt is exactly the case: it costs a hop and returns nothing.
  const log = [
    costLine({ stage: "s", role: "continuity_report", provider: "nvidia", model: "deepseek-ai/deepseek-v4-pro", failed: "endpoint_rejected_fast", cost: null }),
    costLine({ stage: "s", role: "continuity_report", provider: "zai", model: "glm-4.7-flash", fallbacks: 1, cost: 0 }),
  ].join("\n");
  assert.equal(status(evaluateRender(parseCostLines(log)), "no-deepseek-pro"), "fail");
});

// =============================================================================
console.log("\n  -- condition 3: continuity roles first-try --");

check("passes when the role is served first-try with no fallback", () => {
  const log = ["continuity_report", "script_continuity_editor"]
    .map((role) => costLine({ stage: `script:${role}`, role, provider: "zai", model: "glm-4.7-flash", cost: 0 }))
    .join("\n");
  const f = evaluateRender(parseCostLines(log));
  assert.equal(status(f, "first-attempt-continuity_report"), "pass");
  assert.equal(status(f, "first-attempt-script_continuity_editor"), "pass");
});

check("FAILS when the role needed a fallback", () => {
  const log = costLine({ stage: "s", role: "continuity_report", provider: "nvidia", model: "nvidia/nemotron-3-ultra-550b-a55b", fallbacks: 1, cost: 0 });
  assert.equal(status(evaluateRender(parseCostLines(log)), "first-attempt-continuity_report"), "fail");
});

check("FAILS when the first attempt errored", () => {
  const log = costLine({ stage: "s", role: "script_continuity_editor", provider: "zai", model: "glm-4.7-flash", failed: "rate_limited", cost: null });
  assert.equal(status(evaluateRender(parseCostLines(log)), "first-attempt-script_continuity_editor"), "fail");
});

check("an absent continuity role is INCONCLUSIVE — continuity is optional", () => {
  // Continuity in this show is topic-gated and nothing is required per episode,
  // so "no line" is a normal render, not a pass and not a failure.
  const log = costLine({ stage: "s", role: "script_movement", provider: "zai", model: "glm-4.7-flash", cost: 0 });
  const f = evaluateRender(parseCostLines(log));
  assert.equal(status(f, "first-attempt-continuity_report"), "inconclusive");
});

// =============================================================================
console.log("\n  -- condition 4: the paid rung is priced --");

check("passes when every Anthropic call carries dollars", () => {
  assert.equal(status(evaluateRender(parseCostLines(anthropicRun([0, 8000]))), "priced"), "pass");
});

check("FAILS when an Anthropic call says unpriced", () => {
  const log = [
    costLine({ stage: "s", provider: "anthropic", model: "claude-opus-5", cost: 0.01 }),
    costLine({ stage: "s", provider: "anthropic", model: "claude-opus-5", cacheRead: 900, cost: null }),
  ].join("\n");
  assert.equal(status(evaluateRender(parseCostLines(log)), "priced"), "fail");
});

check("free rungs reporting $0.0000 do not affect the Anthropic condition", () => {
  const log = [
    costLine({ stage: "s", provider: "nvidia", model: "m", cost: 0 }),
    ...[0, 8000].map((cacheRead) => costLine({ stage: "s", provider: "anthropic", model: "claude-opus-5", cacheRead, cost: 0.03 })),
  ].join("\n");
  assert.equal(status(evaluateRender(parseCostLines(log)), "priced"), "pass");
});

console.log(
  failed === 0 ? "\nAll render-verifier checks passed.\n" : `\n${failed} check(s) FAILED.\n`
);
process.exit(failed === 0 ? 0 : 1);
