// Scoring-contract test for the verification experiment.
// Run: npm run test:verification-scoring
//
// Makes no API call. This protects the fix for a scoring bug that mis-graded
// the production semantic reviewer:
//
//   1. The reviewer under test is the semantic FACT-CHECK reviewer. Its prompt
//      forbids it from flagging non-factual lines and tells it to omit
//      supported ones. Scoring it on defects owned by the repetition checker or
//      by character/continuity validation measured obedience and reported it as
//      failure.
//   2. Out-of-scope defects stay VISIBLE in the read-out, as not_applicable —
//      deleting them would hide real defects nobody is checking for.
//   3. The old "schema" column measured what fraction of ALL seeded lines came
//      back. Under a prompt that says "return flagged lines only", a perfect
//      reviewer scores well under 100% on that metric, so it could never mean
//      what its name implied.

import {
  FACT_CHECK_SCOPE_LINES,
  OUT_OF_SCOPE_DEFECTS,
  SCOPE_BY_CATEGORY,
  SEEDED_LINES,
  scopeOf,
} from "./roleExperimentFixtures";
import { buildSemanticReviewPrompt } from "../lib/services/semanticReview";

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string) {
  if (!c) throw new Error(m);
}
function check(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.error(`  ✗ ${name}\n      ${(e as Error)?.message || e}`);
  }
}

console.log("Verification scoring contract\n");

check("every seeded category is assigned to exactly one pipeline stage", () => {
  for (const line of SEEDED_LINES) {
    const scope = SCOPE_BY_CATEGORY[line.category];
    assert(
      scope === "fact_check" || scope === "repetition" || scope === "character_continuity",
      `line ${line.lineIndex} category ${line.category} has no valid scope`
    );
  }
});

check("the two out-of-scope defects are duplicate_argument and character_violation", () => {
  const categories = OUT_OF_SCOPE_DEFECTS.map((l) => l.category).sort();
  assert(
    JSON.stringify(categories) === JSON.stringify(["character_violation", "duplicate_argument"]),
    `expected exactly [character_violation, duplicate_argument], got ${JSON.stringify(categories)}`
  );
  assert(scopeOf(OUT_OF_SCOPE_DEFECTS.find((l) => l.category === "duplicate_argument")!) === "repetition", "");
  assert(
    scopeOf(OUT_OF_SCOPE_DEFECTS.find((l) => l.category === "character_violation")!) === "character_continuity",
    ""
  );
});

check("character_violation is out of scope because the prompt forbids flagging non-factual lines", () => {
  const line = SEEDED_LINES.find((l) => l.category === "character_violation")!;
  assert(line.isFactualClaim === false, "character_violation line must be non-factual for this argument to hold");
  const { systemPrompt } = buildSemanticReviewPrompt({
    reviewLines: [],
    evidencePanelItems: [],
    unsafeClaims: [],
    rumorKeywords: [],
  });
  assert(/never flag them/i.test(systemPrompt), "prompt no longer forbids flagging non-factual lines");
});

check("duplicate_argument is out of scope because the repeated claim is itself evidence-supported", () => {
  const dup = SEEDED_LINES.find((l) => l.category === "duplicate_argument")!;
  const original = SEEDED_LINES.find((l) => l.lineIndex !== dup.lineIndex && l.text === dup.text);
  assert(original != null, "duplicate_argument line must duplicate another line verbatim");
  assert(original!.shouldFlag === false, "the original of the duplicate is a supported claim");
});

check("the fact-check scope carries 5 must-flag and 7 must-not-flag lines", () => {
  const mustFlag = FACT_CHECK_SCOPE_LINES.filter((l) => l.shouldFlag);
  const mustNotFlag = FACT_CHECK_SCOPE_LINES.filter((l) => !l.shouldFlag);
  assert(mustFlag.length === 5, `expected 5 in-scope defects, got ${mustFlag.length}`);
  assert(mustNotFlag.length === 7, `expected 7 in-scope legitimate lines, got ${mustNotFlag.length}`);
});

check("no seeded line is dropped by the scope split", () => {
  assert(
    FACT_CHECK_SCOPE_LINES.length + SEEDED_LINES.filter((l) => scopeOf(l) !== "fact_check").length ===
      SEEDED_LINES.length,
    "scope partition loses lines"
  );
});

check("out-of-scope defects remain visible rather than deleted from ground truth", () => {
  for (const l of OUT_OF_SCOPE_DEFECTS) {
    assert(
      SEEDED_LINES.some((s) => s.lineIndex === l.lineIndex),
      `line ${l.lineIndex} was removed from the seeded set instead of marked not_applicable`
    );
  }
});

check("the production prompt still tells the reviewer to omit supported lines", () => {
  // This is what invalidated the old "schema" column: an omitted line is
  // compliance, not a schema defect. If this ever changes, the replacement
  // metrics need revisiting too.
  const { systemPrompt, prompt } = buildSemanticReviewPrompt({
    reviewLines: [],
    evidencePanelItems: [],
    unsafeClaims: [],
    rumorKeywords: [],
  });
  assert(/OUTPUT ONLY PROBLEMS/.test(systemPrompt), "prompt no longer restricts output to flagged lines");
  assert(/omit every supported line/i.test(prompt), "user prompt no longer instructs omission of supported lines");
});

check("required top-level fields are read off the production schema, not hand-copied", () => {
  const { jsonSchema } = buildSemanticReviewPrompt({
    reviewLines: [],
    evidencePanelItems: [],
    unsafeClaims: [],
    rumorKeywords: [],
  });
  assert(Array.isArray(jsonSchema.required) && jsonSchema.required.length > 0, "schema declares no required fields");
  for (const f of ["status", "summary", "lineResults"]) {
    assert(jsonSchema.required.includes(f), `production schema no longer requires ${f}`);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
