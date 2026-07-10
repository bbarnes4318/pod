// Reviewer-evidence plumbing test. Run: npm run test:evidence-context
//
// Guards the fix for the gate-vs-self-verify disagreement: both semantic passes
// must build the reviewer evidence from collectReviewerEvidence, so they receive
// byte-identical corpora. The OLD gate path kept only ONE fact per ref (dropping
// unmatched facts + keyFactsContext); this proves the shared builder keeps them
// all and is deterministic.

import { collectReviewerEvidence, toEvidencePanel, evidenceFingerprint } from "../lib/services/evidenceContext";

let passed = 0;
let failed = 0;
function check(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.error(`  ✗ ${name}\n      ${(err as Error).message}`); }
}
function assert(cond: boolean, msg: string) { if (!cond) throw new Error(msg); }

// Two facts cite the SAME ref id, plus a keyFactsContext entry — exactly the
// shape the old gate builder collapsed to a single item.
const topics = [
  {
    researchBrief: {
      facts: [
        { text: "Detroit hit three first-inning homers (Carpenter, Greene, Torkelson).", evidenceRefs: [{ type: "game", id: "g1" }] },
        { text: "Detroit hit five total homers, its first five-homer game since 2018.", evidenceRefs: [{ type: "game", id: "g1" }] },
      ],
      stats: [{ text: "Skubal struck out nine, walked none.", evidenceRefs: [{ type: "playerStat", id: "s1" }] }],
      keyFactsContext: ["Schlittler allowed a career-high six runs."],
      injuryContext: "No injuries reported.",
      oddsContext: null,
    },
  },
];

function main() {
  console.log("Reviewer evidence (shared builder):");

  check("keeps ALL facts (both facts on ref g1, the stat, the keyFact, the injury)", () => {
    const { evidenceTexts } = collectReviewerEvidence(topics);
    assert(evidenceTexts.length === 5, `expected 5 texts, got ${evidenceTexts.length}: ${JSON.stringify(evidenceTexts)}`);
    assert(evidenceTexts.some((t) => /five total homers/.test(t)), "the second g1 fact (five homers) must be present");
    assert(evidenceTexts.some((t) => /career-high six runs/.test(t)), "the keyFactsContext entry must be present");
    assert(evidenceTexts.some((t) => /No injuries/.test(t)), "the injury context must be present");
  });

  check("indexes ref -> both facts that cite it", () => {
    const { evidenceByRefId } = collectReviewerEvidence(topics);
    const g1 = evidenceByRefId.get("g1") || "";
    assert(/three first-inning/.test(g1) && /five total homers/.test(g1), `g1 must include BOTH facts: ${g1}`);
  });

  check("is deterministic (same briefs => byte-identical corpus)", () => {
    const a = collectReviewerEvidence(topics);
    const b = collectReviewerEvidence(topics);
    assert(JSON.stringify(a.evidenceTexts) === JSON.stringify(b.evidenceTexts), "evidenceTexts must be identical across calls");
    const fa = evidenceFingerprint(a.evidenceTexts);
    const fb = evidenceFingerprint(b.evidenceTexts);
    assert(fa.count === fb.count && fa.chars === fb.chars, "fingerprints must match");
  });

  check("panel shape is {detailText} per text", () => {
    const { evidenceTexts } = collectReviewerEvidence(topics);
    const panel = toEvidencePanel(evidenceTexts);
    assert(panel.length === evidenceTexts.length && typeof panel[0].detailText === "string", "panel maps 1:1 to detailText items");
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
