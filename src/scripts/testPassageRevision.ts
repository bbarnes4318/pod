// AI passage revision and the quality report, with a FAKE model (no provider
// is called). Checks the rules that keep a rewrite honest: same lines, same
// speakers, new figures reported, a bad reply discarded, stale audio detected.
import assert from "node:assert";
import { flattenScriptLines, proposeRevision, selectPassage, staleLineIndexes, validateRevisionReply, MAX_PASSAGE_LINES } from "../lib/services/passageRevision";
import { buildQualityReport } from "../lib/services/qualityInspector";
import type { LLMProvider } from "../lib/providers/llm/interface";

const content = {
  segments: [
    { title: "Open", lines: [
      { lineIndex: 0, speakerName: "Zabala", text: "Welcome back." },
      { lineIndex: 1, speakerName: "Cal", text: "They won 12 of their last 15.", isFactualClaim: true },
      { lineIndex: 2, speakerName: "Zabala", text: "That is a soft schedule and you know it." },
    ] },
    { title: "Close", lines: [{ lineIndex: 3, speakerName: "Cal", text: "We will see Sunday." }] },
  ],
};
const fake = (reply: unknown): LLMProvider => ({
  name: "fake",
  generateText: async () => "",
  // Mirrors the provider contract: run the caller's validator, throw if it rejects.
  generateStructuredOutput: async (o: any) => {
    const problem = o.validate?.(reply);
    if (problem) throw new Error(`structured output failed validation after one repair: ${problem}`);
    return reply as any;
  },
});

async function main() {
  assert.equal(flattenScriptLines(content).length, 4);
  const sel = selectPassage(content, 1, 2);
  assert.ok(sel.ok && sel.passage.lines.length === 2 && sel.passage.before.length === 1 && sel.passage.after.length === 1);
  assert.ok(!selectPassage(content, 2, 1).ok, "end before start refused");
  assert.ok(!selectPassage(content, 1, 99).ok, "missing line refused");
  const long = { segments: [{ lines: Array.from({ length: MAX_PASSAGE_LINES + 1 }, (_, i) => ({ lineIndex: i, speakerName: "A", text: "x" })) }] };
  assert.ok(!selectPassage(long, 0, MAX_PASSAGE_LINES).ok, "over the cap refused");

  // A good reply: preview, one changed line, the invented figure is reported.
  const good = await proposeRevision(fake({ lines: [{ lineIndex: 1, text: "They won 12 of their last 15, and 80% on the road." }, { lineIndex: 2, text: "That is a soft schedule and you know it." }] }), content, { startLineIndex: 1, endLineIndex: 2 }, "punchier");
  assert.ok(good.ok);
  if (good.ok) {
    assert.equal(good.changedCount, 1);
    assert.equal(good.factualChanged, 1, "the changed line carries a claim");
    assert.deepEqual(good.lines[0].newFigures, ["80%"], "12 and 15 were already there; 80% is new");
    assert.equal(good.lines[1].changed, false);
  }

  // The model may not drop, add or reorder lines.
  if (sel.ok) {
    assert.ok(validateRevisionReply({ lines: [{ lineIndex: 1, text: "a" }] }, sel.passage)?.includes("exactly 2"));
    assert.ok(validateRevisionReply({ lines: [{ lineIndex: 2, text: "a" }, { lineIndex: 1, text: "b" }] }, sel.passage)?.includes("original order"));
    assert.ok(validateRevisionReply({ lines: [{ lineIndex: 1, text: " " }, { lineIndex: 2, text: "b" }] }, sel.passage)?.includes("no text"));
  }
  const bad = await proposeRevision(fake({ lines: [{ lineIndex: 1, text: "merged" }] }), content, { startLineIndex: 1, endLineIndex: 2 }, "merge them");
  assert.ok(!bad.ok && /discarded/.test(bad.error), "an invalid rewrite is discarded, not shown");
  const none = await proposeRevision(fake({}), content, { startLineIndex: 1, endLineIndex: 2 }, "  ");
  assert.ok(!none.ok, "an empty instruction never reaches the model");
  const down: LLMProvider = { name: "down", generateText: async () => "", generateStructuredOutput: async () => { throw new Error("status 400: Your credit balance is too low"); } };
  const out = await proposeRevision(down, content, { startLineIndex: 1, endLineIndex: 2 }, "x");
  assert.ok(!out.ok && /not available/.test(out.error) && !/credit balance/.test(out.error), "provider detail is not shown to the creator");

  // Stale audio: the recording remembers the words it was made from.
  assert.deepEqual(staleLineIndexes(flattenScriptLines(content), [{ lineIndex: 1, text: "They won 10 of 15." }, { lineIndex: 2, text: " That is a soft schedule and you know it. " }]), [1]);

  // The quality report repeats the gates; it does not invent verdicts.
  const line = (lineIndex: number, text: string, over = {}) => ({ lineIndex, speaker: "Cal", speakerHostId: null, text, tone: null, isFactual: false, dirty: false, requestedTone: null, citations: [], factStatus: null, factReason: null, ...over });
  const vm: any = {
    ok: true, scriptId: "s1", episodeStatus: "fact_checked",
    segments: [{ title: "Open", type: "open", lines: [line(0, "Welcome back."), line(1, "They won 12 of 15.", { isFactual: true }), line(2, "Edited line.", { dirty: true })] }],
    claims: [{ lineIndex: 1, text: "They won 12 of 15.", status: "failed", reason: "Unsupported claim.", citationCount: 0 }],
    factCheck: { present: true, status: "failed", checkedAt: null, coveragePercent: 50 },
    gate: { canPublish: false, unresolvedCount: 1, dirtyCount: 1, reasons: [] },
  };
  const r = buildQualityReport({ vm, editorial: { blocked: true, reasons: ["Held."], failedCriticalAxes: ["pacing"] }, business: { applies: false, allowed: true, reasons: [] }, staleAudioLines: [0], failedAudioLines: [], publishBlockers: ["No cover art.", "No cover art."] });
  const ids = r.blockers.map((b) => b.id);
  assert.deepEqual(ids, ["fc-status", "claim-1", "dirty-2", "editorial", "stale-0", "release-1"]);
  assert.equal(r.blockers.find((b) => b.id === "claim-1")!.lineIndex, 1, "a claim links to its line");
  assert.deepEqual(r.warnings.map((w) => w.id), ["coverage"]);
  const clean = buildQualityReport({ vm: { ...vm, claims: [], segments: [{ title: "Open", type: "open", lines: [line(0, "Welcome back.")] }], factCheck: { present: true, status: "passed", checkedAt: null, coveragePercent: 100 } }, editorial: { blocked: false, reasons: [], failedCriticalAxes: [] }, business: null, staleAudioLines: [], failedAudioLines: [], publishBlockers: [] });
  assert.equal(clean.blockers.length + clean.warnings.length, 0, "a clean episode reports nothing");

  console.log("ok  passage revision + quality report (fake model): lines kept, new figures flagged, bad reply discarded, stale audio found");
}
main().catch((e) => { console.error("FAIL", e); process.exit(1); });
