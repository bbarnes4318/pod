// The listener checks, asserted against the episode that motivated them.
//
// Fixture lines are lifted from the 2026-09-20 script a lifelong fan could not
// follow. If these checks ever stop flagging it, the checks are broken.

import { buildListenerCheckContext, findListenerIssues, META_VOCABULARY } from "../lib/services/scriptListenerChecks";
import { buildRundownSkeleton, topicsFromPrompt } from "../lib/services/scriptOutlineEngine";
import { BEAT_TURN_CAPS, makeTurnPlanValidator } from "../lib/services/scriptCreativePipeline";

let passed = 0;
let failed = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${name}\n      ${(e as Error).message}`);
  }
}
function assert(c: boolean, m: string) {
  if (!c) throw new Error(m);
}

const ctx = buildListenerCheckContext([
  { id: "rays", text: "Junior Caminero hits 40th home run as Rays clinch; Tampa Bay Rays; Houston Astros; Eddie Mathews; Aaron Judge" },
  { id: "royals", text: "Jac Caglianone returns to Royals lineup, apologizes for punching wall; J.J. Picollo; Matt Quatraro; Kansas City Royals; George Brett" },
]);

const V = "Marisol Vandergrift";
const F = "Ambrose Fettig";
let n = 0;
const line = (speakerName: string, text: string) => ({ lineIndex: n++, speakerName, text });

console.log("\nListener checks against the unfollowable episode\n");

check("the cold open that never names the team or player is flagged for orientation", () => {
  n = 0;
  const issues = findListenerIssues(
    [
      {
        type: "cold_open",
        lines: [
          line(F, "Somebody in that building wrote a sentence this week, and I want the name off it. The story going around is that a bench guy nobody's heard of walked off the clinch."),
          line(V, "Then check it with me. September eleventh. Two-run shot, three to one over Houston."),
        ],
      },
    ],
    ctx
  );
  assert(issues.some((i) => i.kind === "orientation" && i.lineIndex === 0), `expected an orientation issue on line 0, got ${JSON.stringify(issues)}`);
});

check("a topic segment that calls the player 'the kid' for its first two lines is flagged", () => {
  n = 0;
  const issues = findListenerIssues(
    [
      {
        type: "topic",
        topicId: "royals",
        lines: [
          line(F, "That club wrote down what was wrong with a kid's temper, filed it, and then sat there for a year."),
          line(F, "Then the hand goes through the wall, and suddenly there's a consequence and a podium the very next afternoon."),
          line(V, "In twenty twenty-five Picollo said they had to keep an eye on the kid's attitude."),
        ],
      },
    ],
    ctx
  );
  assert(issues.some((i) => i.kind === "orientation"), `expected orientation issue, got ${JSON.stringify(issues)}`);
});

check("a topic segment that sets the table passes orientation", () => {
  n = 0;
  const issues = findListenerIssues(
    [
      {
        type: "topic",
        topicId: "royals",
        lines: [
          line(V, "Kansas City. The Royals sat rookie first baseman Jac Caglianone for one game Friday after he punched a wall in the dugout in Houston."),
          line(F, "One game. For a wall."),
        ],
      },
    ],
    ctx
  );
  assert(!issues.some((i) => i.kind === "orientation"), `expected no orientation issue, got ${JSON.stringify(issues)}`);
});

check("a phrase said nine times is flagged from its third use on", () => {
  n = 0;
  const lines = Array.from({ length: 9 }, (_, i) =>
    line(i % 2 ? V : F, `Picollo said they had to keep an eye on the kid's attitude, and that was ${i} months ago.`)
  );
  const issues = findListenerIssues([{ type: "topic", topicId: "royals", lines }], ctx).filter((i) => i.kind === "recycled_phrase");
  assert(issues.length === 7, `expected 7 recycled-phrase issues (uses 3-9), got ${issues.length}`);
  assert(issues[0].lineIndex === 2, `first flagged use should be line 2, got ${issues[0].lineIndex}`);
});

check("the second front-office abstraction of the episode is flagged; the first is not", () => {
  n = 0;
  const issues = findListenerIssues(
    [
      {
        type: "topic",
        topicId: "royals",
        lines: [
          line(V, "Kansas City Royals first baseman Jac Caglianone punched a wall and sat one game."),
          line(F, "Somebody in that building decided one game was the price."),
          line(V, "And nobody will say who signed off on it."),
          line(F, "The file on him is a year old."),
        ],
      },
    ],
    ctx
  ).filter((i) => i.kind === "meta_vocabulary");
  assert(issues.length === 2, `expected 2 meta issues (lines 2 and 3), got ${JSON.stringify(issues)}`);
  assert(issues[0].lineIndex === 2, `first flagged should be line 2, got ${issues[0].lineIndex}`);
});

check("every meta-vocabulary pattern matches its own example", () => {
  const examples = [
    "that building", "the file", "the page", "the desk", "the receipt", "the paperwork",
    "who signed", "signed off on it", "wrote that sentence", "the story going around",
  ];
  for (const ex of examples) {
    assert(META_VOCABULARY.some((re) => re.test(ex)), `no pattern matches "${ex}"`);
  }
});

console.log("\nThe rundown skeleton\n");

check("two topics build cold_open, intro, topic, transition, topic, closing — in code, not by the model", () => {
  const beats = buildRundownSkeleton([{ id: "a", title: "A" }, { id: "b", title: "B" }]);
  assert(
    beats.map((b) => b.segmentType).join(",") === "cold_open,intro,topic,transition,topic,closing",
    `got ${beats.map((b) => b.segmentType).join(",")}`
  );
  assert(beats.every((b, i) => b.beatIndex === i), "beatIndex must be positional");
  assert(beats[2].topicId === "a" && beats[4].topicId === "b" && beats[3].topicId === "b", "topic binding wrong");
});

check("topics are recovered from a legacy topics prompt", () => {
  const topics = topicsFromPrompt("\nTopic #1: Rays clinch\nSport/League: MLB\n---\nTopic #2: Royals bench Caglianone\n");
  assert(topics.length === 2 && topics[1].title === "Royals bench Caglianone", JSON.stringify(topics));
});

console.log("\nThe turn plan enforces the rundown\n");

const beats = buildRundownSkeleton([{ id: "a", title: "A" }, { id: "b", title: "B" }]).map((b) => ({ beatIndex: b.beatIndex, segmentType: b.segmentType }));
const turn = (beatIndex: number, speakerName: string, intent: string) => ({ beatIndex, speakerName, intent, factRefs: [], targetWords: 40 });
function goodPlan() {
  const t: ReturnType<typeof turn>[] = [];
  for (let i = 0; i < 4; i++) t.push(turn(1, i % 2 ? F : V, i === 0 ? "welcome the listener and tease both stories" : "tease a story"));
  t.push(turn(2, V, "set the table: Rays, Junior Caminero's fortieth home run"));
  for (let i = 0; i < 12; i++) t.push(turn(2, i % 3 === 0 ? F : V, i === 5 ? "concede the timing point" : "press the point"));
  t.push(turn(3, F, "hand off to Kansas City"));
  t.push(turn(4, F, "set the table: Royals, Jac Caglianone benched one game"));
  for (let i = 0; i < 12; i++) t.push(turn(4, i % 3 === 0 ? V : F, "press the point"));
  for (let i = 0; i < 4; i++) t.push(turn(5, i % 2 ? F : V, i === 3 ? "sign off" : "one-sentence verdict"));
  return t;
}

check("a plan that honours the rundown validates", () => {
  const v = makeTurnPlanValidator(200, { beats, rhythmAttempts: 0 });
  const err = v({ turns: goodPlan() });
  assert(err === null, `expected null, got: ${err}`);
});

check("a 38-turn closing is refused", () => {
  const plan = goodPlan();
  for (let i = 0; i < 34; i++) plan.push(turn(5, i % 3 === 0 ? V : F, "keep arguing"));
  const err = makeTurnPlanValidator(200, { beats, rhythmAttempts: 0 })({ turns: plan });
  assert(!!err && /closing/.test(err) && new RegExp(`${BEAT_TURN_CAPS.closing.min}-${BEAT_TURN_CAPS.closing.max}`).test(err), `expected a closing cap error, got: ${err}`);
});

check("a topic beat whose first turn does not set the table is refused", () => {
  const plan = goodPlan();
  plan.find((t) => t.beatIndex === 4 && /^set the table/.test(t.intent))!.intent = "accuse her of protecting the room";
  const err = makeTurnPlanValidator(200, { beats, rhythmAttempts: 0 })({ turns: plan });
  assert(!!err && /set the table/.test(err), `expected a set-the-table error, got: ${err}`);
});

check("a plan with no intro turns is refused", () => {
  const plan = goodPlan().filter((t) => t.beatIndex !== 1);
  const err = makeTurnPlanValidator(200, { beats, rhythmAttempts: 0 })({ turns: plan });
  assert(!!err && /intro/.test(err), `expected an intro error, got: ${err}`);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
