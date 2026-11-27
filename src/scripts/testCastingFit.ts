// Network-free check for the Talent Studio's casting heuristics.
// Run: npx tsx src/scripts/testCastingFit.ts
//
// Pure functions over stored host settings: no DB, no provider, no model.

import assert from "node:assert";
import { defaultHostStudioSettings, type HostStudioSettings } from "../lib/hosts/hostStudioProfile";
import {
  BASE_SCORE,
  castingFit,
  personalityRead,
  personalityRecommendations,
  rankCastingPartners,
  talentReadiness,
  type CastingProfile,
} from "../lib/hosts/castingFit";

let passed = 0;
let failed = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.error(`  ✗ ${name}\n      ${(err as Error).message}`);
  }
}

const VOICE_A = "a".repeat(32);
const VOICE_B = "b".repeat(32);

function host(id: string, name: string, voice: string, overrides: Partial<HostStudioSettings>): CastingProfile {
  return { id, name, ttsVoiceId: voice, settings: { ...defaultHostStudioSettings(), ...overrides } };
}

const loud = host("h1", "Loud", VOICE_A, {
  rolePreset: "fan_champion", energy: "big", pace: "fast", humor: "playful",
  interruptions: "jumps_in", concessions: "stubborn", finish: "theatrical", pressure: "louder_faster", castPriority: 8,
});
const quiet = host("h2", "Quiet", VOICE_B, {
  rolePreset: "skeptic", energy: "calm", pace: "easy", humor: "serious",
  interruptions: "waits", concessions: "gracious", finish: "sharp", pressure: "quieter_sharper", castPriority: 4,
});
const twin = host("h3", "Twin", VOICE_A, { ...loud.settings });
const mute = host("h4", "Mute", "PLACEHOLDER_USER_VOICE", { ...quiet.settings });

console.log("Talent Studio casting heuristics\n");

check("a contrasting partner outranks a clone, and the ranking is deterministic", () => {
  const first = rankCastingPartners(loud, [twin, quiet, mute, loud]);
  const second = rankCastingPartners(loud, [mute, loud, quiet, twin]);
  assert.deepStrictEqual(first, second, "input order changed the ranking");
  assert.deepStrictEqual(first.map((fit) => fit.name), ["Quiet", "Mute", "Twin"]);
  assert.ok(!first.some((fit) => fit.hostId === loud.id), "a host was recommended as its own partner");
});

check("every score comes with reasons that add up to it and name stored values", () => {
  const fit = castingFit(loud, quiet);
  assert.ok(fit.reasons.length > 0);
  assert.strictEqual(fit.score, BASE_SCORE + fit.reasons.reduce((sum, reason) => sum + reason.effect, 0));
  assert.strictEqual(fit.score, 100, "the fully contrasting pair should be the ceiling");
  assert.ok(fit.reasons.some((reason) => reason.text.includes("Big energy") && reason.text.includes("Calm")));
});

check("a shared voice and a missing voice are both called out", () => {
  assert.ok(castingFit(loud, twin).reasons.some((reason) => /same stored voice/.test(reason.text) && reason.effect < 0));
  assert.ok(castingFit(loud, mute).reasons.some((reason) => /no voice yet/.test(reason.text) && reason.effect < 0));
  assert.ok(castingFit(loud, twin).reasons.some((reason) => /talk over each other/.test(reason.text)));
});

check("fit is symmetric and stays inside 0–100", () => {
  for (const [x, y] of [[loud, quiet], [loud, twin], [quiet, mute]] as const) {
    assert.strictEqual(castingFit(x, y).score, castingFit(y, x).score);
    assert.ok(castingFit(x, y).score >= 0 && castingFit(x, y).score <= 100);
  }
});

check("recommendations flag untouched defaults and real contradictions, each with its basis", () => {
  const fresh = personalityRecommendations(defaultHostStudioSettings());
  assert.ok(fresh.some((rec) => rec.id === "belief-default"));
  assert.ok(fresh.some((rec) => rec.id === "role-generic"));
  assert.ok(fresh.some((rec) => rec.id === "habits-missing"));

  const clash = personalityRecommendations({
    ...loud.settings, pauses: "spacious", catchphrases: ["Book it"], bannedPhrases: ["book it"],
  });
  assert.ok(clash.some((rec) => rec.id === "phrase-clash" && rec.basis[0].includes("Book it")));
  assert.ok(clash.some((rec) => rec.id === "pace-vs-pauses"));
  assert.ok(clash.some((rec) => rec.id === "all-max"));
  for (const rec of [...fresh, ...clash]) assert.ok(rec.basis.length > 0 && rec.suggestion, `${rec.id} has no basis`);
});

check("a filled-in, coherent host gets no recommendations", () => {
  const recs = personalityRecommendations({
    ...quiet.settings,
    belief: "Every clean public story is hiding one uncomfortable tradeoff, and somebody was paid to hide it.",
    argumentPatterns: ["Asks who benefited", "Names the missing number"],
    bannedPhrases: ["At the end of the day"],
    prohibitedTraits: ["announcer cadence"],
  });
  assert.deepStrictEqual(recs, []);
});

check("readiness: a nameless host is blocked; an undocumented voice is a warning", () => {
  const base = { settings: quiet.settings, willHaveVoice: true, voiceSource: "owned" };
  assert.deepStrictEqual(talentReadiness({ ...base, name: "Quiet" }), []);
  assert.ok(talentReadiness({ ...base, name: " " }).some((issue) => issue.level === "blocker"));
  assert.ok(talentReadiness({ ...base, name: "Quiet", voiceSource: "" }).some((issue) => issue.id === "provenance" && /undocumented/.test(issue.text)));
  assert.ok(talentReadiness({ ...base, name: "Quiet", willHaveVoice: false }).some((issue) => issue.id === "voice"));
});

check("the personality read is built from the stored choices", () => {
  const read = personalityRead(loud.settings);
  assert.ok(/Big energy/.test(read) && /jumps in/i.test(read) && /louder and faster/.test(read), read);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
