// Antithesis pass regression closures.
//
// The failure this covers: episode 36d6bfea died at the script gate with
// "5 line(s) still use the balanced-negation frame after 2 rewrite round(s)",
// and a retry died with FIFTEEN. Four independent defects produced that:
//
//   1. the detector flagged ordinary comparatives ("more points than Embiid"),
//      so the rewriter was told to delete a contrast that was not there;
//   2. the frame rewriter was the FACT-GROUNDING rewriter, whose headline
//      instruction is about evidence and whose word ceiling is shrink-only, so
//      a correct same-length repair was discarded and the frame survived;
//   3. a rewrite that INTRODUCED a new frame was kept, so counts could climb;
//   4. a failed provider call consumed a rewrite round and was then reported
//      as the script refusing to comply.
//
// NETWORK-FREE. Run: npm run test:antithesis-pass

import { findAntithesis, deterministicAntithesisFix } from "../lib/services/scriptAntithesis";
import { antithesisPassAndCorrect, type ScriptSegmentLike } from "../lib/services/scriptAntithesisPass";

let passed = 0, failed = 0;
function check(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log(`  OK  ${name}`); })
    .catch((err) => { failed++; console.error(`  FAIL ${name}\n       ${(err as Error).message}`); });
}
function assert(c: boolean, m: string) { if (!c) throw new Error(m); }

const NO_OP_REWRITE = async () => new Map();
const ALL_FRAMES_VIOLATE = { maxPerEpisode: 0, maxPerSpeaker: 0, coldOpenLines: 0 };

function segmentsOf(texts: string[], speaker = "Ambrose Fettig"): ScriptSegmentLike[] {
  return [{ type: "topic", lines: texts.map((text, i) => ({ lineIndex: 10 + i, speakerName: speaker, text })) }];
}

async function main() {
  console.log("\n1 — the detector matches the frame, not ordinary speech\n");

  await check("plain comparatives are not tells", () => {
    for (const text of [
      "Jokic scored more points than Embiid did all series.",
      "She's got more range than anyone on that roster.",
      "He played well, not great.",
    ]) {
      assert(findAntithesis(text).length === 0,
        `flagged ordinary speech: ${JSON.stringify(text)} -> ${findAntithesis(text).map((h) => h.kind).join(",")}`);
    }
  });

  await check("the real frames are still caught", () => {
    for (const text of [
      "That's not a slump. That's a collapse.",
      "It's a coaching decision, not a character flaw.",
      "This isn't about money, it's about respect.",
      "He's more a rumor than a rotation player.",
    ]) {
      assert(findAntithesis(text).length > 0, `missed a real frame: ${JSON.stringify(text)}`);
    }
  });

  console.log("\n2 — the common frames are cut without a model at all\n");

  await check("deterministic repair removes the frame and keeps the meaning", () => {
    const cut = deterministicAntithesisFix("That's not a slump. That's a collapse.", "not_X_but_Y");
    assert(cut === "That's a collapse.", `expected the affirmative half, got ${JSON.stringify(cut)}`);
    assert(findAntithesis(cut!).length === 0, "the repair left a frame behind");
  });

  await check("a pass with NO rewriter still resolves what regex can cut", async () => {
    const segments = segmentsOf([
      "That's not a slump. That's a collapse.",
      "It's a coaching decision, not a character flaw.",
    ]);
    const report = await antithesisPassAndCorrect(segments, {
      rewrite: NO_OP_REWRITE,
      policy: ALL_FRAMES_VIOLATE,
      conversationRepair: false,
    });
    assert(report.linesUnresolved === 0,
      `${report.linesUnresolved} line(s) unresolved with zero model calls available`);
    assert(report.linesFixedDeterministically === 2,
      `expected 2 deterministic cuts, got ${report.linesFixedDeterministically}`);
  });

  console.log("\n3 — a rewrite may never make a line worse\n");

  await check("a rewrite that introduces a new frame is rejected", async () => {
    const segments = segmentsOf(["You just described a rebuild."]);
    const original = segments[0].lines![0].text;
    const report = await antithesisPassAndCorrect(segments, {
      rewrite: NO_OP_REWRITE,
      // Answers with a line carrying TWO frames where the original had one.
      rewriteAntithesis: async (items) => ({
        rewrites: new Map(items.map((item) => [item.lineIndex, {
          text: "Same roster. New excuse. That's not a rebuild, that's a retreat.",
        }])),
        hardFailure: false,
      }),
      policy: ALL_FRAMES_VIOLATE,
      conversationRepair: false,
    });
    assert(segments[0].lines![0].text === original,
      `a worse rewrite was kept: ${JSON.stringify(segments[0].lines![0].text)}`);
    assert(report.linesUnresolved === 1, "the line should remain flagged, not silently 'fixed'");
  });

  console.log("\n4 — a dead provider is not a defiant script\n");

  await check("a failed rewrite call does not spend a round, and says so", async () => {
    const segments = segmentsOf(["You just described a rebuild."]);
    let calls = 0;
    const report = await antithesisPassAndCorrect(segments, {
      rewrite: NO_OP_REWRITE,
      rewriteAntithesis: async () => {
        calls++;
        return { rewrites: new Map(), hardFailure: true, failureMessage: "429 rate limit" };
      },
      maxRounds: 2,
      policy: ALL_FRAMES_VIOLATE,
      conversationRepair: false,
    });
    assert(report.rewriteUnavailable, "the outage must be reported as an outage");
    assert(report.rounds === 0, `no round may be charged for a call that never ran (rounds=${report.rounds})`);
    assert(calls > 1, `the failed call should be retried, ran ${calls} time(s)`);
    assert(report.reasons.some((r) => r.includes("429")),
      "the provider error must survive into the reasons an operator reads");
  });

  console.log("\n5 — conversation repair cannot smuggle a frame back in\n");

  await check("a frame introduced by conversation repair is re-checked, not shipped", async () => {
    // Two speakers, second line answers nothing -> conversation repair fires.
    const segments: ScriptSegmentLike[] = [{
      type: "topic",
      lines: [
        { lineIndex: 10, speakerName: "Ambrose Fettig", text: "The defense collapsed in the fourth quarter entirely." },
        { lineIndex: 11, speakerName: "Marisol Vandergrift", text: "Barcelona sold nineteen players last summer window." },
      ],
    }];
    const report = await antithesisPassAndCorrect(segments, {
      // The conversation repairer hands back a line carrying the banned frame.
      rewrite: async (items) => new Map(items.map((item) => [
        item.line.lineIndex,
        { text: "That's not a rebuild. That's a fire sale." },
      ])),
      policy: ALL_FRAMES_VIOLATE,
      conversationRepair: true,
    });
    const finalText = segments[0].lines![1].text;
    assert(findAntithesis(finalText).length === 0,
      `a frame introduced after the final count shipped unchecked: ${JSON.stringify(finalText)}`);
    assert(report.totalHits === 0,
      `the reported hit count must describe the script that actually leaves (totalHits=${report.totalHits})`);
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main();
