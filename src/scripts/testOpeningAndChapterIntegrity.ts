// Opening-timing + chapter-integrity regression tests.
// Run: npm run test:opening-chapter-integrity
//
// Both suites below are pinned to REAL production failures:
//
//   1. Episode e7867729 opened with 30.9 SECONDS of theme music before the
//      first host word, from a 31.8s intro asset and the unbounded formula
//      `dialogueStartMs = introDurationMs - musicCrossfadeMs`.
//   2. A published episode shipped chapters running to 638s against a 515s
//      MP3, because the estimated chapter walk and the measured duration were
//      never reconciled.
//
// These are executed assertions against the real modules — not source greps.

import assert from "node:assert/strict";

import {
  MAX_SONIC_LOGO_MS,
  MAX_SPEECH_START_MS,
  capDialogueStartMs,
  resolveOpeningPlan,
  sonicLogoLengthMs,
} from "../lib/audio/openingTiming";
import { getFormatSoundPolicy } from "../lib/audio/formatSoundPolicy";
import { resolveIntroDialogueStartMs } from "../lib/audio/postTtsSoundDirector";
import { resolveIntroFromPlan } from "../lib/audio/planExecution";
import type { ProductionPlan } from "../lib/audio/productionPlan";
import type { FrozenSoundProfile, FrozenSoundAssetRef } from "../lib/services/podcastSoundProfile";
import { DEFAULT_SONIC_IDENTITY } from "../lib/audio/sonicIdentity";
import {
  rescaleChapterTimeline,
  validateChapterTimeline,
  type ChapterTiming,
} from "../lib/chapterTimeline";

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

// --- Fixtures --------------------------------------------------------------

/** The production asset: a 31.8s theme. */
const PROD_INTRO_MS = 31800;
/** The default AUDIO_MUSIC_CROSSFADE_MS. */
const CROSSFADE_MS = 900;
/** What the old unbounded formula produced: 31800 - 900 = 30900ms = 30.9s. */
const REGRESSION_PREROLL_MS = PROD_INTRO_MS - CROSSFADE_MS;

const assetRef = (id: string, role: FrozenSoundAssetRef["role"], durationMs: number): FrozenSoundAssetRef => ({
  assetId: id, kind: role === "intro" ? "theme_intro" : "theme_outro", category: null, name: id,
  contentHash: `h${id}`, scope: "shared_system", role, orderIndex: 0, gainDb: null, fadeInMs: null,
  fadeOutMs: null, durationMs, tags: [], rightsStatusAtCapture: "not_required",
  licenseStatusAtCapture: "licensed", provenance: "system_default", weight: 1, cueFamily: null,
});

const soundProfile = (introMs: number): FrozenSoundProfile => ({
  mode: "custom", targetLoudnessLufs: null, cooldownScope: "podcast", stingerCooldownEpisodes: null,
  reactionCooldownEpisodes: null, introEnabled: true, outroEnabled: true,
  intro: assetRef("intro-1", "intro", introMs), outro: assetRef("outro-1", "outro", 4000), bed: null,
  stingers: [], reactions: [], introVariants: [], outroVariants: [], beds: [],
  sonicIdentity: DEFAULT_SONIC_IDENTITY, containsLegacyCompatAssets: false, excluded: [],
});

/** A minimal plan carrying a single intro cue, for the plan-execution site. */
const introPlan = (): ProductionPlan =>
  ({
    plannerVersion: 1,
    seed: "seed",
    cues: [{ type: "intro", assetId: null, assetName: "theme", lineIndex: 0, anchor: "before", gainDb: -2, fadeInMs: 20, fadeOutMs: 900, reason: "episode open" }],
    stats: {},
  }) as unknown as ProductionPlan;

/** The REAL failed episode's chapters (seconds), against a 515s master. */
const FAILED_CHAPTERS: ChapterTiming[] = [
  { title: "Cold Open", startTimeSeconds: 30.9, endTimeSeconds: 123.8, type: "cold_open" },
  { title: "Intro", startTimeSeconds: 124.6, endTimeSeconds: 226.3, type: "intro" },
  { title: "Topic 1", startTimeSeconds: 227.5, endTimeSeconds: 340.1, type: "topic" },
  { title: "Transition", startTimeSeconds: 340.9, endTimeSeconds: 444.2, type: "transition" },
  { title: "Topic 2", startTimeSeconds: 445.4, endTimeSeconds: 521.7, type: "topic" },
  { title: "Topic 3", startTimeSeconds: 522.9, endTimeSeconds: 615.2, type: "topic" },
  { title: "Closing", startTimeSeconds: 616.1, endTimeSeconds: 638, type: "closing" },
];
const FAILED_FINAL_DURATION_SECONDS = 515;

// --- 1. Speech-start invariant ---------------------------------------------

function main() {
  console.log("\nOpening timing + chapter integrity\n");
  console.log("  -- speech start --");

  check("31.8s intro asset: resolved dialogue start is <= 2000ms (was 30900ms)", () => {
    const plan = resolveOpeningPlan({ introDurationMs: PROD_INTRO_MS, musicCrossfadeMs: CROSSFADE_MS });
    assert.ok(
      plan.dialogueStartMs <= MAX_SPEECH_START_MS,
      `dialogue start ${plan.dialogueStartMs}ms exceeds the ${MAX_SPEECH_START_MS}ms ceiling`
    );
    assert.equal(MAX_SPEECH_START_MS, 2000, "the ceiling itself must stay at 2000ms");
    console.log(`      before: ${REGRESSION_PREROLL_MS}ms  ->  after: ${plan.dialogueStartMs}ms`);
  });

  check("31.8s asset does NOT reproduce the 30.9s pre-roll (exact production regression)", () => {
    const plan = resolveOpeningPlan({ introDurationMs: PROD_INTRO_MS, musicCrossfadeMs: CROSSFADE_MS });
    assert.notEqual(plan.dialogueStartMs, REGRESSION_PREROLL_MS, "the unbounded formula is back");
    assert.ok(plan.dialogueStartMs < 3000, `pre-roll ${plan.dialogueStartMs}ms is still multi-second`);
    assert.equal(plan.truncated, true, "a 31.8s theme must be cut to a sonic logo, not waited out");
    assert.equal(plan.mode, "sonic_logo");
    assert.ok(
      plan.introPlayDurationMs <= MAX_SONIC_LOGO_MS,
      `${plan.introPlayDurationMs}ms of theme plays before speech (cap ${MAX_SONIC_LOGO_MS}ms)`
    );
  });

  check("capDialogueStartMs clamps any raw pre-roll, however it was computed", () => {
    assert.equal(capDialogueStartMs(REGRESSION_PREROLL_MS), MAX_SPEECH_START_MS);
    assert.equal(capDialogueStartMs(600), 600);
    assert.equal(capDialogueStartMs(-5), 0);
    assert.equal(capDialogueStartMs(Number.NaN), 0);
    assert.equal(capDialogueStartMs(999999), MAX_SPEECH_START_MS);
  });

  check("post-TTS director (branch B) caps every treatment on a 31.8s asset", () => {
    for (const formatId of ["two_host_debate", "solo_commentary", "sports_radio", "news_roundup", "interview", "documentary", "rapid_fire", "betting_desk", "host_and_expert", "three_person_panel"]) {
      const entry = resolveIntroDialogueStartMs(soundProfile(PROD_INTRO_MS), formatId, true, PROD_INTRO_MS);
      assert.ok(entry <= MAX_SPEECH_START_MS, `${formatId}: speech entry ${entry}ms exceeds the ceiling`);
    }
    // Even when an operator EXPLICITLY asks for the full-theme treatment.
    const forced = resolveIntroDialogueStartMs(soundProfile(PROD_INTRO_MS), "two_host_debate", true, PROD_INTRO_MS, "full_before");
    assert.ok(forced <= MAX_SPEECH_START_MS, `explicit full_before still gave ${forced}ms`);
  });

  check("plan-execution site (resolveIntroFromPlan) is capped too", () => {
    const warnings: string[] = [];
    const res = resolveIntroFromPlan({
      plan: introPlan(),
      assetsById: new Map(),
      envIntro: { filePath: "/tmp/theme.wav", durationMs: PROD_INTRO_MS },
      musicCrossfadeMs: CROSSFADE_MS,
      warnings,
    });
    assert.ok(res.dialogueStartMs <= MAX_SPEECH_START_MS, `plan path gave ${res.dialogueStartMs}ms`);
    assert.ok(res.introClip !== null, "the intro still plays");
    assert.ok(
      (res.introClip as { durationMs: number }).durationMs <= MAX_SONIC_LOGO_MS,
      "the plan's intro clip must be cut to the sonic-logo cap"
    );
    assert.ok(warnings.some((w) => /sonic-logo cap/.test(w)), "the truncation must be reported, not silent");
  });

  check("debate formats no longer default to full_before", () => {
    for (const formatId of ["two_host_debate", "three_person_panel", "host_and_expert"]) {
      assert.notEqual(
        getFormatSoundPolicy(formatId).introStyle,
        "full_before",
        `${formatId} still defaults to the whole-theme-first opening`
      );
    }
    // Reachable ONLY as an explicit override.
    assert.equal(getFormatSoundPolicy("two_host_debate", { introStyle: "full_before" }).introStyle, "full_before");
  });

  console.log("  -- short assets keep working --");

  check("a 1200ms asset still behaves sensibly (no truncation, legacy timing)", () => {
    const plan = resolveOpeningPlan({ introDurationMs: 1200, musicCrossfadeMs: CROSSFADE_MS });
    assert.equal(plan.truncated, false, "a 1.2s asset must not be cut");
    assert.equal(plan.mode, "theme_before_speech");
    assert.equal(plan.introPlayDurationMs, 1200, "the whole short asset plays");
    // Legacy formula, unchanged: max(0, 1200 - 900) = 300.
    assert.equal(plan.dialogueStartMs, 300, `expected the legacy 300ms crossfade start, got ${plan.dialogueStartMs}`);
    assert.ok(plan.dialogueStartMs <= MAX_SPEECH_START_MS);
  });

  check("boundary + degenerate assets", () => {
    const atCap = resolveOpeningPlan({ introDurationMs: MAX_SONIC_LOGO_MS, musicCrossfadeMs: CROSSFADE_MS });
    assert.equal(atCap.truncated, false, "exactly at the cap is not a truncation");
    assert.equal(atCap.dialogueStartMs, MAX_SONIC_LOGO_MS - CROSSFADE_MS);

    const justOver = resolveOpeningPlan({ introDurationMs: MAX_SONIC_LOGO_MS + 1, musicCrossfadeMs: CROSSFADE_MS });
    assert.equal(justOver.truncated, true, "one ms over the cap must truncate");
    assert.ok(justOver.dialogueStartMs <= MAX_SPEECH_START_MS);

    const none = resolveOpeningPlan({ introDurationMs: null });
    assert.equal(none.mode, "no_intro");
    assert.equal(none.dialogueStartMs, 0);
    assert.equal(sonicLogoLengthMs(0), 0);
    assert.equal(sonicLogoLengthMs(PROD_INTRO_MS), MAX_SONIC_LOGO_MS);
  });

  // --- 2. Chapter timeline integrity ---------------------------------------

  console.log("  -- chapter timeline --");

  check("REAL failed episode chapters are REJECTED against the 515s master", () => {
    const v = validateChapterTimeline(FAILED_CHAPTERS, FAILED_FINAL_DURATION_SECONDS);
    assert.equal(v.ok, false, "the shipped 638s-on-515s timeline must not validate");

    const overruns = v.violations.filter((x) => x.code === "exceeds_audio_duration");
    assert.ok(overruns.length > 0, "the overrun must be named explicitly");
    assert.equal(v.timelineEndSeconds, 638);
    assert.equal(v.finalDurationSeconds, 515);

    // The Closing chapter — the one that ended two minutes past the audio.
    const closing = overruns.find((x) => x.title === "Closing");
    assert.ok(closing, "the Closing overrun must be reported");
    assert.match(closing!.detail, /638/, "the violation must quote the impossible endpoint");
    assert.match(closing!.detail, /515/, "the violation must quote the real audio duration");
    assert.match(closing!.detail, /overruns the audio by 123\.0s/, "the violation must quantify the overrun");

    // Everything from Topic 3 onward is past the end of the file.
    assert.ok(
      overruns.some((x) => x.title === "Topic 3"),
      "Topic 3 (615.2s) also overruns and must be reported"
    );
  });

  check("a corrected, in-bounds timeline PASSES", () => {
    const corrected: ChapterTiming[] = [
      { title: "Cold Open", startTimeSeconds: 1.5, endTimeSeconds: 90 },
      { title: "Intro", startTimeSeconds: 90, endTimeSeconds: 180 },
      { title: "Topic 1", startTimeSeconds: 180.5, endTimeSeconds: 300 },
      { title: "Topic 2", startTimeSeconds: 300, endTimeSeconds: 420 },
      { title: "Closing", startTimeSeconds: 420, endTimeSeconds: 514.2 },
    ];
    const v = validateChapterTimeline(corrected, FAILED_FINAL_DURATION_SECONDS);
    assert.equal(v.ok, true, `expected a clean timeline, got: ${v.violations.map((x) => x.detail).join(" ")}`);
    assert.deepEqual(v.violations, []);
  });

  check("rescaling the failed timeline onto the real duration makes it valid", () => {
    const rescaled = rescaleChapterTimeline(FAILED_CHAPTERS, FAILED_FINAL_DURATION_SECONDS);
    const v = validateChapterTimeline(rescaled, FAILED_FINAL_DURATION_SECONDS);
    assert.equal(v.ok, true, `rescale left violations: ${v.violations.map((x) => x.detail).join(" ")}`);
    assert.ok(v.timelineEndSeconds <= FAILED_FINAL_DURATION_SECONDS, "rescaled timeline must fit the audio");
    assert.equal(rescaled.length, FAILED_CHAPTERS.length, "rescaling must not drop chapters");
    assert.equal(rescaled[0].title, "Cold Open", "titles survive the rescale");
    // Order (the part we actually know) is preserved.
    for (let i = 1; i < rescaled.length; i++) {
      assert.ok(rescaled[i].startTimeSeconds >= rescaled[i - 1].startTimeSeconds, "rescale preserves order");
    }
  });

  check("monotonicity violations are caught", () => {
    const backwards: ChapterTiming[] = [
      { title: "A", startTimeSeconds: 0, endTimeSeconds: 100 },
      { title: "B", startTimeSeconds: 60, endTimeSeconds: 200 },   // starts before A ended
      { title: "C", startTimeSeconds: 30, endTimeSeconds: 300 },   // starts before B started
    ];
    const v = validateChapterTimeline(backwards, 515);
    assert.equal(v.ok, false, "a non-monotonic timeline must be rejected");
    assert.ok(v.violations.some((x) => x.code === "overlaps_previous" && x.title === "B"), "B overlaps A");
    assert.ok(v.violations.some((x) => x.code === "non_monotonic_start" && x.title === "C"), "C starts before B");
  });

  check("zero/negative-length and malformed chapters are caught", () => {
    const bad: ChapterTiming[] = [
      { title: "Empty", startTimeSeconds: 10, endTimeSeconds: 10 },
      { title: "Inverted", startTimeSeconds: 40, endTimeSeconds: 20 },
      { title: "Junk", startTimeSeconds: Number.NaN, endTimeSeconds: 50 },
    ];
    const v = validateChapterTimeline(bad, 515);
    assert.equal(v.ok, false);
    assert.ok(v.violations.some((x) => x.code === "non_positive_length" && x.title === "Empty"));
    assert.ok(v.violations.some((x) => x.code === "non_positive_length" && x.title === "Inverted"));
    assert.ok(v.violations.some((x) => x.code === "invalid_number" && x.title === "Junk"));
  });

  check("sub-second rounding overhang is tolerated, minutes are not", () => {
    const rounding: ChapterTiming[] = [{ title: "Only", startTimeSeconds: 0, endTimeSeconds: 515.4 }];
    assert.equal(validateChapterTimeline(rounding, 515).ok, true, "0.4s of rounding is not a broken timeline");
    const broken: ChapterTiming[] = [{ title: "Only", startTimeSeconds: 0, endTimeSeconds: 638 }];
    assert.equal(validateChapterTimeline(broken, 515).ok, false, "123s of overrun is");
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
