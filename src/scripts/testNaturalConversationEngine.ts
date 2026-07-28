import assert from "node:assert/strict";
import { compactCreativeSystemPrompt } from "../lib/services/scriptOutlineEngine";
import { scoreScriptQuality } from "../lib/services/episodeQualityService";

function line(
  speakerName: string,
  text: string,
  overrides: Partial<{
    tone: string;
    energy: string;
    pauseBefore: string;
    isInterruption: boolean;
    evidenceRefs: unknown[];
    isFactualClaim: boolean;
  }> = {}
) {
  return {
    speakerName,
    text,
    tone: overrides.tone ?? "analytical",
    energy: overrides.energy ?? "medium",
    pauseBefore: overrides.pauseBefore ?? "beat",
    isInterruption: overrides.isInterruption ?? false,
    evidenceRefs: overrides.evidenceRefs ?? [],
    isFactualClaim: overrides.isFactualClaim ?? false,
  };
}

const checklistScript = {
  segments: [
    {
      type: "cold_open",
      lines: [
        line("A", "Welcome to the show. Let's dive in.", { energy: "high" }),
        line("B", "Oh, come on.", { energy: "high", isInterruption: true }),
        line("A", "Here's the thing.", { energy: "high" }),
        line("B", "Wait, wait.", { energy: "high", isInterruption: true }),
        line("A", "At the end of the day, it is what it is.", { energy: "high" }),
        line("B", "Right, right.", { energy: "high", isInterruption: true }),
        line("A", "[laughs] The numbers speak for themselves.", { energy: "high" }),
        line("B", "[scoffs] Only time will tell.", { energy: "high" }),
      ],
    },
    {
      type: "topic",
      lines: [
        line("A", "Oh, come on.", { energy: "high", isInterruption: true }),
        line("B", "Here's the thing.", { energy: "high" }),
        line("A", "Wait, wait.", { energy: "high", isInterruption: true }),
        line("B", "It is what it is.", { energy: "high" }),
      ],
    },
    {
      type: "closing",
      lines: [line("A", "That's the show.", { energy: "high" })],
    },
  ],
};

const causalScript = {
  segments: [
    {
      type: "cold_open",
      lines: [
        line("A", "You keep calling that patience. How many empty seats does patience buy?", { tone: "incredulous", energy: "medium" }),
        line("B", "Enough to keep the owner from making the panicked trade you wanted Tuesday.", { tone: "dismissive" }),
        line("A", "Tuesday I wanted him to admit the season had changed. He still hasn't.", { tone: "heated", evidenceRefs: [{ type: "newsItem", id: "n1" }], isFactualClaim: true }),
        line("B", "No. You wanted the apology before you knew the diagnosis.", { tone: "analytical", energy: "low" }),
      ],
    },
    {
      type: "topic",
      lines: [
        line("A", "What diagnosis? The building is half asleep and the best player is looking at the bench after every whistle.", { tone: "heated" }),
        line("B", "The diagnosis is that nobody trusts the next move. Players feel that before fans do.", { tone: "reflective", energy: "low", pauseBefore: "breath" }),
        line("A", "So you do see it.", { tone: "setup", energy: "low" }),
        line("B", "I see fear. I don't see your solution.", { tone: "analytical" }),
        line("A", "Fine. The trade was panic. But standing still is starting to look like fear too.", { tone: "conceding", energy: "medium", pauseBefore: "breath" }),
        line("B", "That changes the question, then. Who in that building is still allowed to be wrong?", { tone: "reflective", energy: "low" }),
      ],
    },
    {
      type: "closing",
      lines: [
        line("A", "Tuesday I wanted an apology.", { tone: "reflective", energy: "low" }),
        line("B", "And now?", { tone: "setup", energy: "low" }),
        line("A", "Now I want somebody to make a decision before the empty seats make it for them.", { tone: "reflective", energy: "low", pauseBefore: "long" }),
      ],
    },
  ],
};

const checklist = scoreScriptQuality(checklistScript);
const causal = scoreScriptQuality(causalScript);

assert.ok(
  causal.axes.flow.score > checklist.axes.flow.score,
  `causal flow should win (${causal.axes.flow.score} <= ${checklist.axes.flow.score})`
);
assert.ok(
  causal.axes.arc.score > checklist.axes.arc.score,
  `story arc should win (${causal.axes.arc.score} <= ${checklist.axes.arc.score})`
);
assert.ok(
  causal.axes.delivery.score > checklist.axes.delivery.score,
  `restrained delivery should win (${causal.axes.delivery.score} <= ${checklist.axes.delivery.score})`
);
assert.ok(causal.total > checklist.total, `causal script should score higher (${causal.total} <= ${checklist.total})`);

const fullPrompt = `You are the head writer for Take Machine.

Host 1: Bernadette Zabala
- Worldview: the paying customer matters.

HOW REAL PODCAST SPEECH WORKS — follow all of these:
Aim for 4-8 real interruptions. Use plenty of reaction fragments.

GROUNDING RULES...

=== SHOW CONTINUITY (episode 4) ===
This show has a memory. Everything below is OPTIONAL.
AVAILABLE THIS EPISODE — THE RED EYE FILE (this topic genuinely touches it):`;

const compact = compactCreativeSystemPrompt(fullPrompt);
assert.match(compact, /Bernadette Zabala/);
assert.match(compact, /SHOW CONTINUITY/);
assert.match(compact, /THE RED EYE FILE/);
assert.doesNotMatch(compact, /Aim for 4-8 real interruptions/);
assert.doesNotMatch(compact, /Use plenty of reaction fragments/);
assert.match(compact, /Every turn must be caused by what was just said/);

console.log("Natural conversation regression tests passed.");
console.log(`Checklist score: ${checklist.total}/100`);
console.log(`Causal score: ${causal.total}/100`);
