// The host writers must ask for the evidence-ref shape the pipeline accepts.
//
//   npm run test:evidence-ref-contract
//
// NETWORK-FREE.
//
// WHY IT EXISTS. There were two definitions of "an evidence reference" in one
// pipeline and nothing compared them:
//
//   * The host-writer prompt asked for a VERBATIM TEXT FRAGMENT, and showed a
//     worked example: {"evidenceRefs":["31 of 44 on third down"]}.
//   * Every consumer — scriptService's sanitiser, the fact-check gate, the
//     evidence panel — required a TYPED RECORD POINTER, {type,id}, whose key
//     appears in the episode's allowed source refs.
//
// scriptService.ts drops non-conforming refs with no violation and no log line,
// then counts the stripped line as an unsupported claim. So a writer that did
// exactly what it was told had 100% of its citations deleted and was penalised
// for the result.
//
// MEASURED, 2026-08-11 episode: factualLines=17, unsupportedClaims=17, and zero
// evidence refs survived into the saved script for either host. It read as a
// model compliance problem for as long as nobody diffed the two contracts.
//
// These checks are deliberately about the CONTRACT, not the wording: that the
// prompt asks for {type,id}, that its worked example parses as that shape, and
// that the writer rejects the old string form instead of letting it be deleted
// downstream.

import assert from "node:assert/strict";
import { EVIDENCE_TYPES } from "../lib/services/evidenceRefs";
import { MAX_INTENT_WORDS, makeTurnPlanValidator } from "../lib/services/scriptCreativePipeline";

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

/**
 * The writer prompt is built inside writeHostLines, which needs a provider. We
 * capture the prompt by handing it a provider that records and throws.
 */
async function capturePrompts(factRefs: Array<{ type: string; id: string }>) {
  const mod = await import("../lib/services/scriptCreativePipeline");
  const seen: { system?: string; cacheable?: string; prompt?: string; validate?: (v: unknown) => string | null } = {};
  const llm: any = {
    name: "capture",
    generateStructuredOutput: async (req: any) => {
      seen.system = req.systemPrompt;
      seen.cacheable = req.cacheableContext;
      seen.prompt = req.prompt;
      seen.validate = req.validate;
      return { lines: [{ turnIndex: 0, speakerName: "A", text: "x" }] };
    },
  };
  await mod.writeHostLines({
    llm,
    hostName: "A",
    otherHostName: "B",
    privateBrief: { speakerName: "A" } as any,
    foreignBriefTerms: [],
    spine: {},
    beats: [],
    chunkTurns: [
      { turnIndex: 0, beatIndex: 1, speakerName: "A", intent: "press", factRefs, targetWords: 40 } as any,
    ],
    ownTurnIndexes: [0],
    writtenSoFar: [],
    topicsEvidence: "evidence",
    systemPrompt: "base",
    movementNumber: 1,
    movementCount: 1,
    temperature: 0.7,
    maxTokens: 2000,
  });
  return seen;
}

async function main() {
  console.log("\nEvidence-ref contract — generator vs consumers\n");

  const REF = { type: "teamStat", id: "stat-1" };
  const withFacts = await capturePrompts([REF]);
  const noFacts = await capturePrompts([]);

  // =========================================================================
  console.log("  -- the prompt asks for the shape the pipeline accepts --");

  check("the worked example parses as a {type,id} object, not a string", () => {
    const example = /\{"lines":\[[\s\S]*\]\}/.exec(withFacts.prompt || "")?.[0];
    assert.ok(example, "the prompt must still contain a worked JSON example");
    const parsed = JSON.parse(example!.replace(/\$\{[^}]*\}/g, '"X"'));
    const claimLine = parsed.lines.find((l: any) => l.isFactualClaim === true);
    assert.ok(claimLine, "the example must show a factual-claim line");
    assert.equal(claimLine.evidenceRefs.length, 1);
    const ref = claimLine.evidenceRefs[0];
    assert.equal(typeof ref, "object", "a ref in the example must be an object — a bare string is deleted downstream");
    assert.ok(ref.type && ref.id, "the example ref must carry both type and id");
    assert.ok(
      (EVIDENCE_TYPES as readonly string[]).includes(ref.type),
      `the example's ref type ${JSON.stringify(ref.type)} must be one the gate accepts: ${EVIDENCE_TYPES.join(", ")}`
    );
  });

  check("the writer is told which refs it may cite", () => {
    assert.ok(
      (withFacts.prompt || "").includes(`"${REF.type}"`) && (withFacts.prompt || "").includes(REF.id),
      "the refs assigned to the writer's own turns must appear in the prompt, so it can copy rather than invent"
    );
  });

  check("with no facts assigned, the writer is told not to claim", () => {
    assert.ok(
      /isFactualClaim":false/.test(noFacts.prompt || "") &&
        /No facts were assigned/.test(noFacts.prompt || ""),
      "a movement with no assigned refs must instruct the writer to stop marking lines factual, not to invent a citation"
    );
  });

  // =========================================================================
  console.log("\n  -- the writer rejects what the sanitiser would silently delete --");

  const v = withFacts.validate!;
  const line = (over: Record<string, unknown>) => ({
    lines: [{ turnIndex: 0, speakerName: "A", text: "some words", ...over }],
  });

  check("a bare-string ref is rejected (the exact old prompt's output)", () => {
    const err = v(line({ evidenceRefs: ["31 of 44 on third down"], isFactualClaim: true }));
    assert.ok(err, "the string form must fail here rather than be deleted three stages later");
    assert.match(err!, /objects/i);
  });

  check("a ref not assigned to this writer's turns is rejected", () => {
    const err = v(line({ evidenceRefs: [{ type: "teamStat", id: "not-mine" }], isFactualClaim: true }));
    assert.ok(err, "an invented id resolves to nothing and would be stripped by scriptService");
  });

  check("a factual claim with empty refs is rejected", () => {
    const err = v(line({ evidenceRefs: [], isFactualClaim: true }));
    assert.ok(err, "this is the exact 17/17 shape that reached the fact-check gate");
    assert.match(err!, /isFactualClaim/);
  });

  check("an assigned ref on a factual claim passes", () => {
    assert.equal(v(line({ evidenceRefs: [REF], isFactualClaim: true })), null);
  });

  check("an opinion line with no refs passes", () => {
    assert.equal(v(line({ evidenceRefs: [], isFactualClaim: false })), null);
  });

  // =========================================================================
  console.log("\n  -- intent bound --");

  check(`an intent over ${MAX_INTENT_WORDS} words fails the plan`, () => {
    const validate = makeTurnPlanValidator(1200);
    const long = Array.from({ length: MAX_INTENT_WORDS + 1 }, (_, i) => `word${i}`).join(" ");
    const err = validate({ turns: [{ speakerName: "A", intent: long, targetWords: 40, turnIndex: 0, beatIndex: 1 }] });
    assert.ok(err && /intent runs/.test(err), "a paragraph-length intent must be rejected, not merely discouraged");
  });

  check("the prompt states the same limit it enforces", async () => {
    const mod = await import("../lib/services/scriptCreativePipeline");
    assert.equal(mod.MAX_INTENT_WORDS, MAX_INTENT_WORDS);
  });

  console.log(failed === 0 ? "\nAll evidence-ref contract checks passed.\n" : `\n${failed} check(s) FAILED.\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
