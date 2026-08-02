// EXECUTED tests for meaning-aware audio QA.
//
// Two things are proven here:
//   1. The gate FAILS CLOSED in production and reports missing configuration by
//      variable NAME, never by value.
//   2. Numbers are compared by VALUE, not spelling. This came out of a real live
//      run: Deepgram's smart formatting returns "11"/"2012" where the script says
//      "eleven"/"two thousand twelve". Orthographic comparison scored those as
//      missing critical figures, which — with QA failing closed — would have
//      blocked every episode on a difference that does not exist.
//      Fixing that must NOT make the check permissive: a genuinely wrong number
//      or a dropped name still has to fail.

import assert from "node:assert/strict";
import {
  normalizeNumberWords,
  wordErrorRate,
  evaluateDiarizedTranscript,
  resolveSemanticQaRequirement,
  SEMANTIC_QA_PROVIDERS,
  type ExpectedSpokenLine,
  type DiarizedSegment,
} from "../lib/audio/audioSemanticQa";

let failed = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  FAIL ${name}\n       ${(err as Error).message}`);
  }
}

const w = (s: string) => s.toLowerCase().match(/[a-z0-9]+/g) || [];

console.log("\nSemantic audio QA\n");

console.log("  -- number normalization --");
check("spelled-out cardinals become digits", () => {
  assert.deepEqual(normalizeNumberWords(w("eleven pitchers")), ["11", "pitchers"]);
  assert.deepEqual(normalizeNumberWords(w("twelve pitches")), ["12", "pitches"]);
  assert.deepEqual(normalizeNumberWords(w("fifteen strikeouts")), ["15", "strikeouts"]);
});
check("compound numbers evaluate as one value", () => {
  assert.deepEqual(normalizeNumberWords(w("two thousand twelve")), ["2012"]);
  assert.deepEqual(normalizeNumberWords(w("twenty seven professional hitters")), ["27", "professional", "hitters"]);
});
check("non-numeric text is untouched", () => {
  assert.deepEqual(normalizeNumberWords(w("the league leaned on him")), ["the", "league", "leaned", "on", "him"]);
});

console.log("  -- word error rate --");
check("spelled-out vs digit transcription is NOT an error", () => {
  const wer = wordErrorRate("eleven pitchers combined for that shutout", "11 pitchers combined for that shutout");
  assert.equal(wer, 0, `expected 0 WER for a pure formatting difference, got ${wer}`);
});
check("a genuinely WRONG number is still an error", () => {
  const wer = wordErrorRate("eleven pitchers combined", "nine pitchers combined");
  assert.ok(wer > 0, "a different number must still count as an error");
});
check("a dropped word is still an error", () => {
  assert.ok(wordErrorRate("Dylan Cease started it", "Dylan started it") > 0);
});

console.log("  -- critical tokens on rendered audio --");
const expected: ExpectedSpokenLine[] = [
  { lineIndex: 0, speakerHostId: "a", speakerName: "A", text: "Eleven pitchers combined for that shutout. Dylan Cease started it and threw twelve pitches." },
  { lineIndex: 1, speakerHostId: "b", speakerName: "B", text: "Fifteen strikeouts in nine innings ties the record set back in two thousand twelve." },
];
const seg = (speaker: string, text: string): DiarizedSegment => ({ speaker, text, start: 0, end: 1 });

check("smart-formatted digits do not read as missing figures", () => {
  // This is the EXACT shape Deepgram returned on the live run.
  const r = evaluateDiarizedTranscript(expected, [
    seg("speaker_0", "11 pitchers combined for that shutout. Dylan Cease started it and threw 12 pitches."),
    seg("speaker_1", "15 strikeouts in nine innings ties the record set back in 2012."),
  ]);
  assert.ok((r.criticalTokenMissRate ?? 1) < 0.05, `formatting-only differences must not read as missing figures, got ${r.criticalTokenMissRate}`);
  assert.ok((r.wordErrorRate ?? 1) < 0.05, `WER should be near zero, got ${r.wordErrorRate}`);
  assert.equal(r.status, "pass", `a correct render must pass; failures=${r.failures.join(" | ")}`);
});

check("a MANGLED NAME still fails — the real live regression", () => {
  // Live Deepgram actually returned "Dylan Cee". That is a real defect and the
  // gate must not be talked out of it by the number fix.
  const r = evaluateDiarizedTranscript(expected, [
    seg("speaker_0", "11 pitchers combined for that shutout. Dylan Cee started it and threw 12 pitches."),
    seg("speaker_1", "15 strikeouts in nine innings ties the record set back in 2012."),
  ]);
  assert.equal(r.status, "fail", "a mangled proper name must fail");
  // The failure must NAME the word that went missing, so an operator can see
  // whether it is a real error or a pronunciation quirk to work around.
  assert.ok(
    r.failures.some((f) => /cease/i.test(f)),
    `the failure must name the mangled word, got ${r.failures.join(" | ")}`
  );
});

check("a WRONG figure still fails", () => {
  const r = evaluateDiarizedTranscript(expected, [
    seg("speaker_0", "9 pitchers combined for that shutout. Dylan Cease started it and threw 12 pitches."),
    seg("speaker_1", "15 strikeouts in nine innings ties the record set back in 2012."),
  ]);
  assert.equal(r.status, "fail", "a substituted number must fail");
});

console.log("  -- configuration --");
check("deepgram is a supported provider", () => {
  assert.ok((SEMANTIC_QA_PROVIDERS as readonly string[]).includes("deepgram"), "deepgram backend must be registered");
  assert.ok((SEMANTIC_QA_PROVIDERS as readonly string[]).includes("openai"));
});
check("production requires QA and names what is missing", () => {
  const r = resolveSemanticQaRequirement({ NODE_ENV: "production" } as NodeJS.ProcessEnv);
  assert.equal(r.required, true, "production must require semantic QA");
  assert.ok(r.missing.includes("TTS_TRANSCRIPT_QA_ENABLED"), `missing list should name the flag, got ${r.missing.join(", ")}`);
});
check("missing list contains NAMES only, never values", () => {
  const r = resolveSemanticQaRequirement({
    NODE_ENV: "production",
    TRANSCRIPT_QA_PROVIDER: "deepgram",
    DEEPGRAM_API_KEY: "SUPERSECRET_TOKEN_VALUE",
  } as unknown as NodeJS.ProcessEnv);
  assert.ok(!JSON.stringify(r).includes("SUPERSECRET_TOKEN_VALUE"), "a secret value must never appear in the requirement report");
});
check("deepgram credential absence is reported by name", () => {
  const r = resolveSemanticQaRequirement({
    NODE_ENV: "production",
    TTS_TRANSCRIPT_QA_ENABLED: "true",
    TRANSCRIPT_QA_PROVIDER: "deepgram",
  } as unknown as NodeJS.ProcessEnv);
  assert.ok(r.missing.some((m) => m.includes("DEEPGRAM_API_KEY")), `expected the deepgram key name, got ${r.missing.join(", ")}`);
});
check("an unsupported provider is reported, not silently accepted", () => {
  const r = resolveSemanticQaRequirement({
    NODE_ENV: "production",
    TTS_TRANSCRIPT_QA_ENABLED: "true",
    TRANSCRIPT_QA_PROVIDER: "whisper-local",
  } as unknown as NodeJS.ProcessEnv);
  assert.equal(r.providerSupported, false);
  assert.ok(r.missing.some((m) => m.includes("TRANSCRIPT_QA_PROVIDER")));
});
check("outside production a disabled gate is not required", () => {
  const r = resolveSemanticQaRequirement({ NODE_ENV: "test" } as NodeJS.ProcessEnv);
  assert.equal(r.required, false, "local/CI work must not be forced through a paid ASR");
});

if (failed) {
  console.error(`\n${failed} test(s) failed.`);
  process.exit(1);
}
console.log("\nAll semantic audio QA tests passed.\n");
