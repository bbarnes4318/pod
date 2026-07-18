// Format-driven script engine tests (Prompt 7, PR 2). Run: npm run test:format-script
//
// Proves: per-format prompt pieces (the DEBATE pieces are the exact legacy
// text), N-speaker persona blocks, format-driven balance floors (debate keeps
// its historical 25%/20% pair), and strict script validation/binding for
// 1/2/3/4-speaker content — all PURE, no LLM, no database, no network.

import { getShowFormat } from "../lib/formats/showFormatRegistry";
import { formatPromptPieces, castPersonaBlocks } from "../lib/formats/formatScriptPrompts";
import { castBalanceGateMessage, generationFloorPct, approvalFloorPct } from "../lib/formats/formatScriptValidation";
import { validateScriptContent, sanitizeScriptContent } from "../lib/services/scriptValidation";
import type { AiHost } from "@prisma/client";

let passed = 0, failed = 0;
function check(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.error(`  ✗ ${name}\n      ${(err as Error).message}`); }
}
function assert(c: boolean, m: string) { if (!c) throw new Error(m); }

const mkHost = (id: string, name: string, intensity: number): AiHost =>
  ({
    id, name, slug: id, role: "host", worldview: `w-${id}`, speakingStyle: `s-${id}`,
    catchphrases: [], likes: [], dislikes: [], argumentPatterns: [], bannedPhrases: [],
    intensityLevel: intensity, ttsProvider: "stub", ttsVoiceId: "v",
  } as unknown as AiHost);

const H = [mkHost("h1", "Blaze", 9), mkHost("h2", "Calm", 3), mkHost("h3", "Mid", 6), mkHost("h4", "Wild", 8)];

function scriptContent(lines: Array<{ speaker: string; hostId?: string; factual?: boolean }>) {
  return {
    episodeTitle: "T", version: 1, estimatedDurationMinutes: 10,
    segments: [{
      type: "topic", title: "S", lines: lines.map((l, i) => ({
        lineIndex: i, speakerName: l.speaker, speakerHostId: l.hostId ?? "",
        text: `Line number ${i} says something distinct and long enough to count as real dialogue content ${"x".repeat(i % 7)}.`,
        tone: "analytical", energy: "medium", pauseBefore: "beat", isInterruption: false,
        evidenceRefs: [], isFactualClaim: l.factual ?? false, needsHumanReview: false,
      })),
    }],
    safety: {},
  };
}

function main() {
  console.log("\nFormat-driven script engine — prompts, floors, validation\n");

  check("CORE: the debate prompt pieces are the exact legacy text", () => {
    const debate = getShowFormat("two_host_debate")!;
    const pieces = formatPromptPieces(debate, [H[0], H[1]]);
    assert(pieces.showDescriptor === "a two-host sports debate podcast", "descriptor unchanged");
    assert(pieces.scriptNoun === "debate script", "noun unchanged");
    assert(pieces.dynamicsContract.startsWith("CHEMISTRY CONTRACT (the engine of the show):"), "contract header");
    assert(pieces.dynamicsContract.includes(`${H[1].name} drives just as hard as ${H[0].name}`), "legacy contract body verbatim");
    assert(pieces.extraSpeechRules === "", "no extra rules injected into the debate");
    const blocks = castPersonaBlocks(debate, [H[0], H[1]]);
    assert(blocks.startsWith(`Host 1: ${H[0].name} (ID: ${H[0].id})\n- Role:`), "legacy Host 1 block shape");
    assert(!blocks.includes("Format Chair"), "debate blocks carry NO extra role line (byte-stable)");
  });

  check("solo/interview/roundtable pieces address their own dynamics", () => {
    const solo = formatPromptPieces(getShowFormat("solo_briefing")!, [H[0]]);
    assert(solo.dynamicsContract.includes("carries the WHOLE episode alone"), "solo contract");
    assert(solo.extraSpeechRules.includes(`speakerName is "${H[0].name}"`), "solo pins the single speaker");
    const interview = formatPromptPieces(getShowFormat("interview")!, [H[0], H[1]]);
    assert(interview.dynamicsContract.includes(`${H[0].name} DRIVES`) && interview.dynamicsContract.includes(`${H[1].name} CARRIES`), "interview roles bound to cast");
    const round = formatPromptPieces(getShowFormat("roundtable")!, [H[0], H[1], H[2]]);
    assert(round.dynamicsContract.includes(`${H[0].name} MODERATES`), "moderator named");
    assert(round.dynamicsContract.includes(H[1].name) && round.dynamicsContract.includes(H[2].name), "panelists named");
    const blocks = castPersonaBlocks(getShowFormat("roundtable")!, [H[0], H[1], H[2]]);
    assert(blocks.includes("Host 3:") && blocks.includes("Format Chair: Panelist 2"), "3 blocks with format roles");
  });

  check("CORE: balance floors — the debate keeps its historical 25/20 pair", () => {
    const debate = getShowFormat("two_host_debate")!;
    assert(approvalFloorPct(debate, 0) === 25 && approvalFloorPct(debate, 1) === 25, "approval 25%");
    assert(generationFloorPct(debate, 0) === 20 && generationFloorPct(debate, 1) === 20, "generation 20%");
    const seats = (a: number, b: number) => [
      { hostId: "h1", hostName: "Blaze", seatIndex: 0, lineCount: a },
      { hostId: "h2", hostName: "Calm", seatIndex: 1, lineCount: b },
    ];
    assert(castBalanceGateMessage(debate, seats(50, 50), 100) === null, "50/50 passes");
    assert(castBalanceGateMessage(debate, seats(80, 20), 100) === null, "80/20 passes (historical loosened floor)");
    assert(castBalanceGateMessage(debate, seats(85, 15), 100) !== null, "85/15 fails");
  });

  check("balance floors for solo and roundtable behave per format", () => {
    const solo = getShowFormat("solo_briefing")!;
    assert(castBalanceGateMessage(solo, [{ hostId: "h1", hostName: "Blaze", seatIndex: 0, lineCount: 40 }], 40) === null, "solo always balanced");
    const round = getShowFormat("roundtable")!;
    const seats = [
      { hostId: "h1", hostName: "Blaze", seatIndex: 0, lineCount: 10 },
      { hostId: "h2", hostName: "Calm", seatIndex: 1, lineCount: 45 },
      { hostId: "h3", hostName: "Mid", seatIndex: 2, lineCount: 45 },
    ];
    assert(castBalanceGateMessage(round, seats, 100) === null, "moderator at 10% passes (floor 8%)");
    seats[0].lineCount = 2; seats[1].lineCount = 49; seats[2].lineCount = 49;
    assert(castBalanceGateMessage(round, seats, 100) !== null, "vanished moderator fails");
  });

  check("CORE: validateScriptContent accepts a full cast and rejects outsiders (2 and 4 speakers)", () => {
    const cast2 = [{ id: "h1", name: "Blaze" }, { id: "h2", name: "Calm" }];
    const c2 = scriptContent(Array.from({ length: 40 }, (_, i) => ({ speaker: i % 2 ? "Calm" : "Blaze", hostId: i % 2 ? "h2" : "h1" })));
    const s2 = validateScriptContent(c2, { allowedSourceRefs: new Set(), cast: cast2, format: getShowFormat("two_host_debate"), unsafeClaims: [] });
    assert(s2.invalidSpeakerCount === 0 && s2.totalLineCount === 40, `2-speaker valid (${JSON.stringify(s2.reasons)})`);
    assert(s2.hostLineShare["Blaze"] === 50 && s2.hostLineShare["Calm"] === 50, "share keyed by name");

    const cast4 = H.map((h) => ({ id: h.id, name: h.name }));
    const c4 = scriptContent(Array.from({ length: 48 }, (_, i) => ({ speaker: H[i % 4].name, hostId: H[i % 4].id })));
    const s4 = validateScriptContent(c4, { allowedSourceRefs: new Set(), cast: cast4, format: getShowFormat("roundtable"), unsafeClaims: [] });
    assert(s4.invalidSpeakerCount === 0, `4-speaker valid (${JSON.stringify(s4.reasons)})`);
    assert(Object.keys(s4.hostLineShare).length === 4, "4 share keys");

    const bad = scriptContent([{ speaker: "Impostor" }, ...Array.from({ length: 39 }, (_, i) => ({ speaker: i % 2 ? "Calm" : "Blaze", hostId: i % 2 ? "h2" : "h1" }))]);
    const sBad = validateScriptContent(bad, { allowedSourceRefs: new Set(), cast: cast2, format: getShowFormat("two_host_debate"), unsafeClaims: [] });
    assert(sBad.invalidSpeakerCount === 1, "outsider speaker rejected");
    assert(sBad.reasons.some((r) => r.includes("'Blaze', 'Calm'")), "error names the full cast");
  });

  check("legacy hostA/hostB context still works (backward compatible)", () => {
    const c = scriptContent(Array.from({ length: 40 }, (_, i) => ({ speaker: i % 2 ? "Calm" : "Blaze", hostId: i % 2 ? "h2" : "h1" })));
    const s = validateScriptContent(c, {
      allowedSourceRefs: new Set(),
      hostA: { id: "h1", name: "Blaze" }, hostB: { id: "h2", name: "Calm" },
      unsafeClaims: [],
    });
    assert(s.invalidSpeakerCount === 0 && s.validationPassed, `legacy ctx works (${JSON.stringify(s.reasons)})`);
  });

  check("sanitizeScriptContent rebinds speakerHostId from the FULL cast", () => {
    const cast3 = H.slice(0, 3).map((h) => ({ id: h.id, name: h.name }));
    const c = scriptContent([
      { speaker: "Mid", hostId: "WRONG" },
      { speaker: "Blaze", hostId: "h1" },
    ]);
    const { sanitizedContent } = sanitizeScriptContent(c, { allowedSourceRefs: new Set(), cast: cast3 });
    assert(sanitizedContent.segments[0].lines[0].speakerHostId === "h3", "third speaker rebinds to its true host id");
  });

  check("solo validation: one voice, no split complaint", () => {
    const cast1 = [{ id: "h1", name: "Blaze" }];
    const c = scriptContent(Array.from({ length: 40 }, () => ({ speaker: "Blaze", hostId: "h1" })));
    const s = validateScriptContent(c, { allowedSourceRefs: new Set(), cast: cast1, format: getShowFormat("solo_briefing"), unsafeClaims: [] });
    assert(s.invalidSpeakerCount === 0, "all lines valid");
    assert(!s.reasons.some((r) => r.includes("unbalanced")), `no balance complaint for solo (${JSON.stringify(s.reasons)})`);
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}
main();
