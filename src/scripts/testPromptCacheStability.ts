// Prompt-cache stability for the repeat callers.
//
//   npm run test:prompt-cache-stability
//
// NETWORK-FREE and credential-free — it drives the real prompt builders through
// a capturing provider and inspects the exact strings they would have sent.
//
// WHY IT EXISTS. Prompt caching is a PREFIX match: one changed byte anywhere in
// the prefix invalidates everything after it. A host writer runs about six times
// per episode and used to resend the private brief, the episode spine and the
// whole evidence packet *behind* the movement header and the transcript so far,
// so the static material sat after a byte that changed every call and never
// cached once.
//
// The split that fixes it is only worth anything if the static block is
// genuinely byte-identical across calls, and it is easy to make it not be —
// a JSON key order, a set iteration, a timestamp, or (here, specifically) a
// redaction pass that runs over the static block and might not be deterministic.
// So both properties are asserted directly:
//
//   1. BYTE IDENTITY — two consecutive movement calls for the same host produce
//      an identical cacheableContext and a DIFFERENT prompt. The second half
//      matters as much as the first: if the prompts were also identical, the
//      split would be trivially "stable" and would also mean the movement
//      header had stopped varying, which would be a real bug.
//
//   2. NO CONTENT LOSS — reconstructing systemPrompt + cacheableContext + prompt
//      recovers every section the single-string prompt used to carry. Moving
//      text between blocks must not be able to drop it.

import assert from "node:assert/strict";
import { runColdOpenTextTournament, writeHostLines } from "../lib/services/scriptCreativePipeline";
import type { LLMProvider } from "../lib/providers/llm/interface";

let failed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL ${name}\n       ${(err as Error).message}`);
  }
}

interface Captured {
  systemPrompt: string;
  cacheableContext: string;
  prompt: string;
}

/** Records exactly what each call would have sent, then returns a valid shape. */
function capturingProvider(sink: Captured[], reply: unknown): LLMProvider {
  return {
    name: "capture",
    getAccumulatedUsage: () => ({ inputTokens: 0, outputTokens: 0, requestCount: 0 }),
    generateText: async () => "",
    generateStructuredOutput: async (options: any) => {
      sink.push({
        systemPrompt: options.systemPrompt ?? "",
        cacheableContext: options.cacheableContext ?? "",
        prompt: options.prompt ?? "",
      });
      return reply as any;
    },
  } as unknown as LLMProvider;
}

const composed = (c: Captured) => [c.systemPrompt, c.cacheableContext, c.prompt].join("\n\n");

// ---------------------------------------------------------------------------
// Fixtures. Distinctive strings so "is this section present" is unambiguous.
// ---------------------------------------------------------------------------

const BRIEF_A = {
  speakerName: "Zabala",
  exclusiveFactResponsibility: "the attendance restatement in the filing",
  protectedBelief: "the front office knew about the shortfall before the audit closed",
  avoidedConcession: "that the coaching staff had any say in it",
  behavioralTrigger: "being told to wait for the official statement",
  misconceptionAboutOtherHost: "thinks Mercer is carrying water for the owners",
  genuineQuestion: "who actually signed off on the revised number",
  privateObjective: "get Mercer to concede the timeline is impossible",
};

const SPINE = { throughline: "a number that changed twice and nobody will own", stakes: "credibility" };
const EVIDENCE = "The filing restated attendance twice: 31,402 then 28,115, eleven days apart.";
const SYSTEM = "You are writing dialogue for a two-host sports debate podcast.";

const TURNS = [
  { turnIndex: 0, speakerName: "Zabala", intent: "open on the discrepancy", targetWords: 40, factRefs: [] },
  { turnIndex: 1, speakerName: "Mercer", intent: "deflect to process", targetWords: 40, factRefs: [] },
];

function hostArgs(movementNumber: number, beats: unknown, writtenSoFar: Array<{ turnIndex: number; speakerName: string; text: string }>) {
  return {
    hostName: "Zabala",
    otherHostName: "Mercer",
    privateBrief: BRIEF_A as never,
    foreignBriefTerms: ["Mercer believes the shortfall was a rounding artefact"],
    spine: SPINE,
    beats,
    chunkTurns: TURNS as never,
    ownTurnIndexes: [0],
    writtenSoFar,
    topicsEvidence: EVIDENCE,
    systemPrompt: SYSTEM,
    movementNumber,
    movementCount: 3,
    temperature: 0.9,
    maxTokens: 2000,
  };
}

const HOST_REPLY = { lines: [{ turnIndex: 0, speakerName: "Zabala", text: "They restated it twice." }] };

async function main() {
  console.log("\nPrompt cache stability\n");

  // =========================================================================
  console.log("  -- host writer: byte identity across movements --");

  const sink: Captured[] = [];
  const llm = capturingProvider(sink, HOST_REPLY);

  await writeHostLines({ llm, ...hostArgs(1, { beat: "the opening claim" }, []) });
  await writeHostLines({
    llm,
    ...hostArgs(2, { beat: "the walk-back" }, [{ turnIndex: 0, speakerName: "Zabala", text: "They restated it twice." }]),
  });

  await check("two consecutive movements captured two calls", () => {
    assert.equal(sink.length, 2);
  });

  await check("the cacheable static block is BYTE-IDENTICAL across the two calls", () => {
    assert.equal(
      sink[0].cacheableContext,
      sink[1].cacheableContext,
      "the static block differs between movements, so nothing after the first difference can cache"
    );
    assert.ok(sink[0].cacheableContext.length > 0, "an empty static block would pass this test vacuously");
  });

  await check("the system prompt is also byte-identical", () => {
    // It precedes the static block in render order, so a change here would
    // invalidate the static block's cache too.
    assert.equal(sink[0].systemPrompt, sink[1].systemPrompt);
  });

  await check("the dynamic prompt genuinely DIFFERS between the two calls", () => {
    assert.notEqual(
      sink[0].prompt,
      sink[1].prompt,
      "identical prompts would mean the movement header and transcript stopped varying — a real bug that " +
        "would make this suite pass for the wrong reason"
    );
  });

  await check("the static block carries the brief, the spine and the evidence", () => {
    const s = sink[0].cacheableContext;
    assert.ok(s.includes(BRIEF_A.protectedBelief), "private brief must be in the cached prefix");
    assert.ok(s.includes(SPINE.throughline), "episode spine must be in the cached prefix");
    assert.ok(s.includes(EVIDENCE), "evidence packet must be in the cached prefix");
  });

  await check("the per-movement material is NOT in the cached prefix", () => {
    // The whole point. Any of these leaking back into the static block would
    // silently restore the original bug.
    const s = sink[0].cacheableContext;
    assert.ok(!s.includes("MOVEMENT 1 of 3"), "the movement header must not sit in the cached prefix");
    assert.ok(!s.includes("the opening claim"), "per-movement beats must not sit in the cached prefix");
    assert.ok(!s.includes("TURN 0"), "the turn plan must not sit in the cached prefix");
  });

  await check("beats and transcript live in the dynamic prompt", () => {
    assert.ok(sink[0].prompt.includes("MOVEMENT 1 of 3"));
    assert.ok(sink[0].prompt.includes("the opening claim"));
    assert.ok(sink[1].prompt.includes("the walk-back"));
    assert.ok(sink[1].prompt.includes("They restated it twice."), "the transcript so far must reach the model");
  });

  // =========================================================================
  console.log("\n  -- host writer: no content was lost in the split --");

  await check("every section of the pre-split prompt survives somewhere", () => {
    const all = composed(sink[0]);
    // Section headers and instruction text that the single-string prompt
    // carried. Each must still be reachable by the model.
    for (const fragment of [
      "You are the private writer for Zabala",
      "YOUR PRIVATE BRIEF (Zabala only):",
      "EPISODE SPINE:",
      "BEATS IN PLAY:",
      "THE TURN PLAN FOR THIS MOVEMENT",
      "WHAT IS ALREADY ON THE PAGE",
      "EVIDENCE — only the facts assigned to your own turns",
      "EVIDENCE REFS ARE NOT DECORATION",
      "KEEP EACH REF SHORT",
      "Return valid JSON only",
      "isFactualClaim",
    ]) {
      assert.ok(all.includes(fragment), `lost from the composed prompt: "${fragment}"`);
    }
  });

  await check('"the EVIDENCE block above" still refers to text that precedes it', () => {
    // Providers render systemPrompt -> cacheableContext -> prompt, so the phrase
    // is only honest if the evidence really is earlier in that composition.
    const all = composed(sink[0]);
    const evidenceAt = all.indexOf("EVIDENCE — only the facts assigned");
    const referenceAt = all.indexOf("copied VERBATIM from the EVIDENCE block above");
    assert.ok(evidenceAt >= 0 && referenceAt >= 0, "both the evidence block and the reference to it must exist");
    assert.ok(
      evidenceAt < referenceAt,
      "the prompt tells the model to copy from 'the EVIDENCE block above', but the evidence now renders AFTER it"
    );
  });

  // =========================================================================
  console.log("\n  -- redaction still covers the whole composed prompt --");

  const leakSink: Captured[] = [];
  const LEAK = "Mercer believes the shortfall was a rounding artefact";
  await writeHostLines({
    llm: capturingProvider(leakSink, HOST_REPLY),
    ...hostArgs(1, { beat: LEAK }, []),
    // Put the foreign phrase into the SPINE, which now lives in the cached
    // block — the exact path a split could have opened.
    spine: { throughline: SPINE.throughline, leaked: LEAK },
  });

  await check("a foreign brief phrase in the STATIC block is redacted", () => {
    assert.ok(
      !leakSink[0].cacheableContext.includes(LEAK),
      "the other host's brief reached the cached prefix and was not removed"
    );
  });

  await check("a foreign brief phrase in the DYNAMIC block is redacted", () => {
    assert.ok(!leakSink[0].prompt.includes(LEAK));
  });

  await check("the redaction is reported, not silently applied", async () => {
    const s: Captured[] = [];
    const r = await writeHostLines({
      llm: capturingProvider(s, HOST_REPLY),
      ...hostArgs(1, { beat: "x" }, []),
      spine: { throughline: SPINE.throughline, leaked: LEAK },
    });
    assert.ok(r.isolation.redactedTerms.length > 0, "a leak through the static block must be recorded");
    assert.ok(!r.isolation.composed.includes(LEAK), "and must not survive in the composed record");
  });

  await check("redaction is DETERMINISTIC, so it does not break byte identity", () => {
    // The property the whole split rests on: redacting the static block must
    // produce the same bytes every time, or the cache prefix moves each call.
    const a: Captured[] = [];
    const b: Captured[] = [];
    return (async () => {
      await writeHostLines({
        llm: capturingProvider(a, HOST_REPLY),
        ...hostArgs(1, { beat: "one" }, []),
        spine: { throughline: SPINE.throughline, leaked: LEAK },
      });
      await writeHostLines({
        llm: capturingProvider(b, HOST_REPLY),
        ...hostArgs(2, { beat: "two" }, []),
        spine: { throughline: SPINE.throughline, leaked: LEAK },
      });
      assert.equal(a[0].cacheableContext, b[0].cacheableContext, "redaction produced different bytes on two runs");
    })();
  });

  // =========================================================================
  console.log("\n  -- cold-open tournament --");

  const coldSink: Captured[] = [];
  const coldReply = {
    lines: [
      { speakerName: "Zabala", text: "Twice. They restated it twice.", tone: "incredulous", energy: "high" },
      { speakerName: "Mercer", text: "Process takes time.", tone: "dismissive", energy: "medium" },
    ],
  };
  const coldWriter = capturingProvider(coldSink, coldReply);
  const coldJudge = capturingProvider([], {
    judgments: [
      { id: "accusation", score: 9, reasons: ["lands"] },
      { id: "consequence", score: 5, reasons: ["flat"] },
      { id: "contradiction", score: 4, reasons: ["flat"] },
    ],
  });

  await runColdOpenTextTournament({
    writer: coldWriter,
    writerPool: [
      { variantId: "accusation", provider: coldWriter, label: "capture/one" },
      { variantId: "consequence", provider: coldWriter, label: "capture/two" },
      { variantId: "contradiction", provider: coldWriter, label: "capture/two" },
    ] as never,
    judge: coldJudge,
    episodeTitle: "The number that moved",
    coldOpenBeat: { beat: "the restatement" },
    topicsEvidence: EVIDENCE,
    speakerNames: ["Zabala", "Mercer"],
    agendas: [BRIEF_A] as never,
    systemPrompt: SYSTEM,
  });

  await check("all three angles were written", () => {
    assert.equal(coldSink.length, 3, `expected 3 variant calls, got ${coldSink.length}`);
  });

  await check("the three angles share a byte-identical cached prefix", () => {
    assert.equal(coldSink[0].cacheableContext, coldSink[1].cacheableContext);
    assert.equal(coldSink[1].cacheableContext, coldSink[2].cacheableContext);
    assert.ok(coldSink[0].cacheableContext.includes(EVIDENCE), "the evidence packet must be in the cached prefix");
  });

  await check("the angle itself stays dynamic", () => {
    const prompts = coldSink.map((c) => c.prompt);
    assert.equal(new Set(prompts).size, 3, "each angle must produce a different prompt");
  });

  await check("no cold-open content was lost in the split", () => {
    const all = composed(coldSink[0]);
    for (const fragment of ["COLD-OPEN BEAT:", "PRIVATE AGENDAS (keep separate):", "EVIDENCE:", "Write ONE 45-second opening", "Return JSON only"]) {
      assert.ok(all.includes(fragment), `lost from the composed cold-open prompt: "${fragment}"`);
    }
    assert.ok(all.includes(EVIDENCE));
    assert.ok(all.includes(BRIEF_A.privateObjective), "the agendas must still reach the writer");
  });

  console.log(failed === 0 ? "\nAll prompt cache stability checks passed.\n" : `\n${failed} check(s) FAILED.\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
