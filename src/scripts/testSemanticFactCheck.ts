// Semantic fact-check reviewer regression test. Run: npm run test:factcheck-semantic
//
// Locks in the two invariants that stop the semantic reviewer from failing valid
// scripts (the bug that blocked episode 593619a8 v3):
//   STEP 1 — only isFactualClaim:true lines can fail/need-review. Intros,
//            reactions, fragments, and interruptions are never fact-checked,
//            even when the LLM over-flags them.
//   STEP 2 — a verdict with no rationale is a parse error, never a failure.
//
// It drives processSemanticLineResults (the pure, provider-agnostic core) with a
// SIMULATED reviewer response, so it's deterministic and needs no LLM/DB.

import { processSemanticLineResults, reviewFactualLinesForRewrite } from "../lib/services/semanticReview";

let passed = 0;
let failed = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.error(`  ✗ ${name}\n      ${(err as Error).message}`);
  }
}
function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

// Fixture script: an intro, a reaction fragment, an interruption (all
// isFactualClaim:false), and ONE genuinely false factual claim.
const LINES = [
  { lineIndex: 0, speakerName: "Louie", text: "Welcome in — I'm Louie the Lip, that's Mickey.", isFactualClaim: false },
  { lineIndex: 1, speakerName: "Louie", text: "It's a good start!", isFactualClaim: false },
  { lineIndex: 2, speakerName: "Mickey", text: "[interrupting] So the man who said one game means nothin'—", isFactualClaim: false },
  { lineIndex: 3, speakerName: "Mickey", text: "Skubal threw a perfect game with 27 strikeouts last night.", isFactualClaim: true }, // false claim
];
const factualByIndex = new Map<number, boolean>(LINES.map((l) => [l.lineIndex, l.isFactualClaim]));
const originalFlatLines = LINES.map((l) => ({ lineIndex: l.lineIndex, speakerName: l.speakerName, text: l.text }));
const allowedSourceRefs = new Set<string>(["newsItem:rss:skubal-6-innings", "research:research-6"]);
const VALID_EVIDENCE_TYPES = ["game", "newsItem", "injury", "oddsSnapshot", "teamStat", "playerStat", "research"];

/** Run the reviewer core against the fixture with the given simulated verdicts. */
function run(rawLineResults: any[]) {
  return processSemanticLineResults({ rawLineResults, factualByIndex, allowedSourceRefs, originalFlatLines, validEvidenceTypes: VALID_EVIDENCE_TYPES });
}

function main() {
  console.log("Semantic reviewer line processing:");

  check("flags ONLY the false factual claim; skips intro, reaction, interruption", () => {
    // The LLM over-flags EVERY line as unsupported (the failure mode), all with
    // rationales — so only STEP 1 scoping decides the outcome.
    const raw = LINES.map((l) => ({
      lineIndex: l.lineIndex,
      speakerName: l.speakerName,
      claimText: l.text,
      status: "unsupported",
      reason: "model flagged this line",
      evidenceRefs: [],
    }));
    const out = run(raw);
    assert(out.counts.unsupported === 1, `expected 1 unsupported, got ${out.counts.unsupported}`);
    assert(out.counts.skippedNonFactual === 3, `expected 3 skipped non-factual, got ${out.counts.skippedNonFactual}`);
    assert(out.status === "failed", `expected failed (one real claim), got ${out.status}`);
    assert(out.errors.length === 1 && out.errors[0].lineIndex === 3, "the only error must be the false factual claim (line #3)");
    assert(!out.errors.some((e) => [0, 1, 2].includes(e.lineIndex)), "intro/reaction/interruption must not produce errors");
  });

  check("v3 shape: banter flagged with UNDEFINED rationale never fails the script", () => {
    // Exactly the v3 failure: non-factual lines flagged with no reason.
    const raw = [
      { lineIndex: 0, status: "unsupported", reason: undefined, evidenceRefs: [] },
      { lineIndex: 1, status: "unsupported", reason: undefined, evidenceRefs: [] },
      { lineIndex: 2, status: "unsupported", reason: undefined, evidenceRefs: [] },
    ];
    const out = run(raw);
    assert(out.counts.unsupported === 0, "no factual failures");
    assert(out.counts.skippedNonFactual === 3, `expected 3 skipped, got ${out.counts.skippedNonFactual}`);
    assert(out.status === "passed", `expected passed, got ${out.status}`);
  });

  check("STEP 2: a FACTUAL claim flagged with no rationale is a parse error, not a failure", () => {
    const raw = [{ lineIndex: 3, status: "unsupported", reason: "   ", evidenceRefs: [] }];
    const out = run(raw);
    assert(out.counts.parseError === 1, `expected 1 parse error, got ${out.counts.parseError}`);
    assert(out.counts.unsupported === 0, "a rationale-less flag must not count as unsupported");
    assert(out.status === "passed", `parse-error-only must not fail, got ${out.status}`);
    assert(out.warnings.some((w) => w.type === "semantic_parse_error"), "must surface the parse error as a warning");
  });

  check("a FACTUAL claim flagged unsupported WITH a rationale still fails (reviewer working)", () => {
    const raw = [{ lineIndex: 3, status: "unsupported", reason: "Evidence shows 6 innings, not a perfect game; no 27-K record exists in the packet.", evidenceRefs: [] }];
    const out = run(raw);
    assert(out.status === "failed", "a real, rationale-backed unsupported factual claim must fail");
    assert(out.errors[0].reason.includes("perfect game"), "the rationale must be surfaced, never 'undefined'");
    assert(!out.errors[0].reason.includes("undefined"), "no 'undefined' rationale");
  });

  check("supported factual line produces no flag", () => {
    const raw = [{ lineIndex: 3, status: "supported", reason: "", evidenceRefs: [{ type: "research", id: "research-6" }] }];
    const out = run(raw);
    assert(out.status === "passed", "supported line must pass");
    assert(out.counts.unsupported === 0 && out.counts.parseError === 0, "no flags for a supported line");
  });

  check("invalid evidence ref on a factual line is still caught (deterministic guard intact)", () => {
    const raw = [{ lineIndex: 3, status: "supported", reason: "", evidenceRefs: [{ type: "research", id: "does-not-exist" }] }];
    const out = run(raw);
    assert(out.counts.invalidEvidenceRef === 1, "hallucinated evidence ref must be flagged");
  });

  console.log("\nReviewer reuse (reviewFactualLinesForRewrite):");

  // A stub LLM provider that returns a fixed structured review — proves the
  // shared reviewer is invoked and its output scoped to factual + rationale'd.
  const stubProvider: any = {
    name: "stub",
    async generateStructuredOutput() {
      return {
        status: "needs_review",
        summary: "x",
        lineResults: [
          { lineIndex: 0, status: "needs_review", reason: "39-48 is the Orioles' record, not the Yankees'", evidenceRefs: [] }, // factual -> kept
          { lineIndex: 1, status: "unsupported", reason: "", evidenceRefs: [] }, // no rationale -> dropped
          { lineIndex: 2, status: "unsupported", reason: "banter", evidenceRefs: [] }, // non-factual -> dropped
          { lineIndex: 3, status: "supported", reason: "", evidenceRefs: [] }, // supported -> ignored
        ],
        unsupportedClaims: [], misleadingClaims: [], unsafeClaimsUsed: [], missingEvidence: [], confidence: 1,
      };
    },
  };

  (async () => {
    const flagged = await reviewFactualLinesForRewrite(stubProvider, {
      reviewLines: [
        { lineIndex: 0, speakerName: "Louie", text: "Yankees are 39-48.", isFactualClaim: true },
        { lineIndex: 1, speakerName: "Mickey", text: "Five homers.", isFactualClaim: true },
        { lineIndex: 2, speakerName: "Louie", text: "Oh, come on.", isFactualClaim: false },
        { lineIndex: 3, speakerName: "Mickey", text: "They're 48-38.", isFactualClaim: true },
      ],
      evidencePanelItems: [{ detailText: "Orioles are 39-48. Yankees are 48-38." }],
      unsafeClaims: [],
      rumorKeywords: [],
    });
    check("reviewer reuse: keeps only factual + rationale'd flags (subject-mismatch)", () => {
      assert(flagged.length === 1, `expected 1 flagged, got ${flagged.length}: ${JSON.stringify(flagged)}`);
      assert(flagged[0].lineIndex === 0 && /orioles/i.test(flagged[0].reason), "the subject-mismatch line survives with its rationale");
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
  })();
}

main();
