import {
  CRITICAL_EDITORIAL_AXES,
  editorialGateBlocksDownstream,
  evaluateScriptEditorialGate,
} from "../lib/services/scriptEditorialGate";
import type { CombinedQualityReport, JudgeVerdict } from "../lib/services/scriptQualityJudge";

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}
function check(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed++;
    console.error(`  ✗ ${name}\n      ${(error as Error).message}`);
  }
}
function judge(overrides: Partial<JudgeVerdict> = {}): JudgeVerdict {
  const axes = Object.fromEntries(
    [
      "hostDistinctness", "characterConsistency", "conversationalCausality",
      "spokenNaturalness", "mechanicalAlternation", "repetition", "genericFiller",
      "evidenceGrounding", "argumentProgression", "emotionalProgression",
      "movementContinuity", "callbacks", "closingPayoff", "monologueRestraint",
      "sentenceOpeningVariety", "agreementPhraseVariety", "singleModelSmell",
    ].map((axis) => [axis, 8.5])
  ) as JudgeVerdict["axes"];
  return {
    axes, overall: 84, bothHostsSoundLikeOneModel: false,
    strengths: [], weaknesses: [], evidenceQuotes: [], ...overrides,
  };
}
function report(overrides: Partial<CombinedQualityReport> = {}): CombinedQualityReport {
  return {
    deterministic: {
      total: 82,
      axes: {
        repetition: { score: 22, max: 25, detail: "" },
        specificity: { score: 12, max: 15, detail: "" },
        personality: { score: 13, max: 15, detail: "" },
        flow: { score: 17, max: 20, detail: "" },
        arc: { score: 11, max: 15, detail: "" },
        delivery: { score: 7, max: 10, detail: "" },
      },
      conversation: {} as never,
      gate: { enforced: true, passed: true, failures: [], warnings: [] },
    },
    judge: judge(), excerpts: [], lineCount: 100, wordCount: 1600, ...overrides,
  };
}

console.log("\nScript editorial gate\n");

check("strong scores pass", () => {
  const result = evaluateScriptEditorialGate(report(), { NODE_ENV: "production", SCRIPT_EDITORIAL_GATE_MODE: "hold" });
  assert(result.decision === "pass", `expected pass, got ${result.decision}`);
  assert(!result.downstreamBlocked, "passing work must not block");
});
check("one-model smell is a hard hold", () => {
  const result = evaluateScriptEditorialGate(
    report({ judge: judge({ bothHostsSoundLikeOneModel: true }) }),
    { NODE_ENV: "production", SCRIPT_EDITORIAL_GATE_MODE: "hold" }
  );
  assert(result.decision === "hold" && result.downstreamBlocked, "one-model smell must block");
});
check("critical causality collapse is a hard hold", () => {
  const j = judge();
  j.axes.conversationalCausality = 3.5;
  const result = evaluateScriptEditorialGate(report({ judge: j }), {
    NODE_ENV: "production", SCRIPT_EDITORIAL_GATE_MODE: "hold",
  });
  assert(result.decision === "hold", `expected hold, got ${result.decision}`);
});
check("borderline score becomes review", () => {
  const result = evaluateScriptEditorialGate(report({ judge: judge({ overall: 72 }) }), {
    NODE_ENV: "production", SCRIPT_EDITORIAL_GATE_MODE: "hold",
  });
  assert(result.decision === "review" && !result.downstreamBlocked, "review must not auto-block");
});
check("missing judge is visible", () => {
  const result = evaluateScriptEditorialGate(
    report({ judge: null, judgeError: "provider unavailable" }),
    { NODE_ENV: "production", SCRIPT_EDITORIAL_GATE_MODE: "hold" }
  );
  assert(result.decision === "review", `expected review, got ${result.decision}`);
  assert(result.reasons.some((r) => r.includes("provider unavailable")), "missing judge error");
});
check("observe records but does not stop", () => {
  const result = evaluateScriptEditorialGate(
    report({ judge: judge({ bothHostsSoundLikeOneModel: true }) }),
    { NODE_ENV: "production", SCRIPT_EDITORIAL_GATE_MODE: "observe" }
  );
  assert(result.decision === "hold" && !result.downstreamBlocked, "observe should not stop");
});
check("persisted hold blocks unless overridden", () => {
  const content = { editorialGate: { decision: "hold" } };
  assert(editorialGateBlocksDownstream(content, {
    NODE_ENV: "production", SCRIPT_EDITORIAL_GATE_MODE: "hold",
  }), "hold should block");
  assert(!editorialGateBlocksDownstream(content, {
    NODE_ENV: "production", SCRIPT_EDITORIAL_GATE_MODE: "hold",
    SCRIPT_EDITORIAL_HOLD_OVERRIDE: "true",
  }), "explicit override should unblock");
});
check("critical registry covers retention dimensions", () => {
  for (const axis of ["hostDistinctness", "conversationalCausality", "spokenNaturalness",
    "argumentProgression", "emotionalProgression", "closingPayoff", "singleModelSmell"]) {
    assert(CRITICAL_EDITORIAL_AXES.includes(axis as never), `missing ${axis}`);
  }
});

if (failed) {
  console.error(`\n${failed} test(s) failed; ${passed} passed.`);
  process.exit(1);
}
console.log(`\nAll ${passed} editorial-gate tests passed.`);
