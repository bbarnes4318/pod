// Continuity engine contracts.
//
// The engine's whole premise changed with the seat-B recast: it used to REQUIRE
// a fixed set of comedy devices every episode, and now it OFFERS at most one
// optional device that the topic has to earn. The first section below pins that
// premise, because it is the property a well-meaning future edit is most likely
// to undo one guard at a time.
//
// The rolling-window rate limit is the piece most likely to be subtly wrong —
// off-by-one at the window edge gives either a device that fires twice in a row
// or one that never fires again — so its boundaries are pinned exactly.

import {
  EMPTY_CONTINUITY,
  RATE_LIMITS,
  RED_EYE_LADDER_END,
  RED_EYE_LAYERS,
  continuityOpportunities,
  describeRelationship,
  normalizeTopicKey,
  rateLimitAllows,
  rateLimitCooldown,
  readLedger,
  readPositions,
  redEyeTopicEligible,
  topicOverlap,
  type ContinuityState,
} from "../lib/services/showContinuity";
import { readFileSync } from "node:fs";
import { reportContinuityClaim } from "../lib/services/continuityReport";
import { join } from "node:path";
import {
  checkContinuity,
  composeGenerationSystemPrompt,
  continuityUpdateSchema,
  findRepeatedDisclosure,
  nextContinuityState,
  renderContinuityBlock,
  type ContinuityUpdate,
} from "../lib/services/showContinuityService";

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
async function checkAsync(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ✗ ${name}
      ${err instanceof Error ? err.message : String(err)}`);
    failed++;
  }
}

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const state = (over: Partial<ContinuityState> = {}): ContinuityState => ({ ...EMPTY_CONTINUITY, ...over });
const update = (over: Partial<ContinuityUpdate> = {}): ContinuityUpdate =>
  continuityUpdateSchema.parse({ ...over });

/** Topic material that genuinely touches the Red Eye themes. */
const SCAPEGOAT_TOPIC =
  "The Riverton front office fired its head coach and the statement blamed a locker-room culture problem. " +
  "Two anonymous sources described the player as a distraction.";
/** Topic material that does not. */
const NEUTRAL_TOPIC =
  "A backup goalkeeper made eleven saves in a shootout win and the team clinched a playoff spot on goal difference.";

console.log("Continuity engine\n");

// --- NOTHING IS MANDATORY ---------------------------------------------------
//
// The single most important property of this engine, and the one the previous
// version got wrong. Four assertions, because "no required device" can be
// undone in four independent places: the guards, the schema, the prompt, and
// the device selector.

check("an episode that used NO continuity device produces zero violations", () => {
  const v = checkContinuity(state({ episodeCount: 12 }), update(), { topicText: NEUTRAL_TOPIC });
  assert(v.length === 0, `an all-negative claim must be legal, got ${JSON.stringify(v)}`);
});

check("the schema's ALL-DEFAULT claim is valid — nothing has to be reported", () => {
  const parsed = continuityUpdateSchema.safeParse({});
  assert(parsed.success, `an empty report must parse: ${JSON.stringify(parsed.error?.issues)}`);
  assert(parsed.data!.redEyeLayerDelivered === false, "no beat by default");
  assert(parsed.data!.languageUsed.length === 0, "no phrases by default");
  assert(parsed.data!.positionsTaken.length === 0, "no positions by default");
});

check("the prompt never uses requirement language for a device", () => {
  // Sampled across the four selector outcomes, because the block differs per branch.
  const blocks = [
    renderContinuityBlock(continuityOpportunities(state(), { topicText: SCAPEGOAT_TOPIC })),
    renderContinuityBlock(continuityOpportunities(state(), { topicText: NEUTRAL_TOPIC })),
    renderContinuityBlock(
      continuityOpportunities(
        state({ episodeCount: 4, languageLedger: [{ phrase: "culture fit", episodeIndex: 1, context: "a coach fired over locker-room culture", status: "used" }] }),
        { topicText: SCAPEGOAT_TOPIC }
      )
    ),
  ];
  for (const block of blocks) {
    assert(!/REQUIRED THIS EPISODE/i.test(block), "the prompt must not require a device");
    assert(!/\bmandatory\b/i.test(block), `the prompt must not call anything mandatory:\n${block}`);
    assert(/OPTIONAL/i.test(block), "the prompt must say the devices are optional");
  }
});

check("a topic with nothing to earn is told, in words, to use nothing", () => {
  const opps = continuityOpportunities(state({ episodeCount: 6 }), { topicText: NEUTRAL_TOPIC });
  assert(opps.featured === "none", `nothing should be featured, got ${opps.featured}`);
  const block = renderContinuityBlock(opps);
  assert(/NOTHING FROM THE SEASON IS DUE THIS EPISODE/.test(block), "the prompt must say so plainly");
  assert(/Do not manufacture a continuity moment/.test(block), "and must forbid filling the gap");
});

check("AT MOST ONE device is ever featured", () => {
  // Everything available at once: eligible topic, a relevant ledger phrase, a
  // relevant prior position. Exactly one may carry weight.
  const s = state({
    episodeCount: 9,
    languageLedger: [{ phrase: "culture fit", episodeIndex: 2, context: "a coach fired over locker-room culture", status: "used" }],
    positionMemory: [{ host: "zabala", episodeIndex: 3, topicKey: normalizeTopicKey(SCAPEGOAT_TOPIC), position: "The front office fired the wrong person and said the quiet part in the statement." }],
  });
  const opps = continuityOpportunities(s, { topicText: SCAPEGOAT_TOPIC });
  assert(opps.featured === "redEye", `the heaviest available device should be featured, got ${opps.featured}`);
  const block = renderContinuityBlock(opps);
  const availableHeadings = block.match(/^AVAILABLE THIS EPISODE/gm) ?? [];
  assert(availableHeadings.length === 1, `exactly one device may be offered, found ${availableHeadings.length}`);
});

// --- THE RED EYE FILE IS TOPIC-GATED ---------------------------------------

check("topic gate: institutional-blame material is eligible, a scoreline is not", () => {
  assert(redEyeTopicEligible(SCAPEGOAT_TOPIC), "a firing framed as a culture problem must be eligible");
  assert(!redEyeTopicEligible(NEUTRAL_TOPIC), "a shootout win must not be eligible");
  assert(!redEyeTopicEligible(""), "no topic text means not eligible, never a default yes");
  assert(!redEyeTopicEligible(null), "null must not be eligible");
});

check("a Red Eye layer is INELIGIBLE when the topic is unrelated, and the prompt says why", () => {
  const opps = continuityOpportunities(state({ episodeCount: 5 }), { topicText: NEUTRAL_TOPIC });
  assert(!opps.redEye.eligible, "an unrelated topic must not offer a layer");
  assert(opps.redEye.blockedBy === "topic", `blockedBy should be 'topic', got ${opps.redEye.blockedBy}`);
  const block = renderContinuityBlock(opps);
  assert(/THE RED EYE FILE IS NOT AVAILABLE/.test(block), "the prompt must say the file is closed this episode");
  assert(/not about scapegoating/.test(block), "and must say why");
  // And the layer text itself must be ABSENT — a layer the model can read is a
  // layer the model can deliver.
  assert(!block.includes(RED_EYE_LAYERS[0]), "an ineligible layer's text must not appear in the prompt at all");
});

check("guard: a layer delivered on an unrelated topic is rejected", () => {
  const v = checkContinuity(
    state({ episodeCount: 5 }),
    update({ redEyeLayerDelivered: true, redEyeDisclosure: "He admits he was in the room when the sentence was written." }),
    { topicText: NEUTRAL_TOPIC }
  );
  assert(v.some((x) => x.rule === "redEye:not-eligible"), `expected a not-eligible violation, got ${JSON.stringify(v)}`);
});

check("guard: the SAME confession cannot be delivered twice", () => {
  const prior = "He admits he helped write the clause that made the failure about the player's attitude.";
  const s = state({ episodeCount: 8, redEyeStage: 4, redEyeDisclosures: [prior] });
  // Reworded, same admission.
  const v = checkContinuity(
    s,
    update({ redEyeLayerDelivered: true, redEyeDisclosure: "He admits that he helped write the clause making the failure about that player's attitude." }),
    { topicText: SCAPEGOAT_TOPIC }
  );
  assert(v.some((x) => x.rule === "redEye:repeat"), `a re-worded repeat must be caught, got ${JSON.stringify(v)}`);
  // A genuinely new layer on the same subject must NOT be caught.
  const fresh = checkContinuity(
    s,
    update({ redEyeLayerDelivered: true, redEyeDisclosure: "He says he never once checked what happened to the man afterward." }),
    { topicText: SCAPEGOAT_TOPIC }
  );
  assert(!fresh.some((x) => x.rule === "redEye:repeat"), `a new admission must pass, got ${JSON.stringify(fresh)}`);
});

check("repeat detection is conservative — shared vocabulary alone is not a repeat", () => {
  const est = ["He admits the decision that failed was the building's, not the player's."];
  assert(
    findRepeatedDisclosure(est, "He admits he was relieved when the story worked.") === null,
    "a different admission must not be flagged"
  );
  assert(
    findRepeatedDisclosure(est, "He admits the decision that failed was really the building's and never the player's.") !== null,
    "a close reword of the same admission must be flagged"
  );
});

// KNOWN LIMITATION, pinned deliberately. findRepeatedDisclosure is a LEXICAL
// check with a HIGH bar (0.7 content-token overlap), because the two error
// directions are not symmetric: a missed near-repeat costs one dull episode,
// while a false positive rejects a legitimate new layer and stalls the arc. So
// a heavily-reworded restatement gets through this function.
//
// It is not the only defense, which is why the bar can afford to be high: the
// prompt lists every prior disclosure verbatim under "never confess any of
// these again, in any wording", so the primary prevention is upstream and this
// is the backstop. The gap is pinned here so it is documented rather than
// discovered in an episode.
check("KNOWN GAP: a heavily-reworded restatement is NOT caught lexically", () => {
  const est = ["He admits the decision that failed was the building's, not the player's."];
  assert(
    findRepeatedDisclosure(est, "He concedes the organisation, and nobody wearing a uniform, owned the choice that went wrong.") === null,
    "if this now returns a hit the detector gained semantic reach — good, but update this test and its comment deliberately"
  );
  // And the upstream prevention must actually be in the prompt.
  const opps = continuityOpportunities(state({ episodeCount: 8, redEyeStage: 2, redEyeFirings: [], redEyeDisclosures: est }), { topicText: SCAPEGOAT_TOPIC });
  const block = renderContinuityBlock(opps);
  assert(block.includes(est[0]), "every prior confession must be quoted to the model verbatim");
  assert(/never confess any of these again, in any wording/.test(block), "and the instruction must be explicit about rewording");
});

check("guard: a delivered layer with nothing new admitted is rejected", () => {
  const v = checkContinuity(state(), update({ redEyeLayerDelivered: true }), { topicText: SCAPEGOAT_TOPIC });
  assert(v.some((x) => x.rule === "redEye:missing-disclosure"), "a layer must actually reveal something");
});

check("guard: an admission reported without a delivered layer cannot advance state", () => {
  const v = checkContinuity(state(), update({ redEyeDisclosure: "Something he supposedly admitted." }), { topicText: SCAPEGOAT_TOPIC });
  assert(v.some((x) => x.rule === "redEye:disclosure-without-beat"), "state must not advance on a confession that did not happen");
});

check("ladder: advances by at most one layer and clamps at the authored end", () => {
  const s = state({ redEyeStage: 2 });
  assert(nextContinuityState(s, update({ redEyeLayerDelivered: true, redEyeDisclosure: "A new thing." })).redEyeStage === 3, "one layer per episode");
  assert(nextContinuityState(s, update()).redEyeStage === 2, "no advance without delivery");
  const end = state({ redEyeStage: RED_EYE_LADDER_END + 1 });
  assert(
    nextContinuityState(end, update({ redEyeLayerDelivered: true, redEyeDisclosure: "x".repeat(20) })).redEyeStage === RED_EYE_LADDER_END + 1,
    "an exhausted ladder never advances further"
  );
});

check("ladder: an exhausted file is reported, and inventing a new layer is rejected", () => {
  const spent = state({ episodeCount: 30, redEyeStage: RED_EYE_LADDER_END + 1 });
  const opps = continuityOpportunities(spent, { topicText: SCAPEGOAT_TOPIC });
  assert(opps.redEyeExhausted, "an exhausted file must be surfaced");
  assert(!opps.redEye.eligible && opps.redEye.blockedBy === "exhausted", "no layer is available once spent");
  const v = checkContinuity(spent, update({ redEyeLayerDelivered: true, redEyeDisclosure: "An invented eighth layer." }), { topicText: SCAPEGOAT_TOPIC });
  assert(v.some((x) => x.rule === "redEye:exhausted"), "delivering a layer past the authored end must be rejected");
  const block = renderContinuityBlock(opps);
  assert(/the file is closed and nothing new about it may be invented/.test(block), "the prompt must forbid inventing a layer");
});

// --- RATE LIMITS: rolling window, no season boundary ------------------------

check("rate limit: a fresh show may fire", () => {
  assert(rateLimitAllows(state(), "redEyeLayer"), "should be allowed at episode 0");
  assert(rateLimitCooldown(state(), "redEyeLayer") === 0, "no cooldown when allowed");
});

check("rate limit: the window EDGE is exact (no off-by-one)", () => {
  const { window } = RATE_LIMITS.redEyeLayer;
  assert(window === 4, "test assumes a 4-episode window");
  // Fired at 0. At episode 4 it has just dropped out (0 > 4-4 is false).
  assert(rateLimitAllows(state({ episodeCount: 4, redEyeFirings: [0] }), "redEyeLayer"), "a firing exactly `window` episodes ago must have expired");
  const at3 = state({ episodeCount: 3, redEyeFirings: [0] });
  assert(!rateLimitAllows(at3, "redEyeLayer"), "at window-1 the firing still counts");
  assert(rateLimitCooldown(at3, "redEyeLayer") === 1, `expected 1 episode of cooldown, got ${rateLimitCooldown(at3, "redEyeLayer")}`);
});

check("rate limit: an ancient firing never blocks (no accumulation over a long run)", () => {
  const s = state({ episodeCount: 500, redEyeFirings: [1, 40, 90, 200, 350] });
  assert(rateLimitAllows(s, "redEyeLayer"), "firings outside the window must not accumulate");
});

check("guard: a layer on cooldown is rejected even on a perfect topic", () => {
  const s = state({ episodeCount: 2, redEyeFirings: [1] });
  const v = checkContinuity(s, update({ redEyeLayerDelivered: true, redEyeDisclosure: "A new admission entirely." }), { topicText: SCAPEGOAT_TOPIC });
  assert(v.some((x) => x.rule === "redEye:cooldown"), `expected a cooldown violation, got ${JSON.stringify(v)}`);
});

// --- THE LANGUAGE LEDGER ----------------------------------------------------

check("ledger: a phrase used is recorded, and a later resolution rewrites its status", () => {
  const after = nextContinuityState(
    state({ episodeCount: 3 }),
    update({ languageUsed: [{ phrase: "culture fit", context: "a coach fired over the locker room" }] })
  );
  const rows = readLedger(after.languageLedger);
  assert(rows.length === 1 && rows[0].status === "used", `expected one 'used' row, got ${JSON.stringify(rows)}`);
  assert(rows[0].episodeIndex === 3, "the entry must be stamped with the episode it was said in");

  const later = nextContinuityState(after, update({ languageResolved: [{ phrase: "culture fit", resolution: "rejected" }] }));
  const rows2 = readLedger(later.languageLedger);
  assert(rows2[0].status === "rejected", `a resolution must rewrite the entry, got ${rows2[0].status}`);
});

check("guard: Zabala cannot recall a phrase Cal never said", () => {
  const v = checkContinuity(state(), update({ languageRecalled: "everybody signed off" }), { topicText: SCAPEGOAT_TOPIC });
  assert(v.some((x) => x.rule === "language:unknown-recall"), "a fabricated ledger recall must be rejected");
});

check("guard: a recall of a real phrase passes, and respects its cooldown", () => {
  const s = state({
    episodeCount: 6,
    languageLedger: [{ phrase: "culture fit", episodeIndex: 1, context: "a coach fired over the locker room", status: "used" }],
  });
  assert(checkContinuity(s, update({ languageRecalled: "culture fit" }), { topicText: SCAPEGOAT_TOPIC }).length === 0, "a real recall must pass");
  const hot = { ...s, languageRecallFirings: [5] };
  assert(
    checkContinuity(hot, update({ languageRecalled: "culture fit" }), { topicText: SCAPEGOAT_TOPIC }).some((x) => x.rule === "language:cooldown"),
    "recall must respect its rolling window"
  );
});

// --- POSITION MEMORY --------------------------------------------------------

const PRIOR_POSITION = "The front office fired the coach to avoid admitting the roster was the problem.";

check("positions may be recalled ONLY when the current topic genuinely relates", () => {
  const s = state({
    episodeCount: 7,
    positionMemory: [{ host: "zabala", episodeIndex: 2, topicKey: normalizeTopicKey(SCAPEGOAT_TOPIC), position: PRIOR_POSITION }],
  });
  const related = continuityOpportunities(s, { topicText: SCAPEGOAT_TOPIC });
  assert(related.positions.relevant.length === 1, "a related topic must surface the prior position");
  const unrelated = continuityOpportunities(s, { topicText: NEUTRAL_TOPIC });
  assert(unrelated.positions.relevant.length === 0, "an unrelated topic must surface nothing");
  assert(unrelated.featured === "none", "and must feature nothing");
  assert(!renderContinuityBlock(unrelated).includes(PRIOR_POSITION), "an irrelevant position's text must not reach the prompt");
});

check("guard: a callback on an unrelated topic is rejected", () => {
  const s = state({
    episodeCount: 7,
    positionMemory: [{ host: "zabala", episodeIndex: 2, topicKey: normalizeTopicKey(SCAPEGOAT_TOPIC), position: PRIOR_POSITION }],
  });
  const v = checkContinuity(s, update({ positionRecalled: { host: "zabala", position: PRIOR_POSITION } }), { topicText: NEUTRAL_TOPIC });
  assert(v.some((x) => x.rule === "position:irrelevant-callback"), `expected an irrelevance violation, got ${JSON.stringify(v)}`);
  const ok = checkContinuity(s, update({ positionRecalled: { host: "zabala", position: PRIOR_POSITION } }), { topicText: SCAPEGOAT_TOPIC });
  assert(ok.length === 0, `a relevant callback must pass, got ${JSON.stringify(ok)}`);
});

check("guard: a position nobody ever took cannot be recalled", () => {
  const v = checkContinuity(state(), update({ positionRecalled: { host: "cal", position: "He said the trade was always going to happen." } }), {
    topicText: SCAPEGOAT_TOPIC,
  });
  assert(v.some((x) => x.rule === "position:unknown-recall"), "a fabricated season must be rejected");
});

check("topicOverlap is directional and bounded", () => {
  const key = normalizeTopicKey("head coach fired locker room culture statement");
  assert(topicOverlap(key, SCAPEGOAT_TOPIC) > 0.3, "genuinely-related material must score above the threshold");
  assert(topicOverlap(key, NEUTRAL_TOPIC) < 0.2, "unrelated material must score near zero");
  assert(topicOverlap("", NEUTRAL_TOPIC) === 0, "an empty key is never relevant");
});

// --- RELATIONSHIP STATE -----------------------------------------------------

check("relationship: trust is clamped and counters accumulate", () => {
  let s = state({ trustLevel: 4 });
  s = nextContinuityState(s, update({ relationship: { trustDelta: 2, calDisclosed: true, calRationalized: false, zabalaOverreached: false, positionChangedBy: "cal", openThread: "She never answered whether she would have run the story." } }));
  assert(s.trustLevel === 5, `trust must clamp at 5, got ${s.trustLevel}`);
  assert(s.calDisclosureCount === 1 && s.positionChangeCount === 1, "counters must accumulate");
  assert(s.openThread !== null, "an open thread must persist");
  // Silence does not close a thread.
  const next = nextContinuityState(s, update());
  assert(next.openThread === s.openThread, "an unmentioned thread must survive, not evaporate");
});

check("relationship state NEVER reaches the prompt as a number", () => {
  const s = state({ episodeCount: 20, trustLevel: -4, calRationalizationCount: 6, calDisclosureCount: 1, zabalaOverreachCount: 3, positionChangeCount: 2 });
  const block = renderContinuityBlock(continuityOpportunities(s, { topicText: NEUTRAL_TOPIC }));
  const where = block.slice(block.indexOf("WHERE THEY STAND:"));
  assert(!/-?\d/.test(where.replace(/episode \d+/gi, "")), `the relationship section must contain no numbers:\n${where}`);
  assert(/does not believe him/.test(describeRelationship({ trust: -4, calDisclosures: 1, calRationalizations: 6, zabalaOverreaches: 3, positionChanges: 2, openThread: null })), "low trust must read as low trust");
});

// --- THE MODEL CANNOT INVENT STATE -----------------------------------------

check("the update contract cannot express an invented absolute value", () => {
  assert(!continuityUpdateSchema.safeParse({ redEyeStage: 6 }).success, "the schema is strict — a stage number must be rejected");
  assert(!continuityUpdateSchema.safeParse({ trustLevel: 5 }).success, "an absolute trust value must be rejected");
  assert(!continuityUpdateSchema.safeParse({ relationship: { trustDelta: 9 } }).success, "the trust delta is bounded to ±2");
  assert(!continuityUpdateSchema.safeParse({ positionsTaken: [{ host: "mulkey", position: "anything at all" }] }).success, "only the two real hosts exist");
});

// --- LEGACY DUTCH STATE CANNOT LEAK ----------------------------------------
//
// The retired engine's state is archived in the database, not deleted, which
// means the ONLY thing standing between it and a prompt is that nothing here
// can read it. These assertions are that guarantee, stated as a test.

check("legacy Dutch state cannot leak into a prompt or into state", () => {
  const dutchClaim = {
    attendanceClaimed: 6492,
    attendanceReal: 5200,
    weSaidCount: 3,
    endedOnDodge: "the Wolverines family",
    hoytBeatDelivered: true,
    hoytFactsAdded: ["Duane Hoyt played four games in 2004"],
    wolverineUsed: "Petey Vandersloot",
    unityBeatPresent: true,
  };
  // 1. A retired-shape claim cannot even be parsed.
  assert(!continuityUpdateSchema.safeParse(dutchClaim).success, "a retired-shape claim must not validate");

  // 2. A state object carrying retired fields renders a prompt that mentions none of them.
  const contaminated = { ...state({ episodeCount: 11 }), phantomFansTotal: 41_000, hoytStage: 4, wolverinesInvoked: ["Duane Hoyt"], currentDodge: "we" } as unknown as ContinuityState;
  const block = renderContinuityBlock(continuityOpportunities(contaminated, { topicText: SCAPEGOAT_TOPIC }));
  for (const token of ["Hoyt", "Wolverine", "attendance", "phantom", "Mulkey", "Dutch", "dodge", "41,000"]) {
    assert(!new RegExp(token, "i").test(block), `'${token}' reached the prompt:\n${block}`);
  }

  // 3. Nothing in the new engine's own source names a retired device.
  const engine = readFileSync(join(__dirname, "..", "lib", "services", "showContinuity.ts"), "utf8");
  const service = readFileSync(join(__dirname, "..", "lib", "services", "showContinuityService.ts"), "utf8");
  for (const token of ["Hoyt", "Wolverine", "phantomFans", "pronounHunt", "weSaidCount", "DODGE_LADDER"]) {
    assert(!engine.includes(token), `showContinuity.ts still references ${token}`);
    assert(!service.includes(token), `showContinuityService.ts still references ${token}`);
  }
});

check("a malformed stored ledger/position row is dropped, never guessed at", () => {
  const rows = readLedger([{ phrase: "culture fit", episodeIndex: 1 }, { phrase: "", episodeIndex: 2 }, "nonsense", null, { episodeIndex: 3 }]);
  assert(rows.length === 1, `only the well-formed row survives, got ${JSON.stringify(rows)}`);
  assert(rows[0].status === "used", "a missing status defaults to 'used', never to a resolution");
  const pos = readPositions([{ host: "mulkey", episodeIndex: 1, position: "x" }, { host: "cal", episodeIndex: 1, position: "a real position here" }]);
  assert(pos.length === 1 && pos[0].host === "cal", `a retired host must not survive a read, got ${JSON.stringify(pos)}`);
});

// --- THE FOLD IS THE SOURCE OF TRUTH ---------------------------------------
//
// ShowContinuity is a CACHE of folding every produced episode's stored claim.
// These assertions are the reason that design was worth the extra column: an
// incrementally-maintained counter that drifts is permanently and silently
// wrong, while a fold can always be recomputed.

const foldOf = (claims: ContinuityUpdate[]): ContinuityState =>
  claims.reduce<ContinuityState>((s, c) => nextContinuityState(s, c), { ...EMPTY_CONTINUITY });

const layerClaim = (n: number) =>
  update({ redEyeLayerDelivered: true, redEyeDisclosure: `Layer ${n}: a distinct admission number ${n} about the ${n} thing.` });

check("folding claims equals incrementally applying them", () => {
  const claims = [
    layerClaim(1),
    update({ languageUsed: [{ phrase: "culture fit", context: "a firing" }] }),
    update({ relationship: { trustDelta: 1, calDisclosed: true, calRationalized: false, zabalaOverreached: false, positionChangedBy: "zabala", openThread: null } }),
  ];
  let incremental: ContinuityState = { ...EMPTY_CONTINUITY };
  for (const c of claims) incremental = nextContinuityState(incremental, c);
  assert(JSON.stringify(foldOf(claims)) === JSON.stringify(incremental), "the fold must equal the incremental result");
  assert(incremental.episodeCount === 3, `expected 3 episodes, got ${incremental.episodeCount}`);
  assert(incremental.redEyeStage === 1, `expected stage 1, got ${incremental.redEyeStage}`);
  assert(JSON.stringify(incremental.redEyeFirings) === "[0]", `the firing must be stamped with its index, got ${JSON.stringify(incremental.redEyeFirings)}`);
});

check("a dropped episode is REPAIRED by re-folding, not by subtraction", () => {
  const all = [layerClaim(1), layerClaim(2), layerClaim(3)];
  const withAll = foldOf(all);
  assert(withAll.redEyeStage === 3, `three delivered layers should give stage 3, got ${withAll.redEyeStage}`);

  const repaired = foldOf([all[0], all[2]]);
  assert(repaired.episodeCount === 2, `expected 2, got ${repaired.episodeCount}`);
  assert(repaired.redEyeStage === 2, `expected the ladder to fall back to 2, got ${repaired.redEyeStage}`);
  assert(!repaired.redEyeDisclosures.some((d) => d.startsWith("Layer 2")), "the dropped episode's confession must leave the record");
});

check("a failed generation cannot burn a ladder layer", () => {
  const produced = [layerClaim(1)];
  assert(foldOf(produced).redEyeStage === 1, "the produced episode advanced the ladder");
  // The next episode's claim exists but never reaches audio, so it is absent
  // from the fold entirely.
  assert(foldOf(produced).redEyeStage === 1, "an episode that never produced audio must not advance the ladder");
  assert(foldOf(produced).episodeCount === 1, "nor the episode count");
});

check("rate-limit windows survive a re-fold with the same episode indices", () => {
  const claims = Array.from({ length: 12 }, (_, i) => (i === 3 || i === 8 ? layerClaim(i) : update()));
  const folded = foldOf(claims);
  assert(JSON.stringify(folded.redEyeFirings) === JSON.stringify([3, 8]), `firings must be stamped with stable indices, got ${JSON.stringify(folded.redEyeFirings)}`);
  assert(rateLimitAllows(folded, "redEyeLayer"), "old firings must age out of the window after a re-fold");
});

// --- THE PROMPT ACTUALLY REACHES THE MODEL ---------------------------------
//
// The defect this section exists for: the composed prompt was computed and
// never passed, so continuity injection was dead code — and every test still
// passed, because not one of them asserted the prompt reaches the LLM.

check("composition: the block is present when injected, and the kill switch is byte-identical", () => {
  const base = "SYSTEM PROMPT BODY";
  const block = renderContinuityBlock(continuityOpportunities(state({ episodeCount: 5 }), { topicText: SCAPEGOAT_TOPIC }));

  const withBlock = composeGenerationSystemPrompt(base, block);
  assert(withBlock.includes(block), "the continuity block must be present in the composed prompt");
  assert(withBlock.startsWith(base), "continuity is APPENDED — the base prompt leads");

  const without = composeGenerationSystemPrompt(base, null);
  assert(without === base, "with no continuity the prompt must be BYTE-IDENTICAL to the base — a kill switch that alters the prompt is not a kill switch");
});

check("wiring: every generation call site sends the CONTINUITY-COMPOSED prompt", () => {
  const src = readFileSync(join(__dirname, "..", "lib", "services", "scriptService.ts"), "utf8");
  assert(/const systemPromptWithContinuity = composeGenerationSystemPrompt\(/.test(src),
    "scriptService must build the generation prompt through composeGenerationSystemPrompt");
  const outlineCall = /generateOutlineDrivenScript\(llm,\s*\{\s*systemPrompt:\s*systemPromptWithContinuity/;
  assert(outlineCall.test(src), "the outline-driven generation call must send systemPromptWithContinuity");
  const fallbackBlock = src.slice(src.indexOf("script:single-shot-fallback"));
  assert(/systemPrompt:\s*systemPromptWithContinuity/.test(fallbackBlock.slice(0, 600)),
    "the single-shot fallback must also send systemPromptWithContinuity");
  assert(!/generateOutlineDrivenScript\(llm,\s*\{\s*systemPrompt,/.test(src),
    "generation must not receive the un-composed prompt");
});

check("wiring: the relevance gates receive THIS episode's topic material", () => {
  // Without the topic text every gate defaults open-or-shut on the wrong basis:
  // the Red Eye File would never be eligible and no callback could ever be
  // checked for relevance. The context has to reach both the prompt build and
  // the claim recording, or the guards validate against different facts than
  // the prompt offered.
  const src = readFileSync(join(__dirname, "..", "lib", "services", "scriptService.ts"), "utf8");
  assert(/const continuityContext = \{ topicText: topicsPrompts \}/.test(src), "the continuity context must be built from the episode's topic prompts");
  assert(/continuityForGeneration\(ep\.podcastId, continuityContext\)/.test(src), "the prompt build must receive the context");
  assert(/recordEpisodeContinuityClaim\(ep\.id, claim, continuityContext\)/.test(src), "the claim recording must receive the SAME context");
});

check("kill switch: the flag is read, and only 'false' disables injection", () => {
  const src = readFileSync(join(__dirname, "..", "lib", "services", "scriptService.ts"), "utf8");
  assert(/process\.env\.CONTINUITY_INJECTION !== "false"/.test(src),
    "CONTINUITY_INJECTION must gate the injection, defaulting to ON so an unset env behaves as today");
});

// --- A BAD CONTINUITY REPORT MUST NEVER FAIL AN EPISODE --------------------

const fakeLlm = (behavior: "ok" | "throw" | "garbage" | "partial" | "unknown-keys" | "not-object") => ({
  name: "fake",
  generateText: async () => "",
  generateStructuredOutput: async () => {
    if (behavior === "throw") throw new Error("provider exploded");
    if (behavior === "garbage") return { redEyeLayerDelivered: "sort of", languageUsed: "a few", relationship: 7 };
    if (behavior === "partial") return { redEyeLayerDelivered: false, languageUsed: [{ phrase: "culture fit", context: "a firing" }], relationship: { trustDelta: 99 } };
    if (behavior === "unknown-keys") return { redEyeStage: 6, phantomFansTotal: 999999, somethingInvented: true };
    if (behavior === "not-object") return "a bare string";
    return { redEyeLayerDelivered: false, languageUsed: [{ phrase: "culture fit", context: "a coach fired" }] };
  },
});

const reportWith = async (behavior: Parameters<typeof fakeLlm>[0]) =>
  reportContinuityClaim(fakeLlm(behavior) as never, {
    scriptText: "ZABALA:\nline\n\nCAL:\nline",
    opportunities: continuityOpportunities(state(), { topicText: SCAPEGOAT_TOPIC }),
  });

void (async () => {
  await checkAsync("report: a well-formed claim is returned", async () => {
    const r = await reportWith("ok");
    assert(r !== null, "a valid report must come back");
    assert(r!.languageUsed[0].phrase === "culture fit", `unexpected claim: ${JSON.stringify(r)}`);
  });

  await checkAsync("report: a provider THROW is a non-event, not an outage", async () => {
    assert((await reportWith("throw")) === null, "a provider failure must return null rather than propagate");
  });

  await checkAsync("report: wholly garbage values are discarded, not thrown", async () => {
    const r = await reportWith("garbage");
    assert(r === null || (r.redEyeLayerDelivered === false && r.languageUsed.length === 0), `garbage must not reach state, got ${JSON.stringify(r)}`);
  });

  await checkAsync("report: a non-object response is a non-event", async () => {
    assert((await reportWith("not-object")) === null, "a bare string must not throw");
  });

  await checkAsync("report: ONE bad field is dropped, the rest of the claim survives", async () => {
    const r = await reportWith("partial");
    assert(r !== null, "a single bad field must not discard the whole report");
    assert(r!.relationship.trustDelta === 0, `the invalid delta must fall back to the default, got ${r!.relationship.trustDelta}`);
    assert(r!.languageUsed[0]?.phrase === "culture fit", "valid fields must survive the salvage");
  });

  await checkAsync("report: invented keys cannot smuggle an absolute value into state", async () => {
    const r = await reportWith("unknown-keys");
    assert(r !== null, "unknown keys should be dropped, not fatal");
    assert(!("redEyeStage" in (r as object)), "an absolute value must never survive into the claim");
    assert(!("phantomFansTotal" in (r as object)), "a retired field must never survive into the claim");
    const folded = nextContinuityState(state({ redEyeStage: 2 }), r!);
    assert(folded.redEyeStage === 2, `an invented stage must not move state, got ${folded.redEyeStage}`);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
