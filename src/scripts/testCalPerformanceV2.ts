// Regression for Cal Mercer performance v2.
//
// The production defect was not just "a bad voice": the authored profile stacked
// analytical concessions, rare interruptions, deliberate pauses and a low
// baseline, while the Fish scene adapter only distilled the first sentence of
// speakingStyle into its delivery cue. That combination produced a polished,
// nerdy script-reader performance.
//
// Run:
//   npx tsx --conditions=react-server src/scripts/testCalPerformanceV2.ts

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CAL_PROFILE, RETIRED_HOST_SLUGS, RETIRED_V7_HOSTS, SEED_HOSTS } from "../lib/hosts/roster";
import { compactFishDeliveryCue } from "../lib/providers/tts/fishDialogue";

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function check(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed++;
    console.error(`  ✗ ${name}\n      ${error instanceof Error ? error.message : String(error)}`);
  }
}

// CAL IS RETIRED, AND THIS TEST STILL MATTERS.
//
// The baseball cast (Host Bible v8) replaced him, so he is in RETIRED_V7_HOSTS
// and RETIRED_HOST_SLUGS rather than SEED_HOSTS. This file used to look him up
// in SEED_HOSTS and assert "Cal Mercer is missing from the active roster" — which
// started failing the moment the cast landed on 2026-08-09 and stayed red on
// main, blocking every PR opened since.
//
// It is NOT deleted, because the roster is explicit that these hosts are
// "archived, never deleted: episodes that pinned these hosts must keep resolving
// their cast". An archived episode still renders through CAL_PROFILE, so the
// performance regression this file exists to prevent is still reachable — the
// dials just have to be read from the archive rather than the active roster.
//
// The roster is correct and untouched. Only the lookup moved.
const cal = RETIRED_V7_HOSTS.find((host) => host.slug === "cal-red-eye-mercer");
assert(
  !!cal,
  "Cal Mercer is missing from RETIRED_V7_HOSTS — archived episodes that pinned him can no longer resolve their cast"
);
assert(
  RETIRED_HOST_SLUGS.includes("cal-red-eye-mercer"),
  "Cal is no longer listed as retired; if he has been recast as active, this file should read SEED_HOSTS again"
);
assert(
  !SEED_HOSTS.some((host) => host.slug === "cal-red-eye-mercer"),
  "Cal is back in the ACTIVE roster — that is a cast change, and this test's premise needs revisiting"
);

console.log("Cal Mercer performance v2\n");

check("normal delivery is energetic enough to avoid the restrained analyst trap", () => {
  assert(CAL_PROFILE.baselinePace >= 1.05, `baseline pace is still too restrained: ${CAL_PROFILE.baselinePace}`);
  assert(CAL_PROFILE.maxEscalationPace >= 1.18, `escalation pace is still too narrow: ${CAL_PROFILE.maxEscalationPace}`);
  assert(CAL_PROFILE.baselineIntensity >= 5, `baseline intensity is still too low: ${CAL_PROFILE.baselineIntensity}`);
  assert(CAL_PROFILE.peakIntensity >= 8, `peak intensity is still too low: ${CAL_PROFILE.peakIntensity}`);
});

check("behavior dials produce a reactive co-host instead of a calm analyst", () => {
  assert(CAL_PROFILE.laughBehavior === "natural", "dry laughter must be available naturally");
  assert(CAL_PROFILE.concessionBehavior === "grudging", "analytical concessions recreate the lecturer");
  assert(CAL_PROFILE.interruptionBehavior === "assertive", "Cal must be allowed to cut in");
  assert(CAL_PROFILE.preferredPauseStyle === "tight", "deliberate presenter pauses must stay disabled");
  assert(CAL_PROFILE.angerStyle === "slower_quieter", "quiet anger is the useful contrast and must remain");
});

check("Fish sampling is allowed enough variation to escape metronomic delivery", () => {
  const fish = CAL_PROFILE.providerOverrides.fish;
  assert(fish.temperature >= 0.85, `Fish temperature is too conservative: ${fish.temperature}`);
  assert(fish.topP >= 0.85, `Fish topP is too conservative: ${fish.topP}`);
});

check("the first speaking-style sentence is a direct Fish performance cue", () => {
  const cue = compactFishDeliveryCue({
    speakerHostId: cal.slug,
    formatRoleId: "chair_b",
    direction: `Delivery style: ${cal.speakingStyle} This is a conversation.`,
    intensityLevel: cal.intensityLevel,
    angerStyle: CAL_PROFILE.angerStyle as "slower_quieter",
    maxCueDensity: CAL_PROFILE.maxCueDensity,
    profileVersion: CAL_PROFILE.version,
    providerOverrides: CAL_PROFILE.providerOverrides.fish,
  });
  assert(!!cue, "Fish cue was not produced");
  assert(/close-mic and brisk/i.test(cue), `Fish cue lost the intended delivery: ${cue}`);
  assert(/never polished, analytical, narrated, or announced/i.test(cue), `Fish cue lost the anti-robot guard: ${cue}`);
  assert(!/hotel bar|unhurried|intentional pause/i.test(cue), `retired restrained cue leaked through: ${cue}`);
});

check("script persona reacts first and cannot become smoother when cornered", () => {
  assert(/reacts before he explains/i.test(cal.speakingStyle), "react-first behavior is missing");
  assert(/defensive and clipped/i.test(cal.speakingStyle), "cornered behavior is not clipped");
  assert(!/gets smoother and more explanatory/i.test(cal.speakingStyle), "retired lecturer behavior still exists");
  assert(cal.argumentPatterns.some((pattern) => /direct rebuttal/i.test(pattern)), "direct rebuttal pattern missing");
  assert(cal.argumentPatterns.some((pattern) => /never smoother/i.test(pattern)), "anti-explainer cornered rule missing");
});

check("common robotic analyst openings are banned", () => {
  const banned = new Set(cal.bannedPhrases.map((phrase) => phrase.toLowerCase()));
  for (const phrase of [
    "here's what people don't understand",
    "the reality is",
    "from an organizational standpoint",
    "what you have to remember is",
    "there are several factors at play",
    "it is important to understand",
    "ultimately",
    "at the end of the day",
  ]) {
    assert(banned.has(phrase), `robotic phrase is not banned: ${phrase}`);
  }
});

check("migration applies the same v2 contract to existing databases", () => {
  const migration = readFileSync(
    join(__dirname, "../../prisma/migrations/20260728170000_cal_performance_v2/migration.sql"),
    "utf8"
  );
  assert(/WHERE "slug" = 'cal-red-eye-mercer'/.test(migration), "migration does not target Cal");
  assert(/"concessionBehavior":"grudging"/.test(migration), "migration kept analytical concessions");
  assert(/"interruptionBehavior":"assertive"/.test(migration), "migration kept rare interruptions");
  assert(/"preferredPauseStyle":"tight"/.test(migration), "migration kept presenter pauses");
  assert(/reacts before he explains/i.test(migration), "migration did not carry the new script persona");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
