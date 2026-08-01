import assert from "node:assert/strict";
import { compositeTopicScore, scoreEditorialStory } from "../lib/services/editorialStoryRanker";
import { alignDiarizedSpeakers, evaluateDiarizedTranscript, wordErrorRate } from "../lib/audio/audioSemanticQa";
import { resolveFishSceneModel } from "../lib/providers/tts/fishDialogue";

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

console.log("\nWorld-class learning contracts\n");

test("editorial scoring clamps model-proposed axes", () => {
  const report = scoreEditorialStory({ humanConsequence: 150, novelty: -20, evidenceRichness: "72" });
  assert.equal(report.axes.humanConsequence, 100);
  assert.equal(report.axes.novelty, 0);
  assert.equal(report.axes.evidenceRichness, 72);
});

test("a consequential unresolved story outranks a loud celebrity headline", () => {
  const consequential = scoreEditorialStory({ unresolvedUncertainty: 90, humanConsequence: 94, opposingInterpretations: 82, novelty: 72, revealPotential: 88, emotionalContradiction: 78, evidenceRichness: 91, positionChangePotential: 77 });
  const loud = scoreEditorialStory({ unresolvedUncertainty: 28, humanConsequence: 25, opposingInterpretations: 34, novelty: 52, revealPotential: 38, emotionalContradiction: 44, evidenceRichness: 40, positionChangePotential: 25 });
  assert.ok(compositeTopicScore({ editorial: consequential, recency: 70, controversy: 45, starPower: 10 }) > compositeTopicScore({ editorial: loud, recency: 100, controversy: 100, starPower: 100 }));
});

test("weak story axes produce explicit editorial hold reasons", () => {
  const report = scoreEditorialStory({ humanConsequence: 10, unresolvedUncertainty: 10, evidenceRichness: 10, opposingInterpretations: 10 });
  assert.equal(report.holdReasons.length, 4);
});

test("word-error rate detects substitutions and missing meaning", () => {
  assert.equal(wordErrorRate("leadership shifted blame", "leadership shifted blame"), 0);
  assert.ok(wordErrorRate("leadership shifted blame downward", "leadership praised the timeline") >= 0.5);
});

const expected = [
  { lineIndex: 0, speakerHostId: "host-a", speakerName: "A", text: "Who paid for that patience?", isInterruption: false },
  { lineIndex: 1, speakerHostId: "host-b", speakerName: "B", text: "The people who never controlled the decision.", isInterruption: false },
  { lineIndex: 2, speakerHostId: "host-a", speakerName: "A", text: "Then stop defending the timeline.", isInterruption: false },
  { lineIndex: 3, speakerHostId: "host-b", speakerName: "B", text: "I am telling you when the trap closed.", isInterruption: true },
];
const diarized = [
  { speaker: "speaker_1", text: expected[0].text, start: 0, end: 1.8 },
  { speaker: "speaker_0", text: expected[1].text, start: 1.9, end: 4.2 },
  { speaker: "speaker_1", text: expected[2].text, start: 4.3, end: 6.1 },
  { speaker: "speaker_0", text: expected[3].text, start: 6.16, end: 8.5 },
];

test("anonymous diarization labels map back to the correct hosts", () => {
  assert.deepEqual(alignDiarizedSpeakers(expected, diarized), { speaker_1: "host-a", speaker_0: "host-b" });
});

test("meaning-aware QA passes an exact transcript with an audible cut-in", () => {
  const report = evaluateDiarizedTranscript(expected, diarized, { provider: "fixture", model: "fixture" });
  assert.equal(report.status, "pass");
  assert.equal(report.wordErrorRate, 0);
  assert.equal(report.speakerAttributionErrorRate, 0);
  assert.equal(report.interruptionErrorRate, 0);
});

test("meaning-aware QA blocks altered critical content", () => {
  const altered = diarized.map((segment, index) => index === 1 ? { ...segment, text: "Nobody controlled anything." } : segment);
  const report = evaluateDiarizedTranscript(expected, altered);
  assert.equal(report.status, "fail");
  assert.ok(report.failures.some((failure) => failure.includes("word-error") || failure.includes("critical")));
});

test("Fish scenes preserve free by default and make Pro explicit", () => {
  const before = { model: process.env.FISH_MODEL, scene: process.env.FISH_SCENE_MODEL, tier: process.env.FISH_SCENE_MODEL_TIER };
  delete process.env.FISH_MODEL;
  delete process.env.FISH_SCENE_MODEL;
  delete process.env.FISH_SCENE_MODEL_TIER;
  assert.equal(resolveFishSceneModel(), "s2.1-pro-free");
  process.env.FISH_SCENE_MODEL_TIER = "pro";
  assert.equal(resolveFishSceneModel(), "s2.1-pro");
  process.env.FISH_SCENE_MODEL = "s2-pro";
  assert.equal(resolveFishSceneModel(), "s2-pro");
  for (const [key, value] of Object.entries({ FISH_MODEL: before.model, FISH_SCENE_MODEL: before.scene, FISH_SCENE_MODEL_TIER: before.tier })) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

console.log(`\nAll ${passed} world-class learning contracts passed.\n`);
