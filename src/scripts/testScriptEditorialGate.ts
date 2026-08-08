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

// Production now requires BOTH deterministic invariants and observed pipeline
// provenance before it will release a script. These are the "everything was
// measured and the creative path ran" extras a real generation supplies; a
// script that reaches the gate without them is unmeasured, and unmeasured is
// not the same as good.
const CLEAN_EXTRAS = {
  invariants: {
    findings: [],
    failedCriticalAxes: [],
    worstSeverity: "pass" as const,
    measurements: {
      lineCount: 100, coldOpenWords: 104, coldOpenLines: 5,
      strictAlternationRatio: 0.58, perSpeakerLines: { A: 54, B: 46 }, positionSwapCount: 0,
    },
  },
  provenance: { path: "outline_driven" as const, stages: [], judgeRan: true },
};

check("strong scores pass", () => {
  const result = evaluateScriptEditorialGate(
    report(),
    { NODE_ENV: "production", SCRIPT_EDITORIAL_GATE_MODE: "hold" },
    CLEAN_EXTRAS
  );
  assert(result.decision === "pass", `expected pass, got ${result.decision}: ${result.reasons.join(" | ")}`);
  assert(!result.downstreamBlocked, "passing work must not block");
});
check("an unmeasured script is held in production", () => {
  // No invariants, no provenance — the gate must refuse rather than assume.
  const result = evaluateScriptEditorialGate(report(), { NODE_ENV: "production", SCRIPT_EDITORIAL_GATE_MODE: "hold" });
  assert(result.decision === "hold", `expected hold, got ${result.decision}`);
});
check("a failed deterministic invariant holds regardless of judge score", () => {
  const result = evaluateScriptEditorialGate(
    report(),
    { NODE_ENV: "production", SCRIPT_EDITORIAL_GATE_MODE: "hold" },
    {
      ...CLEAN_EXTRAS,
      invariants: {
        ...CLEAN_EXTRAS.invariants,
        findings: [{ axis: "coldOpenQuality" as const, severity: "hold" as const, message: "Cold open is 223 spoken words." }],
        failedCriticalAxes: ["coldOpenQuality" as const],
        worstSeverity: "hold" as const,
      },
    }
  );
  assert(result.decision === "hold", `expected hold, got ${result.decision}`);
  assert(result.failedCriticalAxes.includes("coldOpenQuality"), "the failing axis must be named");
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
check("borderline score becomes review AND blocks automatic production", () => {
  // CONTRACT CHANGE. This previously asserted "review must not auto-block".
  // That was the defect: episode e7867729 scored ~66/100, earned `review`, and
  // `review` stopped nothing, so it became audio anyway. `review` now means a
  // human decides — only `pass` continues on its own.
  const result = evaluateScriptEditorialGate(
    report({ judge: judge({ overall: 72 }) }),
    { NODE_ENV: "production", SCRIPT_EDITORIAL_GATE_MODE: "hold" },
    CLEAN_EXTRAS
  );
  assert(result.decision === "review", `expected review, got ${result.decision}`);
  assert(result.downstreamBlocked, "review must block AUTOMATIC downstream production");
});
check("missing judge is a hold in production, not a note", () => {
  // CONTRACT CHANGE. A judge outage used to downgrade to `review`, and because
  // `review` blocked nothing, an outage silently disabled the whole gate.
  const result = evaluateScriptEditorialGate(
    report({ judge: null, judgeError: "provider unavailable" }),
    { NODE_ENV: "production", SCRIPT_EDITORIAL_GATE_MODE: "hold" },
    CLEAN_EXTRAS
  );
  assert(result.decision === "hold", `expected hold, got ${result.decision}`);
  assert(result.reasons.some((r) => r.includes("provider unavailable")), "missing judge error");
});
check("outside production a missing judge is still only review", () => {
  const result = evaluateScriptEditorialGate(
    report({ judge: null, judgeError: "provider unavailable" }),
    { NODE_ENV: "test", SCRIPT_EDITORIAL_GATE_MODE: "hold" },
    CLEAN_EXTRAS
  );
  assert(result.decision === "review", `expected review outside production, got ${result.decision}`);
});
check("a single-shot fallback is held even with strong scores", () => {
  const result = evaluateScriptEditorialGate(
    report(),
    { NODE_ENV: "production", SCRIPT_EDITORIAL_GATE_MODE: "hold" },
    { ...CLEAN_EXTRAS, provenance: { path: "single_shot_fallback", fallbackReason: "outline had 3 beats", stages: [], judgeRan: true } }
  );
  assert(result.decision === "hold", `expected hold, got ${result.decision}`);
  assert(result.failedCriticalAxes.includes("creativePipelinePath"), "fallback must be named");
});
check("observe records but does not stop", () => {
  const result = evaluateScriptEditorialGate(
    report({ judge: judge({ bothHostsSoundLikeOneModel: true }) }),
    { NODE_ENV: "production", SCRIPT_EDITORIAL_GATE_MODE: "observe" },
    CLEAN_EXTRAS
  );
  assert(result.decision === "hold" && !result.downstreamBlocked, "observe should not stop");
});
check("a persisted hold is NOT cleared by the old env override", () => {
  // CONTRACT CHANGE. SCRIPT_EDITORIAL_HOLD_OVERRIDE=true cleared every hold in
  // the process at once and left nothing auditable behind. A hold is now
  // cleared only by a recorded, attributable human release on the script.
  const content = { editorialGate: { decision: "hold" } };
  assert(editorialGateBlocksDownstream(content, {
    NODE_ENV: "production", SCRIPT_EDITORIAL_GATE_MODE: "hold",
  }), "hold should block");
  assert(editorialGateBlocksDownstream(content, {
    NODE_ENV: "production", SCRIPT_EDITORIAL_GATE_MODE: "hold",
    SCRIPT_EDITORIAL_HOLD_OVERRIDE: "true",
  }), "a process-wide env flag must no longer bypass a hold");
});
check("a recorded human release clears a hold", () => {
  const content = {
    editorialGate: { decision: "hold" },
    humanRelease: {
      approvedBy: "producer@example.com", approvedAt: "2026-08-02T00:00:00Z",
      approvedDecision: "hold", acknowledgedReasons: ["cold open out of band"],
    },
  };
  assert(!editorialGateBlocksDownstream(content, {
    NODE_ENV: "production", SCRIPT_EDITORIAL_GATE_MODE: "hold",
  }), "an attributable human release should unblock");
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
