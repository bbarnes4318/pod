// Self-verify loop test. Run: npm run test:self-verify
//
// Proves FIX 1: after generation, each isFactualClaim:true line is checked with
// the SAME verifier the gate uses, and violations are sent back to a rewriter
// until grounded (or given up after N). Uses a STUB rewriter — no LLM/DB.

import { selfVerifyAndCorrect, LineRewriter } from "../lib/services/scriptSelfVerify";

let passed = 0;
let failed = 0;
function check(name: string, fn: () => Promise<void> | void) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log(`  ✓ ${name}`); })
    .catch((err) => { failed++; console.error(`  ✗ ${name}\n      ${(err as Error).message}`); });
}
function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

const evidenceByRefId = new Map<string, string>([["f1", "Detroit hit three home runs in the win. The team is 48-38."]]);
const fullEvidenceText = "Detroit hit three home runs in the win. The team is 48-38, second in the East.";
const hostNames = ["Louie", "Mickey"];

function freshSegments() {
  return [
    {
      lines: [
        { lineIndex: 0, speakerName: "Louie", isFactualClaim: true, text: "Five homers tonight — five!", evidenceRefs: [{ type: "game", id: "f1" }] }, // 5 vs 3
        { lineIndex: 1, speakerName: "Mickey", isFactualClaim: true, text: "And Boone said they flat-out quit.", evidenceRefs: [{ type: "game", id: "f1" }] }, // invented quote
        { lineIndex: 2, speakerName: "Louie", isFactualClaim: true, text: "They're 48-38, that's real.", evidenceRefs: [{ type: "game", id: "f1" }] }, // grounded
        { lineIndex: 3, speakerName: "Mickey", isFactualClaim: false, text: "Oh, come on." }, // not a claim
      ],
    },
  ];
}

// A rewriter that grounds figures and makes attributions qualitative.
const goodRewrite: LineRewriter = async (ctx) => {
  if (ctx.unsupportedFigures.length) return { text: "Three homers tonight — three!", evidenceRefs: ctx.line.evidenceRefs };
  if (ctx.unsupportedAttributions.length) return { text: "And they flat-out quit out there — no fight.", isFactualClaim: false, evidenceRefs: [] };
  return null;
};

async function main() {
  console.log("Self-verify loop:");

  await check("checks only factual lines; corrects figure + attribution violations", async () => {
    const segs = freshSegments();
    const r = await selfVerifyAndCorrect(segs, { evidenceByRefId, fullEvidenceText, hostNames, rewrite: goodRewrite, maxAttempts: 3 });
    assert(r.factualLinesChecked === 3, `expected 3 factual lines checked, got ${r.factualLinesChecked}`);
    assert(r.linesWithViolations === 2, `expected 2 violating lines, got ${r.linesWithViolations}`);
    assert(r.linesCorrected === 2, `expected 2 corrected, got ${r.linesCorrected}`);
    assert(r.linesUnresolved === 0, `expected 0 unresolved, got ${r.linesUnresolved}`);
    const lines = segs[0].lines;
    assert(/three/i.test(lines[0].text) && !/five/i.test(lines[0].text), `figure line should now say three: ${lines[0].text}`);
    assert(lines[1].isFactualClaim === false, "attribution line went qualitative => isFactualClaim false");
    assert(!/boone/i.test(lines[1].text), `Boone attribution should be gone: ${lines[1].text}`);
  });

  await check("a grounded line (48-38 via corpus) is never touched", async () => {
    const segs = freshSegments();
    const before = segs[0].lines[2].text;
    await selfVerifyAndCorrect(segs, { evidenceByRefId, fullEvidenceText, hostNames, rewrite: goodRewrite, maxAttempts: 3 });
    assert(segs[0].lines[2].text === before, "grounded 48-38 line must be unchanged");
  });

  await check("unresolved after N attempts is reported, not silently passed", async () => {
    const segs = freshSegments();
    const stubborn: LineRewriter = async () => ({ text: "Five homers tonight — five!" }); // never fixes it
    const r = await selfVerifyAndCorrect(segs, { evidenceByRefId, fullEvidenceText, hostNames, rewrite: stubborn, maxAttempts: 2 });
    assert(r.linesUnresolved >= 1, `expected >=1 unresolved, got ${r.linesUnresolved}`);
    const fig = r.corrections.find((c) => c.lineIndex === 0)!;
    assert(fig && fig.attempts === 2 && !fig.resolved, `line 0 should be unresolved after 2 attempts: ${JSON.stringify(fig)}`);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
