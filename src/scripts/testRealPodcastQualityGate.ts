import assert from "node:assert/strict";
import { scoreConversationContinuity } from "../lib/services/scriptConversationDirector";
import { scoreSpokenPerformanceMetrics, type SpokenPerformanceQaMetrics } from "../lib/audio/spokenPerformanceQa";
import { resolveFishSceneModel } from "../lib/providers/tts/fishDialogue";
import { scoreScriptQuality } from "../lib/services/episodeQualityService";

const priorFishSceneModel = process.env.FISH_SCENE_MODEL;
const priorFishModel = process.env.FISH_MODEL;
process.env.FISH_SCENE_MODEL = "s2.1-pro-free";
assert.equal(resolveFishSceneModel(), "s2.1-pro-free");
process.env.FISH_SCENE_MODEL = "s2-pro";
assert.equal(resolveFishSceneModel(), "s2-pro");
process.env.FISH_SCENE_MODEL = "s1";
assert.throws(() => resolveFishSceneModel(), /S2-family/);
if (priorFishSceneModel === undefined) delete process.env.FISH_SCENE_MODEL;
else process.env.FISH_SCENE_MODEL = priorFishSceneModel;
if (priorFishModel === undefined) delete process.env.FISH_MODEL;
else process.env.FISH_MODEL = priorFishModel;

const disconnected = [
  {
    type: "topic",
    title: "Parallel monologues",
    lines: [
      { lineIndex: 0, speakerName: "A", text: "That coach lost the room the moment he blamed the players." },
      { lineIndex: 1, speakerName: "B", text: "The salary cap is going to reshape free agency next summer." },
      { lineIndex: 2, speakerName: "A", text: "Fans have every right to be furious about the fourth quarter." },
      { lineIndex: 3, speakerName: "B", text: "Young quarterbacks need more time to learn an offense." },
      { lineIndex: 4, speakerName: "A", text: "Ownership keeps hiding from the same decision." },
      { lineIndex: 5, speakerName: "B", text: "The draft class has three interesting receivers." },
    ],
  },
];

const connected = [
  {
    type: "topic",
    title: "One argument",
    lines: [
      { lineIndex: 0, speakerName: "A", text: "That coach lost the room the moment he blamed the players." },
      { lineIndex: 1, speakerName: "B", text: "No— you're skipping what the players did before he said it." },
      { lineIndex: 2, speakerName: "B", text: "They quit in the fourth quarter, and he finally said the quiet part out loud." },
      { lineIndex: 3, speakerName: "A", text: "You really think public humiliation fixes a team?" },
      { lineIndex: 4, speakerName: "B", text: "Fixes it? No. But your version lets every veteran walk away clean." },
      { lineIndex: 5, speakerName: "A", text: "Fine, the veterans own a piece. The coach still lit the match." },
      { lineIndex: 6, speakerName: "B", text: "There. That's the argument. He lit it after they poured the gasoline." },
    ],
  },
];

const disconnectedScore = scoreConversationContinuity(disconnected as any);
const connectedScore = scoreConversationContinuity(connected as any);
assert.ok(disconnectedScore.score < 78, `parallel monologues unexpectedly scored ${disconnectedScore.score}`);
assert.ok(disconnectedScore.disconnectedSwitches >= 4);
assert.ok(connectedScore.score >= 78, `connected exchange scored only ${connectedScore.score}`);
assert.ok(connectedScore.responsiveSwitchRatio >= 0.66);
assert.ok(connectedScore.sameSpeakerBuilds >= 1);

// Script scoring must distinguish an editorial miss from a catastrophic draft.
// The coherent exchange has no formal cold open/closing and should retain those
// warnings, but it must not trigger a full BullMQ regeneration.
const priorStrict = process.env.SCRIPT_QUALITY_GATE_STRICT;
const priorConversationGate = process.env.SCRIPT_CONVERSATION_GATE;
process.env.SCRIPT_QUALITY_GATE_STRICT = "true";
process.env.SCRIPT_CONVERSATION_GATE = "true";
const borderlineReport = scoreScriptQuality({ estimatedDurationMinutes: 1, segments: connected });
assert.equal(borderlineReport.gate.passed, true, borderlineReport.gate.failures.join("; "));
assert.ok(borderlineReport.gate.warnings.length > 0, "borderline draft should keep editorial warnings");
assert.throws(
  () => scoreScriptQuality({ estimatedDurationMinutes: 1, segments: disconnected }),
  /catastrophically bad draft/,
  "parallel monologues must still be blocked"
);
if (priorStrict === undefined) delete process.env.SCRIPT_QUALITY_GATE_STRICT;
else process.env.SCRIPT_QUALITY_GATE_STRICT = priorStrict;
if (priorConversationGate === undefined) delete process.env.SCRIPT_CONVERSATION_GATE;
else process.env.SCRIPT_CONVERSATION_GATE = priorConversationGate;

const flatMetrics: SpokenPerformanceQaMetrics = {
  durationSec: 48,
  integratedLufs: -16,
  loudnessRangeLu: 4.9,
  truePeakDb: -1.2,
  pauseCount: 8,
  medianPauseSec: 0.4,
  meanPauseSec: 0.4,
  pauseStdDevSec: 0.035,
  pauseCoefficientOfVariation: 0.0875,
  narrowPauseRatio: 1,
  longestPauseSec: 0.46,
  analyzedPhraseCount: 16,
  terminalFallRatio: 0.875,
  medianTerminalPitchChangeSemitones: -4.6,
  medianPhrasePitchRangeSemitones: 0.8,
  phraseEnergyCoefficientOfVariation: 0.12,
};

const aliveMetrics: SpokenPerformanceQaMetrics = {
  durationSec: 58,
  integratedLufs: -17,
  loudnessRangeLu: 5.2,
  truePeakDb: -1.4,
  pauseCount: 9,
  medianPauseSec: 0.34,
  meanPauseSec: 0.46,
  pauseStdDevSec: 0.24,
  pauseCoefficientOfVariation: 0.52,
  narrowPauseRatio: 0.44,
  longestPauseSec: 1.18,
  analyzedPhraseCount: 15,
  terminalFallRatio: 0.47,
  medianTerminalPitchChangeSemitones: -0.6,
  medianPhrasePitchRangeSemitones: 3.8,
  phraseEnergyCoefficientOfVariation: 0.36,
};

const flatQa = scoreSpokenPerformanceMetrics(flatMetrics, {
  expectedTurnCount: 10,
  sceneType: "argument_escalation",
  strict: true,
});
const aliveQa = scoreSpokenPerformanceMetrics(aliveMetrics, {
  expectedTurnCount: 10,
  sceneType: "argument_escalation",
  strict: true,
});
assert.equal(flatQa.passed, false, "flat/metronomic/read-aloud audio must be rejected");
assert.ok(flatQa.failures.some((failure) => /Metronome pacing|cluster|terminal cadence|Monotone phrase/.test(failure)));
assert.equal(aliveQa.passed, true, `alive performance was rejected: ${aliveQa.failures.join("; ")}`);
assert.ok(aliveQa.score >= 80);

console.log("Real podcast quality gate regression: PASS");
console.log({ disconnectedScore, connectedScore, borderlineReport, flatQa, aliveQa });
