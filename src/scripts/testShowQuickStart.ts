// Network-free check for the AI Quick Start proposal mapping. The "model reply"
// here is a hand-written FAKE — no LLM is called.
// Run: npx tsx src/scripts/testShowQuickStart.ts

import assert from "node:assert";
import { normalizeQuickStartProposal, validateQuickStartShape, buildQuickStartPrompt } from "../lib/shows/quickStart";
import { showForgeStateSchema, SHOW_TEMPLATES } from "../lib/shows/showForge";
import { PODCAST_GOALS } from "../lib/business/profileSchema";

const hosts = [
  { id: "h1", name: "Zabala", role: "Provocateur" },
  { id: "h2", name: "Cal Mercer", role: "Analyst" },
  { id: "h3", name: "Third", role: "Spare" },
];
const ctx = { description: "A twice-weekly NFL show where two friends argue about coaching decisions.", hosts, allowBusiness: true };

// 1. A good fake reply maps straight onto the existing create input.
const good = normalizeQuickStartProposal({
  kind: "sports", kindReason: "It is about the NFL.",
  name: "Fourth and Wrong", nameReason: "Names the argument.",
  templateId: "fan_court", formatReason: "Decisions on trial.",
  tone: "smart_funny", scriptStyle: "sports-radio", toneReason: "Friends arguing.",
  cadence: "recurring", scheduleDays: ["tue", "FRI"], cadenceReason: "Twice weekly.",
  verticals: ["NFL"], verticalsReason: "NFL only.",
  segmentCount: 2, segmentReason: "Short show.",
  hostIds: ["h2", "h1"], hostReason: "Analyst vs provocateur.",
  premise: "Two friends put every coaching decision on trial.",
  audiencePromise: "A ruling on the week's worst decision, every time.",
  pointOfView: "The fan pays for every call.", hostChemistry: "Old friends who never concede.",
  openingRitual: "", closingRitual: "One-line verdicts.",
  recurringSegments: [{ name: "The Charge", purpose: "Name the decision on trial.", frequency: "every_episode" }],
  businessName: "", industry: "", targetAudiences: [], primaryGoal: PODCAST_GOALS[0], businessReason: "",
}, ctx);
assert.equal(good.kind, "sports");
if (good.kind !== "sports") throw new Error("unreachable");
assert.deepEqual(good.input.hostIds, ["h2", "h1"]);
assert.deepEqual(good.input.scheduleDays, ["tue", "fri"]);
assert.deepEqual(good.input.verticals, ["NFL"]);
assert.equal(good.input.segmentCount, 2);
assert.equal(good.input.showForge.bible.templateId, "fan_court");
assert.equal(good.input.showForge.bible.recurringSegments[0].name, "The Charge");
// An empty ritual keeps the format's own, and says so.
assert.equal(good.input.showForge.bible.openingRitual, SHOW_TEMPLATES.fan_court.openingRitual);
assert.equal(good.flags.length, 1, good.flags.join(" | "));
assert.equal(good.reasons.hosts, "Analyst vs provocateur.");
assert.ok(showForgeStateSchema.safeParse(good.input.showForge).success);

// 2. Garbage is replaced by defaults and every replacement is flagged.
const bad = normalizeQuickStartProposal({
  kind: "sports", name: "", templateId: "talk_show", tone: "angry", scriptStyle: "x", cadence: "daily",
  scheduleDays: ["funday"], verticals: ["Cricket"], segmentCount: 40, hostIds: ["ghost"],
  premise: "short", recurringSegments: [{ name: "", purpose: "" }],
}, ctx);
if (bad.kind !== "sports") throw new Error("expected sports");
assert.equal(bad.input.showForge.bible.templateId, "rivalry_room");
assert.equal(bad.input.showForge.scriptStyle, "heated-debate");
assert.equal(bad.input.cadence, "recurring");
assert.deepEqual(bad.input.scheduleDays, ["mon"]);
assert.deepEqual(bad.input.verticals, []); // never guessed: the creator must pick
assert.equal(bad.input.segmentCount, 3);
assert.deepEqual(bad.input.hostIds, ["h1", "h2"]); // invented id dropped; real hosts only
assert.ok(showForgeStateSchema.safeParse(bad.input.showForge).success);
assert.ok(bad.flags.length >= 9, `expected every fallback flagged, got ${bad.flags.length}`);

// 3. Business goes to the business form prefill — no sports fields, and the
//    description is the creator's own words, not the model's.
const bizCtx = { ...ctx, description: "We are Acme Telecom, a wholesale VoIP carrier. A show for carrier executives." };
const biz = normalizeQuickStartProposal({
  kind: "business", name: "Carrier Talk", businessName: "Acme Telecom", industry: "Telecommunications",
  targetAudiences: ["Industry executives"], primaryGoal: "Thought leadership", verticals: ["NFL"], hostIds: ["h1"],
}, bizCtx);
assert.equal(biz.kind, "business");
if (biz.kind !== "business") throw new Error("unreachable");
assert.equal(biz.prefill.description, bizCtx.description);
assert.equal(biz.prefill.primaryGoal, "Thought leadership");
assert.ok(!("input" in biz), "a business proposal must not carry a sports create input");

// 4. Business is refused for an account without business access.
const gated = normalizeQuickStartProposal({ kind: "business", name: "X" }, { ...bizCtx, allowBusiness: false });
assert.equal(gated.kind, "sports");
assert.ok(gated.flags.some((f) => f.includes("not enabled")));

// 5. Null / non-object replies never throw.
assert.equal(normalizeQuickStartProposal(null, ctx).kind, "sports");
assert.equal(validateQuickStartShape({ kind: "sports" }), null);
assert.ok(validateQuickStartShape({ kind: "music" }));
assert.ok(validateQuickStartShape(null));

// 6. The prompt offers only real host ids and hides business when gated.
const p = buildQuickStartPrompt({ description: "x", hosts, allowBusiness: false });
assert.ok(p.prompt.includes('id "h1"') && p.systemPrompt.includes('only "sports" is available'));

console.log("Show Quick Start proposal mapping (fake LLM reply): 6 passed, 0 failed");
