// Self-verify loop test. Run: npm run test:self-verify
//
// Proves FIX 1: after generation, each isFactualClaim:true line is checked with
// the SAME verifier the gate uses, and violations are sent to a BATCHED
// rewriter (one call per round for ALL flagged lines) until grounded (or given
// up after N rounds). Uses a STUB rewriter — no LLM/DB. Planted violations
// must always be caught and either corrected or reported as unresolved —
// never silently passed.

import { selfVerifyAndCorrect, BatchLineRewriter, RewriteContext } from "../lib/services/scriptSelfVerify";

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

/** Lift a per-line stub into the batched signature (and count batch calls). */
function batchOf(
  perLine: (ctx: RewriteContext) => Promise<{ text: string; evidenceRefs?: any[]; isFactualClaim?: boolean } | null>,
  counter?: { calls: number }
): BatchLineRewriter {
  return async (items) => {
    if (counter) counter.calls++;
    const out = new Map<number, { text: string; evidenceRefs?: any[]; isFactualClaim?: boolean }>();
    for (const ctx of items) {
      const r = await perLine(ctx);
      if (r) out.set(ctx.line.lineIndex, r);
    }
    return out;
  };
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
const goodRewrite = (ctx: RewriteContext) =>
  Promise.resolve(
    ctx.unsupportedFigures.length
      ? { text: "Three homers tonight — three!", evidenceRefs: ctx.line.evidenceRefs }
      : ctx.unsupportedAttributions.length
        ? { text: "And they flat-out quit out there — no fight.", isFactualClaim: false, evidenceRefs: [] }
        : null
  );

async function main() {
  console.log("Self-verify loop (batched):");

  await check("checks only factual lines; corrects figure + attribution violations", async () => {
    const segs = freshSegments();
    const r = await selfVerifyAndCorrect(segs, { evidenceByRefId, fullEvidenceText, hostNames, rewrite: batchOf(goodRewrite), maxAttempts: 3 });
    assert(r.factualLinesChecked === 3, `expected 3 factual lines checked, got ${r.factualLinesChecked}`);
    assert(r.linesWithViolations === 2, `expected 2 violating lines, got ${r.linesWithViolations}`);
    assert(r.linesCorrected === 2, `expected 2 corrected, got ${r.linesCorrected}`);
    assert(r.linesUnresolved === 0, `expected 0 unresolved, got ${r.linesUnresolved}`);
    const lines = segs[0].lines;
    assert(/three/i.test(lines[0].text) && !/five/i.test(lines[0].text), `figure line should now say three: ${lines[0].text}`);
    assert(lines[1].isFactualClaim === false, "attribution line went qualitative => isFactualClaim false");
    assert(!/boone/i.test(lines[1].text), `Boone attribution should be gone: ${lines[1].text}`);
  });

  await check("FIX 1: two violating lines are rewritten in ONE batched call (not one call per line)", async () => {
    const segs = freshSegments();
    const counter = { calls: 0 };
    const r = await selfVerifyAndCorrect(segs, { evidenceByRefId, fullEvidenceText, hostNames, rewrite: batchOf(goodRewrite, counter), maxAttempts: 3 });
    assert(r.linesCorrected === 2, `expected 2 corrected, got ${r.linesCorrected}`);
    assert(counter.calls === 1, `expected exactly 1 batched rewrite call for 2 flagged lines, got ${counter.calls}`);
  });

  await check("a grounded line (48-38 via corpus) is never touched", async () => {
    const segs = freshSegments();
    const before = segs[0].lines[2].text;
    await selfVerifyAndCorrect(segs, { evidenceByRefId, fullEvidenceText, hostNames, rewrite: batchOf(goodRewrite), maxAttempts: 3 });
    assert(segs[0].lines[2].text === before, "grounded 48-38 line must be unchanged");
  });

  await check("unresolved after N rounds is reported, not silently passed", async () => {
    const segs = freshSegments();
    const stubborn = () => Promise.resolve({ text: "Five homers tonight — five!" }); // never fixes it
    const r = await selfVerifyAndCorrect(segs, { evidenceByRefId, fullEvidenceText, hostNames, rewrite: batchOf(stubborn), maxAttempts: 2 });
    assert(r.linesUnresolved >= 1, `expected >=1 unresolved, got ${r.linesUnresolved}`);
    const fig = r.corrections.find((c) => c.lineIndex === 0)!;
    assert(fig && fig.attempts === 2 && !fig.resolved, `line 0 should be unresolved after 2 rounds: ${JSON.stringify(fig)}`);
  });

  await check("a batch-rewrite failure leaves lines unresolved (gate still catches them)", async () => {
    const segs = freshSegments();
    const broken: BatchLineRewriter = async () => { throw new Error("model unavailable"); };
    const r = await selfVerifyAndCorrect(segs, { evidenceByRefId, fullEvidenceText, hostNames, rewrite: broken, maxAttempts: 2 });
    assert(r.linesWithViolations === 2, `expected 2 violations detected, got ${r.linesWithViolations}`);
    assert(r.linesUnresolved === 2, `expected 2 unresolved on rewriter failure, got ${r.linesUnresolved}`);
    assert(/five/i.test(segs[0].lines[0].text), "original violating text must remain for the gate to catch");
  });

  await check("semantic pass: flags + rewrites a subject-mismatch line (right figure, wrong team)", async () => {
    const segs = [
      { lines: [{ lineIndex: 0, speakerName: "Louie", isFactualClaim: true, text: "The Yankees are 39-48, nine under.", evidenceRefs: [{ type: "game", id: "f1" }] }] },
    ];
    const evByRef = new Map<string, string>([["f1", "The Orioles are 39-48, nine games under .500. The Yankees are 48-38."]]);
    const full = "The Orioles are 39-48, nine under. The Yankees are 48-38, second in the East.";
    const semanticReview = async (lines: any[]) => {
      const l = lines.find((x) => x.lineIndex === 0);
      // subject-mismatch = the Yankees stated AS 39-48 (adjacent)
      return l && /yankees\s+(are\s+)?39-?48/i.test(l.text)
        ? [{ lineIndex: 0, status: "needs_review", reason: "39-48 is the Orioles' record, not the Yankees'" }]
        : [];
    };
    const rewrite = (ctx: RewriteContext) =>
      Promise.resolve(
        ctx.semanticReason ? { text: "The Orioles are 39-48, nine under — the Yankees are 48-38.", evidenceRefs: ctx.line.evidenceRefs } : null
      );
    const r = await selfVerifyAndCorrect(segs, { evidenceByRefId: evByRef, fullEvidenceText: full, hostNames: ["Louie", "Mickey"], rewrite: batchOf(rewrite), semanticReview, maxSemanticRounds: 2 });
    assert(r.semantic.ran, "semantic pass ran");
    assert(r.semantic.linesFlagged === 1, `flagged 1, got ${r.semantic.linesFlagged}`);
    assert(r.semantic.linesCorrected === 1, `corrected 1, got ${r.semantic.linesCorrected}`);
    assert(r.semantic.linesUnresolved === 0, `unresolved 0, got ${r.semantic.linesUnresolved}`);
    assert(!/yankees are 39-?48/i.test(segs[0].lines[0].text), `subject must be fixed: ${segs[0].lines[0].text}`);
  });

  await check("semantic unresolved after maxSemanticRounds is reported (never silently passed)", async () => {
    const segs = [{ lines: [{ lineIndex: 0, speakerName: "Louie", isFactualClaim: true, text: "The Yankees are 39-48.", evidenceRefs: [{ type: "game", id: "f1" }] }] }];
    const evByRef = new Map<string, string>([["f1", "The Orioles are 39-48."]]);
    const semanticReview = async () => [{ lineIndex: 0, status: "needs_review", reason: "wrong subject" }]; // never satisfied
    const rewrite = (ctx: RewriteContext) => Promise.resolve(ctx.semanticReason ? { text: "The Yankees are 39-48." } : null); // no real change
    const r = await selfVerifyAndCorrect(segs, { evidenceByRefId: evByRef, fullEvidenceText: "The Orioles are 39-48.", hostNames: ["Louie", "Mickey"], rewrite: batchOf(rewrite), semanticReview, maxSemanticRounds: 2 });
    assert(r.semantic.rounds === 2, `expected 2 rounds, got ${r.semantic.rounds}`);
    assert(r.semantic.linesUnresolved === 1, `expected 1 unresolved, got ${r.semantic.linesUnresolved}`);
  });

  await check("FIX 3: a rewrite preserves the trailing em-dash of an interruption predecessor", async () => {
    const segs = [{ lines: [{ lineIndex: 0, speakerName: "Louie", isFactualClaim: true, text: "Five homers, and that's—", evidenceRefs: [{ type: "game", id: "f1" }] }] }];
    const evByRef = new Map<string, string>([["f1", "Detroit hit three home runs."]]);
    const rewrite = () => Promise.resolve({ text: "Three homers, and that's the story." }); // drops the dash + period
    const r = await selfVerifyAndCorrect(segs, { evidenceByRefId: evByRef, fullEvidenceText: "Detroit hit three home runs.", hostNames: ["Louie", "Mickey"], rewrite: batchOf(rewrite), maxAttempts: 2 });
    assert(/—$/.test(segs[0].lines[0].text.trim()), `em-dash must be preserved, got: ${segs[0].lines[0].text}`);
    assert(r.linesCorrected === 1, "figure still corrected");
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
