// Format sound-direction policies + protected regions (PR 3, pure).
// Run: npm run test:sound-direction-policy

import { FORMAT_SOUND_POLICIES, getFormatSoundPolicy, assertFormatPolicyCoverage } from "../lib/audio/formatSoundPolicy";
import { buildProtectedRegions, criticalReason, cueCollidesWithProtected, type ProtectedLineInput } from "../lib/audio/protectedRegions";
import { listShowFormats } from "../lib/formats/showFormatRegistry";

let passed = 0, failed = 0;
function check(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.error(`  ✗ ${name}\n      ${(err as Error).message}`); }
}
function assert(c: boolean, m: string) { if (!c) throw new Error(m); }

const pLine = (over: Partial<ProtectedLineInput>): ProtectedLineInput => ({
  lineIndex: 0, text: "just some ordinary chatter here friends", isInterruption: false,
  speechStartMs: 1000, speechEndMs: 3000, timelineStartMs: 1000, ...over,
});
const opts = { openingPaddingMs: 300, closingPaddingMs: 300, speechPaddingMs: 150, allowDuckedBedUnderHard: true };

function main() {
  console.log("\nFormat sound-direction policies + protected regions\n");

  check("every registered format has a policy; no extra/unknown policies", () => {
    const ids = listShowFormats().map((f) => f.id);
    const cov = assertFormatPolicyCoverage(ids);
    assert(cov.ok, `coverage: missing=${cov.missing} extra=${cov.extra}`);
    assert(Object.keys(FORMAT_SOUND_POLICIES).length === 10, "exactly ten policies");
  });

  check("formats receive MEANINGFULLY different direction", () => {
    const solo = getFormatSoundPolicy("solo_commentary");
    const sports = getFormatSoundPolicy("sports_radio");
    const doc = getFormatSoundPolicy("documentary");
    const rapid = getFormatSoundPolicy("rapid_fire");
    const news = getFormatSoundPolicy("news_roundup");
    // sparse solo vs dense sports
    assert(solo.maxTransitionsPerEpisode < sports.maxTransitionsPerEpisode, "solo sparser than sports");
    assert(solo.maxReactionsPerEpisode <= 1, "solo minimal reactions");
    // sports permits score/data/crowd; solo/doc do not
    assert(sports.allowScoreUpdate && sports.allowDataReveal && sports.allowCrowd, "sports permits score/data/crowd");
    assert(!solo.allowScoreUpdate && !doc.allowScoreUpdate, "solo/doc prohibit score updates");
    // news: no comedy, breaking-news permitted
    assert(!news.allowComedy && news.allowBreakingNews, "news: no comedy, breaking permitted");
    // documentary: chapter bridge, longest min gap, cinematic preferred
    assert(doc.allowChapterBridge && doc.minTransitionGapMs >= 2000 && doc.preferredCueFamilies.includes("cinematic_bridge"), "documentary cinematic bridges");
    // rapid fire: shortest gap, no under-speech bed, hard close
    assert(rapid.minTransitionGapMs <= 800 && !rapid.allowUnderSpeechBeds && rapid.outroStyle === "hard_branded_close", "rapid-fire restraint");
    // distinct intro styles across formats
    const introStyles = new Set(Object.values(FORMAT_SOUND_POLICIES).map((p) => p.introStyle));
    assert(introStyles.size >= 3, "several distinct intro styles");
  });

  check("betting desk protects odds/negations; permits data reveal, not crowd", () => {
    const bet = getFormatSoundPolicy("betting_desk");
    assert(bet.allowDataReveal && !bet.allowCrowd && bet.prohibitedCueFamilies.includes("crowd_positive"), "betting: data yes, crowd no");
    assert(bet.protectedClosingPaddingMs >= 300, "betting protects the close (responsible-gambling language)");
  });

  check("unknown format falls back to the debate policy (never a blank generic)", () => {
    assert(getFormatSoundPolicy("not_a_format").formatId === "two_host_debate", "safe fallback");
  });

  // --- Protected regions ---------------------------------------------------
  check("criticalReason detects factual claim / number / negation / score / injury", () => {
    assert(criticalReason(pLine({ isFactualClaim: true })) === "factual claim (names/numbers/scores)", "factual claim");
    assert(criticalReason(pLine({ text: "he scored 30 points last night" })) === "number", "number");
    assert(!!criticalReason(pLine({ text: "they did not win that game" }))?.includes("negation"), "negation");
    assert(!!criticalReason(pLine({ text: "the spread moved to favorite" }))?.includes("score/odds"), "odds");
    assert(!!criticalReason(pLine({ text: "he is questionable with a hamstring" }))?.includes("injury"), "injury");
    assert(criticalReason(pLine({ text: "just vibes and good times" })) === null, "plain speech is not critical");
  });

  check("every speech span is at least soft-protected; opening/closing/critical are HARD", () => {
    const lines = [
      pLine({ lineIndex: 0, text: "welcome in everybody", speechStartMs: 1000, speechEndMs: 2500, timelineStartMs: 1000 }),
      pLine({ lineIndex: 1, text: "just chatting along now", speechStartMs: 3000, speechEndMs: 4500, timelineStartMs: 3000 }),
      pLine({ lineIndex: 2, text: "he scored 42 points", speechStartMs: 5000, speechEndMs: 6500, timelineStartMs: 5000 }),
      pLine({ lineIndex: 3, text: "thanks for listening", speechStartMs: 7000, speechEndMs: 8500, timelineStartMs: 7000 }),
    ];
    const regions = buildProtectedRegions(lines, opts);
    const byLine = (i: number) => regions.find((r) => r.lineIndex === i && r.reason !== "interruption overlap")!;
    assert(byLine(0).severity === "hard" && byLine(0).reason.includes("opening"), "opening hard");
    assert(byLine(1).severity === "soft" && byLine(1).allowDuckedBed, "ordinary middle line soft, bed allowed");
    assert(byLine(2).severity === "hard" && byLine(2).reason === "number", "number line hard");
    assert(byLine(3).severity === "hard" && byLine(3).reason.includes("closing"), "closing hard");
  });

  check("interruption speech + overlap are hard-protected", () => {
    const lines = [
      pLine({ lineIndex: 0, text: "so i was saying that", speechStartMs: 1000, speechEndMs: 3000, timelineStartMs: 1000 }),
      pLine({ lineIndex: 1, text: "no wait hold on", isInterruption: true, appliedOverlapMs: 400, speechStartMs: 2700, speechEndMs: 4200, timelineStartMs: 2700 }),
    ];
    const regions = buildProtectedRegions(lines, opts);
    assert(regions.some((r) => r.reason === "interruption" && r.severity === "hard"), "interruption line hard");
    assert(regions.some((r) => r.reason === "interruption overlap" && r.severity === "hard"), "overlap hard");
  });

  check("HARD rule: stinger/reaction/unducked music rejected over speech; ducked bed allowed under ordinary speech", () => {
    // Two ORDINARY middle lines (2,3) between the hard opening (0) and closing (5),
    // with a clean gap 8000-9000 between two ordinary lines.
    const lines = [
      pLine({ lineIndex: 0, text: "welcome", speechStartMs: 1000, speechEndMs: 2500, timelineStartMs: 1000 }),
      pLine({ lineIndex: 1, text: "just chatting here now", speechStartMs: 3000, speechEndMs: 5000, timelineStartMs: 3000 }),
      pLine({ lineIndex: 2, text: "carrying on with the vibe", speechStartMs: 6000, speechEndMs: 8000, timelineStartMs: 6000 }),
      pLine({ lineIndex: 3, text: "still just vibing along here", speechStartMs: 9000, speechEndMs: 11000, timelineStartMs: 9000 }),
      pLine({ lineIndex: 4, text: "goodbye now", speechStartMs: 12000, speechEndMs: 13000, timelineStartMs: 12000 }),
    ];
    const regions = buildProtectedRegions(lines, opts);
    assert(cueCollidesWithProtected(regions, 3500, 4000, "hard") !== null, "hard cue over speech rejected");
    assert(cueCollidesWithProtected(regions, 3500, 4000, "ducked_bed") === null, "ducked bed under ordinary speech ok");
    const strict = buildProtectedRegions(lines, { ...opts, allowDuckedBedUnderHard: false });
    assert(cueCollidesWithProtected(strict, 1100, 1400, "ducked_bed") !== null, "ducked bed under hard rejected when forbidden");
    assert(cueCollidesWithProtected(regions, 1100, 1400, "reaction_tail") !== null, "reaction tail over hard opening rejected");
    // A clean gap between two ordinary lines (8150..8850, clear of ±150 padding) hosts a hard cue.
    assert(cueCollidesWithProtected(regions, 8300, 8700, "hard") === null, "hard cue in a clean gap ok");
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
