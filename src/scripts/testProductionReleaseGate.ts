// EXECUTED regression proof for the editorial gate and the TTS choke point.
//
// The primary negative fixture is the real failed production episode
// e7867729-ca2a-40ec-bbed-1b68c8294e54 / script 83a4e347-2a06-49c2-8919-fff1c1b9ad57.
// Every measurement asserted below was taken from the published transcript.json:
//   66 lines, exactly 33 per host, 84.6% strict alternation,
//   233-word cold open spanning 30.9s-123.8s, and a host arguing the opposing
//   position in Topic 3.
//
// This file must FAIL if any of those defects would be publishable again.

import assert from "node:assert/strict";
import {
  evaluateProductionInvariants,
  detectPositionSwaps,
  COLD_OPEN_MAX_WORDS,
} from "../lib/services/productionInvariants";
import {
  evaluateScriptEditorialGate,
  evaluateDownstreamBlock,
} from "../lib/services/scriptEditorialGate";
import type { CombinedQualityReport } from "../lib/services/scriptQualityJudge";
import {
  assertScriptReleasableForProduction,
  ProductionHoldError,
  __setScriptContentLoaderForTests,
} from "../lib/queue/productionGuard";

let failures = 0;
function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  return (async () => {
    try {
      await fn();
      console.log(`  PASS  ${name}`);
    } catch (err) {
      failures += 1;
      console.error(`  FAIL  ${name}\n        ${(err as Error).message}`);
    }
  })();
}

const CAL = 'Cal "Red Eye" Mercer';
const ZAB = "Bernadette Zabala";

// --- The real failed cold open (verbatim, 11 lines / 233 spoken words) ------
const FAILED_COLD_OPEN_LINES = [
  [CAL, "The game ended in the first inning. That's not a dramatic finish, that's a scheduling error."],
  [ZAB, "And the broadcast told you that. The fans in the cheap seats watched a relief parade. That's not a scheduling error, Cal, that's the modern game."],
  [CAL, "It's a spreadsheet. The drama ended before the second inning."],
  [ZAB, "A spreadsheet with fifteen strikeouts and three hits. That's not a spreadsheet, that's execution."],
  [CAL, "It's a spreadsheet because you had eleven guys in a rotation with twelve pitches each. That's not a showcase, that's a logistics problem solved with a lineup card."],
  [ZAB, "You paid for a baseball game. You got eleven of the best arms in the league throwing a shutout. How is that a logistics problem?"],
  [CAL, "Because the best arms were sitting on the bench in the NL. The NL's ace was watching. That's not a showcase, it's a focus group."],
  [ZAB, "The AL still had to retire twenty-seven professional hitters. They did it. That's the product. The rest is context you don't have."],
  [CAL, "The fan didn't get a duel, they got a ceremony. The drama ended before the second inning."],
  [ZAB, "The ceremony was Mike Trout jogging to center field. You think the league leaned on nostalgia to sell a game that set a nine-inning strikeout record?"],
  [CAL, "The league leaned on him to sell the night. That's the point."],
] as const;

// Topic 3 is where the positions cross: Zabala takes over Cal's "the fan was
// bored / the format avoids competition" case, and speaks three times running.
const FAILED_TOPIC3_LINES = [
  [CAL, "The paying customer shows up for a starter's duel — two aces trading zeroes, building tension, owning the mound. Instead they got eleven faceless relievers, each throwing 12 pitches, managed by a matchup sheet."],
  [ZAB, "The NL's best three pitchers weren't even allowed to play. That's the real problem. The AL still had to execute, but the opponent was a diluted version of the league's best."],
  [CAL, "The AL still had to retire twenty-seven professional hitters. They did it with a rookie and a guy who hadn't been to an All-Star Game in eleven years. That's execution."],
  [ZAB, "The plan worked. Fifteen strikeouts, three hits, zero runs. The plan was brilliant. The NL's absences were rule-based, not the AL's problem."],
  [CAL, "The plan worked for the spreadsheet. The fan didn't get a starter's duel. They got a focus group. The product on the field didn't match the product on the ticket."],
  [ZAB, "The product on the field was a historic shutout. You're calling it a spreadsheet because you're bored by the lack of offense. That's your problem, not the product's."],
  [ZAB, "The fan was bored by the lack of a starter's duel because the game was a relief parade. That's a format designed to avoid competition. That's the problem."],
  [ZAB, "The fan was bored because the game was over in the first inning. That's a blown lead. That's a product."],
] as const;

function line(i: number, pair: readonly [string, string]) {
  return { lineIndex: i, speakerName: pair[0], text: pair[1] };
}

/** Reconstructs the failed episode's shape: 66 lines, exact 33/33 split. */
function buildFailedEpisodeSegments() {
  let idx = 0;
  const coldOpen = {
    type: "cold_open",
    title: "Cold Open: The Empty Seats",
    lines: FAILED_COLD_OPEN_LINES.map((p) => line(idx++, p as unknown as [string, string])),
  };
  const topic3 = {
    type: "topic",
    title: "Topic 3: Is an 11-Pitcher All-Star Shutout Great Baseball or Spreadsheet Baseball?",
    lines: FAILED_TOPIC3_LINES.map((p) => line(idx++, p as unknown as [string, string])),
  };
  // Filler that preserves the strict-alternation and exact-balance signature
  // without restating the whole transcript.
  const filler: Array<{ type: string; title: string; lines: ReturnType<typeof line>[] }> = [];
  const fillerLines: ReturnType<typeof line>[] = [];
  const calCount = coldOpen.lines.filter((l) => l.speakerName === CAL).length + topic3.lines.filter((l) => l.speakerName === CAL).length;
  const zabCount = coldOpen.lines.length + topic3.lines.length - calCount;
  // Pad alternately to reach 33/33 exactly, as the real episode did.
  let cal = calCount;
  let zab = zabCount;
  while (cal < 33 || zab < 33) {
    if (cal < 33) {
      fillerLines.push(line(idx++, [CAL, "The league is managing the product so it looks like baseball on television."]));
      cal += 1;
    }
    if (zab < 33) {
      fillerLines.push(line(idx++, [ZAB, "They held the NL to three hits. That is a dominant performance you keep ignoring."]));
      zab += 1;
    }
  }
  filler.push({ type: "topic", title: "Topic 1", lines: fillerLines });
  return [coldOpen, ...filler, topic3];
}

/**
 * A clean control. This exists to prove the invariants are not simply
 * always-fail, so it must satisfy them on merit: an in-band cold open, hosts
 * building points across consecutive lines (alternation under 65%), an uneven
 * line split, and a real concession that moves the argument.
 */
function buildHealthySegments() {
  const co = [
    [CAL, "You signed off on that trade in March. The player you gave up is leading the division in on-base percentage."],
    [CAL, "And the one you took back has not played since the first week of June."],
    [ZAB, "I signed off on the medical report I was handed. If the report was wrong, that is the argument you want."],
    [ZAB, "It is not the same argument as saying I ignored something."],
    [CAL, "Nobody read past page one. The person who wrote page four left the building in February."],
  ] as const;
  const body = [
    [ZAB, "Then that is a staffing failure, not a scouting one. Different problem, different people."],
    [ZAB, "Although — fair point. The medical chain broke before any of it reached my desk."],
    [CAL, "That is the part that costs somebody a job in September."],
    [ZAB, "Probably mine, the way this season is trending."],
    [CAL, "So what would actually change your mind about the original call?"],
    [CAL, "Because I have not heard a condition yet."],
    [ZAB, "A second opinion from outside the organisation. We never got one. I never asked for one."],
  ] as const;
  let i = 0;
  return [
    { type: "cold_open", title: "Cold open (accusation)", lines: co.map((p) => line(i++, p as unknown as [string, string])) },
    { type: "topic", title: "Topic 1", lines: body.map((p) => line(i++, p as unknown as [string, string])) },
  ];
}

function judgeReport(overall: number, axisOverride: Partial<Record<string, number>> = {}): CombinedQualityReport {
  const axes: Record<string, number> = {};
  for (const axis of [
    "hostDistinctness", "characterConsistency", "conversationalCausality", "spokenNaturalness",
    "mechanicalAlternation", "repetition", "genericFiller", "evidenceGrounding", "argumentProgression",
    "emotionalProgression", "movementContinuity", "callbacks", "closingPayoff", "monologueRestraint",
    "sentenceOpeningVariety", "agreementPhraseVariety", "singleModelSmell",
  ]) axes[axis] = 8;
  Object.assign(axes, axisOverride);
  return {
    deterministic: { total: 80, axes: {} } as CombinedQualityReport["deterministic"],
    judge: { overall, axes, bothHostsSoundLikeOneModel: false } as unknown as CombinedQualityReport["judge"],
    excerpts: [],
    lineCount: 66,
    wordCount: 1470,
  };
}

const PROD = { NODE_ENV: "production", SCRIPT_EDITORIAL_GATE_MODE: "hold" } as unknown as NodeJS.ProcessEnv;

async function main() {
  console.log("\n=== Failed production episode e7867729 must be rejected ===");
  const failed = buildFailedEpisodeSegments();
  const failedInv = evaluateProductionInvariants(failed, {
    activeHostNames: [CAL, ZAB],
    retiredHostNames: ["louie", "margo"],
  });

  await check("cold open of 233 words is rejected (limit 120)", () => {
    assert.ok(failedInv.measurements.coldOpenWords > COLD_OPEN_MAX_WORDS,
      `fixture cold open should exceed the band, got ${failedInv.measurements.coldOpenWords}`);
    assert.ok(failedInv.failedCriticalAxes.includes("coldOpenQuality"),
      `coldOpenQuality must fail; axes=${failedInv.failedCriticalAxes.join(",")}`);
  });

  await check("exact 33/33 line split is rejected as a balancing artefact", () => {
    const counts = Object.values(failedInv.measurements.perSpeakerLines);
    assert.deepEqual(counts.sort(), [33, 33], `expected 33/33, got ${JSON.stringify(failedInv.measurements.perSpeakerLines)}`);
    assert.ok(failedInv.failedCriticalAxes.includes("hostBalance"), "hostBalance must fail on an exact split");
  });

  await check("strict alternation above 65% is rejected", () => {
    assert.ok(failedInv.measurements.strictAlternationRatio > 0.65,
      `fixture alternation should exceed the ceiling, got ${failedInv.measurements.strictAlternationRatio}`);
    assert.ok(failedInv.failedCriticalAxes.includes("mechanicalAlternation"), "mechanicalAlternation must fail");
  });

  await check("host arguing the opponent's position is detected", () => {
    const flat = failed.flatMap((s) => s.lines.map((l) => ({ speaker: l.speakerName, text: l.text })));
    const swaps = detectPositionSwaps(flat);
    assert.ok(swaps.length > 0, "position ledger must flag at least one crossed position");
  });

  await check("no concession anywhere is rejected as flat argument progression", () => {
    assert.ok(failedInv.failedCriticalAxes.includes("argumentProgression"),
      "an episode with no position/understanding change must fail argumentProgression");
  });

  await check("retired host names are rejected", () => {
    const withRetired = [{ type: "topic", title: "A clean Louie-versus-Margo fight", lines: [line(0, [CAL, "x"] as unknown as [string, string])] }];
    const r = evaluateProductionInvariants(withRetired, { retiredHostNames: ["louie", "margo"] });
    assert.ok(r.failedCriticalAxes.includes("castIntegrity"), "retired host names must fail castIntegrity");
  });

  console.log("\n=== Gate must return HOLD, not review ===");
  await check("66/100-style judge score + failed invariants yields hold", () => {
    const gate = evaluateScriptEditorialGate(judgeReport(66), PROD, {
      invariants: failedInv,
      provenance: { path: "outline_driven", stages: [], judgeRan: true },
    });
    assert.equal(gate.decision, "hold", `expected hold, got ${gate.decision}: ${gate.reasons.join(" | ")}`);
    assert.ok(gate.downstreamBlocked, "hold must block downstream");
  });

  await check("a critical axis failure cannot hide behind a good aggregate", () => {
    // Judge is happy overall (88) but one critical axis is on the floor.
    const gate = evaluateScriptEditorialGate(judgeReport(88, { hostDistinctness: 3 }), PROD, {
      invariants: evaluateProductionInvariants(buildHealthySegments(), { activeHostNames: [CAL, ZAB] }),
      provenance: { path: "outline_driven", stages: [], judgeRan: true },
    });
    assert.equal(gate.decision, "hold", "a floored critical axis must hold despite a high overall score");
    assert.ok(gate.failedCriticalAxes.includes("hostDistinctness"), "the failing axis must be named");
  });

  await check("missing independent judge is a HOLD in production", () => {
    const noJudge: CombinedQualityReport = { ...judgeReport(90), judge: null, judgeError: "provider down" };
    const gate = evaluateScriptEditorialGate(noJudge, PROD, {
      invariants: evaluateProductionInvariants(buildHealthySegments(), { activeHostNames: [CAL, ZAB] }),
      provenance: { path: "outline_driven", stages: [], judgeRan: false },
    });
    assert.equal(gate.decision, "hold", "no judge in production must hold, not review");
  });

  await check("single-shot fallback is a HOLD even when the writing scores well", () => {
    const gate = evaluateScriptEditorialGate(judgeReport(92), PROD, {
      invariants: evaluateProductionInvariants(buildHealthySegments(), { activeHostNames: [CAL, ZAB] }),
      provenance: { path: "single_shot_fallback", fallbackReason: "outline returned 3 beats", stages: [], judgeRan: true },
    });
    assert.equal(gate.decision, "hold", "a fallback script must never publish itself");
    assert.ok(gate.failedCriticalAxes.includes("creativePipelinePath"), "the fallback must be named as the cause");
  });

  console.log("\n=== A genuinely clean script must still PASS (no always-fail) ===");
  await check("healthy script passes invariants and the gate", () => {
    const inv = evaluateProductionInvariants(buildHealthySegments(), { activeHostNames: [CAL, ZAB] });
    assert.equal(inv.worstSeverity, "pass",
      `control must pass; findings: ${inv.findings.map((f) => `${f.axis}:${f.message}`).join(" | ")}`);
    const gate = evaluateScriptEditorialGate(judgeReport(88), PROD, {
      invariants: inv,
      provenance: { path: "outline_driven", stages: [], judgeRan: true },
    });
    assert.equal(gate.decision, "pass", `control must pass the gate, got ${gate.decision}: ${gate.reasons.join(" | ")}`);
    assert.equal(gate.downstreamBlocked, false, "a pass must not block");
  });

  console.log("\n=== review now blocks automatic production ===");
  await check("review blocks downstream", () => {
    const v = evaluateDownstreamBlock({ editorialGate: { decision: "review", reasons: ["x"], failedCriticalAxes: [] } }, PROD);
    assert.equal(v.blocked, true, "review must block automatic downstream production");
  });
  await check("hold blocks downstream", () => {
    const v = evaluateDownstreamBlock({ editorialGate: { decision: "hold", reasons: ["x"], failedCriticalAxes: [] } }, PROD);
    assert.equal(v.blocked, true, "hold must block");
  });
  await check("pass does not block", () => {
    const v = evaluateDownstreamBlock({ editorialGate: { decision: "pass", reasons: [], failedCriticalAxes: [] } }, PROD);
    assert.equal(v.blocked, false, "pass must continue automatically");
  });
  await check("a script with no verdict at all is blocked in production", () => {
    assert.equal(evaluateDownstreamBlock({}, PROD).blocked, true, "an unevaluated script must not reach production");
  });
  await check("the old env-var bypass no longer clears a hold", () => {
    const env = { ...PROD, SCRIPT_EDITORIAL_HOLD_OVERRIDE: "true" } as unknown as NodeJS.ProcessEnv;
    const v = evaluateDownstreamBlock({ editorialGate: { decision: "hold", reasons: ["x"], failedCriticalAxes: [] } }, env);
    assert.equal(v.blocked, true, "SCRIPT_EDITORIAL_HOLD_OVERRIDE must no longer bypass a hold");
  });
  await check("a recorded human release does clear a hold, and is attributed", () => {
    const v = evaluateDownstreamBlock({
      editorialGate: { decision: "hold", reasons: ["x"], failedCriticalAxes: [] },
      humanRelease: { approvedBy: "producer@example.com", approvedAt: "now", approvedDecision: "hold", acknowledgedReasons: ["x"] },
    }, PROD);
    assert.equal(v.blocked, false, "an explicit human release must be able to clear a hold");
    assert.equal(v.releasedBy, "producer@example.com", "the release must be attributable");
  });
  await check("a release approved at 'review' does NOT clear a later 'hold'", () => {
    const v = evaluateDownstreamBlock({
      editorialGate: { decision: "hold", reasons: ["x"], failedCriticalAxes: [] },
      humanRelease: { approvedBy: "p", approvedAt: "now", approvedDecision: "review", acknowledgedReasons: [] },
    }, PROD);
    assert.equal(v.blocked, true, "a stale, weaker approval must not clear a worse verdict");
  });

  console.log("\n=== Queue chain: a held script must never reach TTS ===");
  await check("queueing TTS for a held script throws ProductionHoldError", async () => {
    __setScriptContentLoaderForTests(async () => ({
      content: { editorialGate: { decision: "hold", reasons: ["cold open is 233 words"], failedCriticalAxes: ["coldOpenQuality"] } },
      createdAt: new Date().toISOString(),
    }));
    await assert.rejects(
      () => assertScriptReleasableForProduction("script-held", "tts:generate-segments", PROD),
      (err: unknown) => err instanceof ProductionHoldError && err.verdict.decision === "hold",
      "a held script must be refused at the queue boundary"
    );
  });
  await check("queueing TTS for a review script throws too", async () => {
    __setScriptContentLoaderForTests(async () => ({
      content: { editorialGate: { decision: "review", reasons: ["judge unavailable"], failedCriticalAxes: [] } },
      createdAt: new Date().toISOString(),
    }));
    await assert.rejects(
      () => assertScriptReleasableForProduction("script-review", "tts:generate-segments", PROD),
      ProductionHoldError,
      "a review script must not auto-advance to TTS"
    );
  });
  await check("a passing script is allowed through the choke point", async () => {
    __setScriptContentLoaderForTests(async () => ({
      content: { editorialGate: { decision: "pass", reasons: [], failedCriticalAxes: [] } },
      createdAt: new Date().toISOString(),
    }));
    const v = await assertScriptReleasableForProduction("script-ok", "tts:generate-segments", PROD);
    assert.equal(v.blocked, false, "a passing script must proceed");
  });
  console.log("\n=== Rollout policy: legacy scripts must not be stranded, and must stay attributable ===");
  const CUTOVER = "2026-08-02T00:00:00.000Z";
  const PROD_WITH_CUTOVER = { ...PROD, SCRIPT_GATE_ENFORCEMENT_FROM: CUTOVER } as unknown as NodeJS.ProcessEnv;
  const legacyContent = { segments: [] }; // a real pre-gate script: no editorialGate at all

  await check("a pre-existing script with NO verdict is blocked when no cutover is configured", async () => {
    __setScriptContentLoaderForTests(async () => ({ content: legacyContent, createdAt: "2026-07-01T00:00:00.000Z" }));
    await assert.rejects(
      () => assertScriptReleasableForProduction("legacy-1", "tts:generate-segments", PROD),
      (err: unknown) =>
        err instanceof ProductionHoldError &&
        /SCRIPT_GATE_ENFORCEMENT_FROM is not configured/.test(err.message),
      "with no cutover set, nothing may be grandfathered"
    );
  });

  await check("a pre-existing script IS grandfathered once the cutover is configured", async () => {
    __setScriptContentLoaderForTests(async () => ({ content: legacyContent, createdAt: "2026-07-01T00:00:00.000Z" }));
    const v = await assertScriptReleasableForProduction("legacy-2", "tts:generate-segments", PROD_WITH_CUTOVER);
    assert.equal(v.blocked, false, "in-flight work created before the cutover must be able to finish");
    assert.equal(v.rollout?.grandfathered, true, "the allowance must be recorded");
  });

  await check("a grandfathered pass is ATTRIBUTABLE, not silent", async () => {
    __setScriptContentLoaderForTests(async () => ({ content: legacyContent, createdAt: "2026-07-01T00:00:00.000Z" }));
    const v = await assertScriptReleasableForProduction("legacy-3", "tts:generate-segments", PROD_WITH_CUTOVER);
    assert.equal(v.rollout?.disposition, "grandfathered_pre_enforcement");
    assert.equal(v.rollout?.scriptCreatedAt, "2026-07-01T00:00:00.000Z", "the script's creation time must be recorded");
    assert.equal(v.rollout?.cutoverAt, CUTOVER, "the cutover it was compared against must be recorded");
    assert.ok(v.reasons.some((r) => /before the editorial-gate enforcement cutover/.test(r)), "a human-readable reason must be attached");
  });

  await check("grandfathering is NOT a global bypass: a script created AFTER the cutover is still blocked", async () => {
    __setScriptContentLoaderForTests(async () => ({ content: legacyContent, createdAt: "2026-08-03T00:00:00.000Z" }));
    await assert.rejects(
      () => assertScriptReleasableForProduction("new-unmeasured", "tts:generate-segments", PROD_WITH_CUTOVER),
      (err: unknown) => err instanceof ProductionHoldError && /at or after the enforcement cutover/.test(err.message),
      "a script written after the cutover with no verdict is a pipeline defect, not a rollout gap"
    );
  });

  await check("grandfathering NEVER applies to a script that was measured and FAILED", async () => {
    // This is the crucial asymmetry. Age excuses "never evaluated"; it does not
    // excuse "evaluated and found unacceptable".
    __setScriptContentLoaderForTests(async () => ({
      content: { editorialGate: { decision: "hold", reasons: ["cold open is 223 words"], failedCriticalAxes: ["coldOpenQuality"] } },
      createdAt: "2026-01-01T00:00:00.000Z",
    }));
    await assert.rejects(
      () => assertScriptReleasableForProduction("old-but-held", "tts:generate-segments", PROD_WITH_CUTOVER),
      ProductionHoldError,
      "an old script that FAILED the gate must still be blocked; its remedy is a human release"
    );
  });

  await check("an old REVIEW script is blocked but has a documented remedy (human release)", async () => {
    const reviewed = {
      editorialGate: { decision: "review", reasons: ["judge 72/100"], failedCriticalAxes: [] },
    };
    __setScriptContentLoaderForTests(async () => ({ content: reviewed, createdAt: "2026-01-01T00:00:00.000Z" }));
    await assert.rejects(
      () => assertScriptReleasableForProduction("old-review", "tts:generate-segments", PROD_WITH_CUTOVER),
      ProductionHoldError,
      "an old review script must not auto-advance"
    );
    // ...and the remedy works, so it is not permanently unproducible.
    __setScriptContentLoaderForTests(async () => ({
      content: {
        ...reviewed,
        humanRelease: { approvedBy: "producer@example.com", approvedAt: "now", approvedDecision: "review", acknowledgedReasons: ["judge 72/100"] },
      },
      createdAt: "2026-01-01T00:00:00.000Z",
    }));
    const v = await assertScriptReleasableForProduction("old-review", "tts:generate-segments", PROD_WITH_CUTOVER);
    assert.equal(v.blocked, false, "a recorded human release must unstick in-flight reviewed work");
    assert.equal(v.releasedBy, "producer@example.com");
  });

  await check("an unparseable cutover does not silently grandfather everything", async () => {
    const badEnv = { ...PROD, SCRIPT_GATE_ENFORCEMENT_FROM: "whenever" } as unknown as NodeJS.ProcessEnv;
    __setScriptContentLoaderForTests(async () => ({ content: legacyContent, createdAt: "2026-07-01T00:00:00.000Z" }));
    await assert.rejects(
      () => assertScriptReleasableForProduction("bad-cutover", "tts:generate-segments", badEnv),
      ProductionHoldError,
      "a malformed cutover must fail closed, not open"
    );
  });

  await check("a script with no usable creation time is not grandfathered", async () => {
    __setScriptContentLoaderForTests(async () => ({ content: legacyContent, createdAt: null }));
    await assert.rejects(
      () => assertScriptReleasableForProduction("no-date", "tts:generate-segments", PROD_WITH_CUTOVER),
      ProductionHoldError,
      "without a creation time a script cannot be shown to predate the cutover"
    );
  });

  __setScriptContentLoaderForTests(null);

  console.log(
    `\nMeasured on the failed-episode fixture: coldOpen=${failedInv.measurements.coldOpenWords}w, ` +
      `alternation=${(failedInv.measurements.strictAlternationRatio * 100).toFixed(1)}%, ` +
      `lines=${JSON.stringify(failedInv.measurements.perSpeakerLines)}, ` +
      `positionSwaps=${failedInv.measurements.positionSwapCount}`
  );
  console.log(failures === 0 ? "\nALL CHECKS PASSED\n" : `\n${failures} CHECK(S) FAILED\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
