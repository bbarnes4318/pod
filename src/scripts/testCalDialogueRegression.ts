// Dialogue regression: the recast has to be audible, not just structural.
//
// Everything else in this change can pass while the show still sounds the same.
// The seed can be right, the migration can be right, the continuity engine can
// be right, and the model can still write the previous seat-B character with a
// new name on him — a device that shouts, repeats a signature line, and exists
// to give the other host something to hit.
//
// So this file pins two SAMPLE EXCHANGES against the deterministic quality
// scorer that the natural-conversation engine (commit acd50f4) shipped with:
//
//   BAD  — Cal's name on the retired character's behavior. Gimmick, volume,
//          repeated catchphrase, portable reactions, no position ever moves.
//   GOOD — Cal and Zabala on an evidence-backed story, where the argument is
//          actually changed by something one of them says.
//
// The GOOD sample must beat the BAD one, and the per-axis assertions below say
// WHY it wins, so a future scorer change that flattens the difference fails
// here instead of silently accepting the gimmick again.
//
// Both samples are FICTIONAL. Every club, person, and figure in them is
// invented, which is the point: the character's history is composite and must
// never be attached to a real organization or a real player.

import { scoreScriptQuality } from "../lib/services/episodeQualityService";

let passed = 0;
let failed = 0;

function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ✗ ${name}\n      ${err instanceof Error ? err.message : String(err)}`);
    failed++;
  }
}
function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

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

const Z = "Zabala";
const C = "Cal";

// ---------------------------------------------------------------------------
// BAD: the retired character wearing the new name.
//
// Every failure the recast exists to remove, in one exchange: a running gimmick
// delivered on cue, a signature line repeated verbatim, everything at full
// volume, reactions that could be moved to any other episode without anyone
// noticing, and a second host whose only function is to set up the first.
// ---------------------------------------------------------------------------
const badSample = {
  segments: [
    {
      type: "cold_open",
      lines: [
        line(Z, "Twelve paragraphs about culture and not one about the roster.", { energy: "high", tone: "heated" }),
        line(C, "I WAS IN THAT BUILDING.", { energy: "high", tone: "excited", isInterruption: true }),
        line(Z, "Oh, come on.", { energy: "high", tone: "dismissive" }),
        line(C, "Here's the thing. I was IN that building.", { energy: "high", tone: "excited" }),
        line(Z, "Right, right.", { energy: "high", tone: "dismissive" }),
        line(C, "Forty feet from the bench! FORTY FEET!", { energy: "high", tone: "excited" }),
        line(Z, "Sure.", { energy: "high", tone: "dismissive" }),
        line(C, "At the end of the day, it is what it is.", { energy: "high", tone: "excited" }),
      ],
    },
    {
      type: "topic",
      lines: [
        line(C, "I WAS IN THAT BUILDING.", { energy: "high", tone: "excited" }),
        line(Z, "Oh, come on.", { energy: "high", tone: "dismissive", isInterruption: true }),
        line(C, "Here's the thing. Forty feet from the bench.", { energy: "high", tone: "excited" }),
        line(Z, "Right, right.", { energy: "high", tone: "dismissive", isInterruption: true }),
        line(C, "The numbers speak for themselves.", { energy: "high", tone: "excited" }),
        line(Z, "Sure.", { energy: "high", tone: "dismissive" }),
      ],
    },
    {
      type: "closing",
      lines: [line(C, "I WAS IN THAT BUILDING.", { energy: "high", tone: "excited" })],
    },
  ],
};

// ---------------------------------------------------------------------------
// GOOD: Cal and Zabala on an evidence-backed story.
//
// The shape the recast was for, beat by beat:
//   1. The first exchange leaves a question open ("who was it written for?").
//   2. Cal gives ONE short process insight, not a lecture and not an anecdote.
//   3. Zabala goes after the LANGUAGE he used, not his conclusion.
//   4. Cal rationalizes first — smoother and more explanatory, which is his tell.
//   5. Evidence lands and changes what the argument is about.
//   6. Zabala revises her position; Cal concedes without going passive.
//   7. The closing line answers the question the cold open asked.
//
// Nothing here is an insider claim: every factual line is evidence-backed, and
// Cal's one piece of process knowledge is about how a sentence gets written, not
// about what anyone actually said.
// ---------------------------------------------------------------------------
const goodSample = {
  segments: [
    {
      type: "cold_open",
      lines: [
        line(Z, "Twelve paragraphs, and not one of them says the word roster. Who was that statement written for?", {
          tone: "heated",
          energy: "medium",
          evidenceRefs: [{ type: "newsItem", id: "n1" }],
          isFactualClaim: true,
        }),
        line(C, "Not for you. And not for him.", { tone: "reflective", energy: "low" }),
        line(Z, "Then who?", { tone: "setup", energy: "medium" }),
        line(C, "The people who approved the roster.", { tone: "analytical", energy: "low", pauseBefore: "breath" }),
        line(Z, "So they wrote themselves out of their own sentence.", { tone: "incredulous", energy: "medium" }),
        line(C, "Out of the paragraph. It's a habit, and it's older than anyone in that building.", { tone: "dry", energy: "low" }),
      ],
    },
    {
      type: "topic",
      lines: [
        line(Z, "You keep saying they. You were they.", { tone: "heated", energy: "medium" }),
        line(C, "I was the hallway version of they.", { tone: "amused", energy: "low" }),
        line(Z, "Cute.", { tone: "dismissive", energy: "medium" }),
        line(C, "It isn't. They went four and nineteen after the deadline and the statement calls that a culture problem.", {
          tone: "analytical",
          energy: "medium",
          evidenceRefs: [{ type: "game", id: "g1" }],
          isFactualClaim: true,
        }),
        line(Z, "Which is the part you'd call a football decision.", { tone: "setup", energy: "medium" }),
        line(C, "It was a football decision.", { tone: "dismissive", energy: "low" }),
        line(Z, "There it is.", { tone: "amused", energy: "medium" }),
        line(C, "There what is?", { tone: "setup", energy: "low" }),
        line(Z, "You have a phrase for every place a person should be. Say who made it.", { tone: "heated", energy: "high" }),
        line(C, "I don't know who made it.", { tone: "reflective", energy: "low", pauseBefore: "long" }),
        line(C, "And that's a worse answer than the one I was about to give you, so I'll stop dressing it up.", {
          tone: "conceding",
          energy: "low",
          pauseBefore: "breath",
        }),
        line(Z, "Good. Because the two men named in those twelve paragraphs signed in February. Eleven weeks.", {
          tone: "heated",
          energy: "high",
          evidenceRefs: [{ type: "transaction", id: "t1" }],
          isFactualClaim: true,
        }),
        line(C, "Eleven weeks.", { tone: "reflective", energy: "low", pauseBefore: "long" }),
        line(Z, "Eleven weeks.", { tone: "heated", energy: "medium" }),
        line(C, "Then somebody picked the two men with the least possible time to have caused it. You pick those two on purpose.", {
          tone: "analytical",
          energy: "low",
        }),
        line(Z, "I came in here ready to call that front office stupid.", { tone: "conceding", energy: "medium", pauseBefore: "breath" }),
        line(C, "They're not stupid. They're afraid of the owner reading the second paragraph.", { tone: "dry", energy: "low" }),
        line(Z, "Fine. Then they knew exactly which two names cost them nothing.", { tone: "heated", energy: "medium" }),
        line(C, "You're right about the result. You're wrong about who paid for it.", { tone: "analytical", energy: "low" }),
        line(Z, "Then tell me who did.", { tone: "setup", energy: "medium" }),
        line(C, "Two men who will spend a career explaining eleven weeks in a job interview.", { tone: "reflective", energy: "low", pauseBefore: "breath" }),
      ],
    },
    {
      type: "closing",
      lines: [
        line(Z, "Twelve paragraphs.", { tone: "reflective", energy: "low" }),
        line(C, "Twelve paragraphs, and the only two names in them belong to men who had been there since February.", {
          tone: "reflective",
          energy: "low",
          evidenceRefs: [{ type: "newsItem", id: "n1" }],
          isFactualClaim: true,
        }),
        line(Z, "So who was it written for?", { tone: "setup", energy: "medium" }),
        line(C, "Whoever still wants to be in that building in March.", { tone: "reflective", energy: "low", pauseBefore: "long" }),
      ],
    },
  ],
};

const bad = scoreScriptQuality(badSample);
const good = scoreScriptQuality(goodSample);

console.log("Cal Mercer dialogue regression\n");

check("the GOOD sample outscores the renamed-gimmick sample overall", () => {
  assert(good.total > bad.total, `good ${good.total} must beat bad ${bad.total}`);
});

check("flow: the good sample's turns are caused by each other", () => {
  assert(
    good.axes.flow.score > bad.axes.flow.score,
    `flow ${good.axes.flow.score} vs ${bad.axes.flow.score} — ${good.axes.flow.detail} / ${bad.axes.flow.detail}`
  );
});

check("arc: the good sample opens a question, moves a position, and pays it off", () => {
  assert(
    good.axes.arc.score > bad.axes.arc.score,
    `arc ${good.axes.arc.score} vs ${bad.axes.arc.score} — ${good.axes.arc.detail}`
  );
  assert(/position shifts=[1-9]/.test(good.axes.arc.detail), `no position shift detected: ${good.axes.arc.detail}`);
  assert(/closing payoff echo=true/.test(good.axes.arc.detail), `the closing must pay off the opening: ${good.axes.arc.detail}`);
  assert(/opening tension=true/.test(good.axes.arc.detail), `the cold open must leave something unresolved: ${good.axes.arc.detail}`);
});

check("delivery: restraint beats shouting", () => {
  assert(
    good.axes.delivery.score > bad.axes.delivery.score,
    `delivery ${good.axes.delivery.score} vs ${bad.axes.delivery.score} — ${good.axes.delivery.detail} / ${bad.axes.delivery.detail}`
  );
});

check("repetition: the gimmick sample is penalised for its signature line", () => {
  assert(
    good.axes.repetition.score > bad.axes.repetition.score,
    `repetition ${good.axes.repetition.score} vs ${bad.axes.repetition.score} — ${bad.axes.repetition.detail}`
  );
});

// --- Character assertions the scorer cannot make ---------------------------
//
// The scorer measures shape. These measure whether it is Cal.

const goodLines = goodSample.segments.flatMap((s) => s.lines);
const calLines = goodLines.filter((l) => l.speakerName === C);

check("Cal never shouts, and his lowest energy carries his heaviest lines", () => {
  const high = calLines.filter((l) => l.energy === "high");
  assert(high.length === 0, `Cal has ${high.length} high-energy line(s): ${high.map((l) => l.text).join(" | ")}`);
  assert(!calLines.some((l) => /[A-Z]{4,}/.test(l.text)), "Cal is shouting in capitals somewhere");
  // The two moments that cost him most — the admission and the correction — are
  // his quietest. That is the character, expressed in the data the mixer reads.
  const admission = calLines.find((l) => l.text.startsWith("I don't know who made it"));
  assert(admission?.energy === "low", "his admission must be his quietest register, not his loudest");
});

check("Cal repeats no signature line", () => {
  const seen = new Map<string, number>();
  for (const l of calLines) {
    const key = l.text.toLowerCase().replace(/[^a-z ]/g, "").trim();
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  const repeated = [...seen.entries()].filter(([, n]) => n > 1).map(([k]) => k);
  assert(repeated.length === 0, `Cal repeats a line verbatim: ${repeated.join(" | ")}`);
});

check("Cal rationalizes BEFORE he concedes — the avoidance has to be visible", () => {
  const rationalizeAt = goodLines.findIndex((l) => l.speakerName === C && l.text === "It was a football decision.");
  const concedeAt = goodLines.findIndex((l) => l.speakerName === C && /I'll stop dressing it up/.test(l.text));
  assert(rationalizeAt >= 0, "Cal never reaches for the professional phrase, so there is nothing for her to catch");
  assert(concedeAt > rationalizeAt, "the correction must come AFTER the rationalization, or he is simply agreeable");
});

check("Zabala goes after his LANGUAGE, not only his conclusion", () => {
  const zLines = goodLines.filter((l) => l.speakerName === Z);
  assert(
    zLines.some((l) => /phrase|say who made it|keep saying/i.test(l.text)),
    "she must challenge the words he chose — that is the engine of the relationship"
  );
});

check("both hosts move: she revises, he concedes without going passive", () => {
  assert(
    goodLines.some((l) => l.speakerName === Z && /I came in here ready to/.test(l.text)),
    "Zabala must visibly change what she walked in believing"
  );
  assert(
    goodLines.some((l) => l.speakerName === C && /You're right about the result/.test(l.text)),
    "Cal must concede a point"
  );
  assert(
    goodLines.some((l) => l.speakerName === C && /You're wrong about who paid for it/.test(l.text)),
    "and must still be pushing his own argument in the same breath — a concession is not a surrender"
  );
});

check("no unsupported insider claim: every factual line carries evidence", () => {
  const unsupported = goodLines.filter((l) => l.isFactualClaim && l.evidenceRefs.length === 0);
  assert(unsupported.length === 0, `ungrounded factual claim(s): ${unsupported.map((l) => l.text).join(" | ")}`);
  // And nothing that asserts private knowledge about a real person.
  for (const l of calLines) {
    assert(
      !/\bmy sources?\b|\bi was told\b|\btrust me, i was there\b|\bi know for a fact\b/i.test(l.text),
      `Cal claims private knowledge: ${l.text}`
    );
  }
});

console.log(
  `\nScores — bad ${bad.total}/100 (flow ${bad.axes.flow.score}, arc ${bad.axes.arc.score}, delivery ${bad.axes.delivery.score}); ` +
    `good ${good.total}/100 (flow ${good.axes.flow.score}, arc ${good.axes.arc.score}, delivery ${good.axes.delivery.score})`
);
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
