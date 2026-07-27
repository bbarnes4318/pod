// Re-score an EXISTING verification artifact against the corrected, scoped
// ground truth. Run: npm run rescore:verification
//
//   npm run rescore:verification
//   npm run rescore:verification -- --file artifacts/role-experiment-verification.json
//
// MAKES NO API CALL. It reads the raw response each candidate already returned
// (stored as `raw` in the artifact) and recomputes the metrics under the fix in
// roleExperimentFixtures.ts: the semantic reviewer is scored only on defects
// inside its production contract, and the two defects owned by other pipeline
// stages are reported not_applicable rather than counted as misses.
//
// This exists so a corrected number is DERIVED from the run that happened,
// never estimated. A raw "4/7" cannot be converted to an in-scope score by
// arithmetic — it depends on WHICH lines that candidate missed, and only the
// stored response knows that.

import fs from "fs";
import path from "path";

import {
  FACT_CHECK_SCOPE_LINES,
  OUT_OF_SCOPE_DEFECTS,
  SEEDED_LINES,
  scopeOf,
} from "./roleExperimentFixtures";
import { buildSemanticReviewPrompt } from "../lib/services/semanticReview";

const argv = process.argv.slice(2);
const fileFlag = argv.indexOf("--file");
const ARTIFACT =
  fileFlag >= 0 && argv[fileFlag + 1]
    ? path.resolve(argv[fileFlag + 1])
    : path.join(process.cwd(), "artifacts", "role-experiment-verification.json");

if (!fs.existsSync(ARTIFACT)) {
  console.error(`No artifact at ${ARTIFACT}`);
  console.error("Run `npm run test:role-experiments -- --experiment verification` first, or pass --file <path>.");
  process.exit(1);
}

const artifact = JSON.parse(fs.readFileSync(ARTIFACT, "utf8"));
const entries: any[] = Array.isArray(artifact?.artifacts) ? artifact.artifacts : [];

const mustFlag = FACT_CHECK_SCOPE_LINES.filter((l) => l.shouldFlag);
const mustNotFlag = FACT_CHECK_SCOPE_LINES.filter((l) => !l.shouldFlag);
const { jsonSchema } = buildSemanticReviewPrompt({
  reviewLines: [],
  evidencePanelItems: [],
  unsafeClaims: [],
  rumorKeywords: [],
});
const requiredFields: string[] = Array.isArray(jsonSchema?.required) ? jsonSchema.required : [];

console.log(`Re-scoring ${ARTIFACT}`);
console.log(
  `\nScored scope: fact_check — ${mustFlag.length} defective lines (${mustFlag
    .map((l) => l.lineIndex)
    .join(", ")}), ${mustNotFlag.length} legitimate lines.`
);
console.log(
  `Not applicable: ${OUT_OF_SCOPE_DEFECTS.map((l) => `line ${l.lineIndex} [${l.category}] → ${scopeOf(l)}`).join(", ")}\n`
);

const results: any[] = [];

for (const entry of entries) {
  const label = entry?.candidate ?? "(unlabelled)";

  if (entry?.error) {
    console.log(`${label}\n  FAILED — ${String(entry.error).slice(0, 160)}\n`);
    results.push({ candidate: label, status: "failed", error: entry.error });
    continue;
  }

  const raw = entry?.raw;
  if (raw == null) {
    // Nothing to re-derive from. Say so instead of guessing from the old counts.
    console.log(
      `${label}\n  NO RAW RESPONSE STORED — cannot re-score this candidate. ` +
        `Its old numbers were computed against the unscoped ground truth and must not be reused.\n`
    );
    results.push({ candidate: label, status: "unscoreable_no_raw" });
    continue;
  }

  const findings = Array.isArray(raw?.lineResults) ? raw.lineResults : [];
  const flagged = new Set<number>();
  for (const lr of findings) {
    if (lr?.status === "unsupported" || lr?.status === "needs_review") flagged.add(Number(lr?.lineIndex));
  }

  const truePos = mustFlag.filter((l) => flagged.has(l.lineIndex));
  const falseNeg = mustFlag.filter((l) => !flagged.has(l.lineIndex));
  const falsePos = mustNotFlag.filter((l) => flagged.has(l.lineIndex));
  const precision = truePos.length + falsePos.length > 0 ? truePos.length / (truePos.length + falsePos.length) : 0;
  const recall = mustFlag.length > 0 ? truePos.length / mustFlag.length : 0;

  const rawMustFlag = SEEDED_LINES.filter((l) => l.shouldFlag);
  const rawCaught = rawMustFlag.filter((l) => flagged.has(l.lineIndex)).length;

  const validResponseSchema = raw != null && typeof raw === "object" && Array.isArray(raw.lineResults);
  const missingFields = requiredFields.filter((f) => !(raw != null && typeof raw === "object" && f in raw));

  console.log(label);
  console.log(`  validResponseSchema           ${validResponseSchema ? "yes" : "no"}`);
  console.log(
    `  requiredTopLevelFieldsPresent ${requiredFields.length - missingFields.length}/${requiredFields.length}` +
      (missingFields.length ? `  (missing: ${missingFields.join(", ")})` : "")
  );
  console.log(`  returnedFindings              ${findings.length}`);
  console.log(`  raw (old, unscoped)           ${rawCaught}/${rawMustFlag.length} caught`);
  console.log(`  IN-SCOPE caught               ${truePos.length}/${mustFlag.length}`);
  console.log(`  IN-SCOPE missed               ${falseNeg.length}${falseNeg.length ? ` (lines ${falseNeg.map((l) => l.lineIndex).join(", ")})` : ""}`);
  console.log(`  false positives               ${falsePos.length}`);
  console.log(`  precision                     ${(precision * 100).toFixed(0)}%`);
  console.log(`  recall                        ${(recall * 100).toFixed(0)}%`);
  console.log(`  falsePositiveRate             ${((mustNotFlag.length ? falsePos.length / mustNotFlag.length : 0) * 100).toFixed(0)}%`);
  console.log(`  falseNegativeRate             ${((mustFlag.length ? falseNeg.length / mustFlag.length : 0) * 100).toFixed(0)}%`);
  console.log("  not applicable:");
  for (const l of OUT_OF_SCOPE_DEFECTS) {
    console.log(
      `    line ${l.lineIndex} [${l.category}] owned by ${scopeOf(l)} — ` +
        `${flagged.has(l.lineIndex) ? "was flagged anyway (informational)" : "not flagged, as its contract requires"}`
    );
  }
  console.log("");

  results.push({
    candidate: label,
    status: "ok",
    validResponseSchema,
    requiredTopLevelFieldsPresent: `${requiredFields.length - missingFields.length}/${requiredFields.length}`,
    missingTopLevelFields: missingFields,
    returnedFindings: findings.length,
    rawCaught: `${rawCaught}/${rawMustFlag.length}`,
    inScopeCaught: `${truePos.length}/${mustFlag.length}`,
    inScopeMissed: falseNeg.map((l) => ({ line: l.lineIndex, category: l.category })),
    falsePositives: falsePos.map((l) => ({ line: l.lineIndex, category: l.category })),
    precision: `${(precision * 100).toFixed(0)}%`,
    recall: `${(recall * 100).toFixed(0)}%`,
    notApplicable: OUT_OF_SCOPE_DEFECTS.map((l) => ({
      line: l.lineIndex,
      category: l.category,
      ownedBy: scopeOf(l),
      result: "not_applicable",
      incidentallyFlagged: flagged.has(l.lineIndex),
    })),
  });
}

const out = path.join(path.dirname(ARTIFACT), "role-experiment-verification-rescored.json");
fs.writeFileSync(out, JSON.stringify({ source: ARTIFACT, scoredScope: "fact_check", results }, null, 2));
console.log(`Wrote ${out}`);
console.log(
  "\nThese numbers replace the old table's. Record the IN-SCOPE figures in profiles.ts;\n" +
    "the raw column is kept only so the two can be compared."
);
