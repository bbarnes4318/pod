// Sonic-identity + cue-family + cue-metadata validation tests.
// Run: npm run test:sonic-identity
//
// Pure (no DB, no ffmpeg, no network). Proves the client-safe vocabulary and
// validators: enum + bounded validation, role/cue-family compatibility,
// identity family prohibitions, and metadata verification-state gating.

import {
  validateSonicIdentity, isCueFamily, isCueFamilyValidForRole, cueFamilyAllowedByIdentity,
  DEFAULT_SONIC_IDENTITY, SONIC_IDENTITY_VERSION,
} from "../lib/audio/sonicIdentity";
import { validateCueMetadata, verifiedCueMetadata } from "../lib/audio/cueMetadata";

let passed = 0, failed = 0;
function check(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.error(`  ✗ ${name}\n      ${(err as Error).message}`); }
}
function assert(c: boolean, m: string) { if (!c) throw new Error(m); }

function main() {
  console.log("\nSonic identity + cue families + cue metadata\n");

  check("a valid identity normalizes to the canonical shape", () => {
    const r = validateSonicIdentity({
      primaryGenre: "sports", secondaryGenres: ["talk"], moods: ["energetic"],
      pace: "fast", intensity: "high", broadcastStyle: "sports_radio",
      allowedCueFamilies: ["hard_hit", "score_update"], prohibitedCueFamilies: ["comedy_button"],
      humorEffectsAllowed: false, transitionFrequency: "active", bedPolicy: "select_segments",
      introTreatment: "brand_high_energy", outroTreatment: "close_high_energy",
      minimumMusicGapMs: 1000, maximumMusicGapMs: 8000, voiceOverMusicPolicy: "allowed_when_ducked",
    });
    assert(r.ok, JSON.stringify(r));
    if (!r.ok) return;
    assert(r.identity.version === SONIC_IDENTITY_VERSION, "version stamped");
    assert(r.identity.pace === "fast" && r.identity.broadcastStyle === "sports_radio", "enums preserved");
    assert(r.identity.humorEffectsAllowed === false, "bool preserved");
  });

  check("an unknown enum value is rejected (structured error, never coerced)", () => {
    const r = validateSonicIdentity({ pace: "hyperspeed" });
    assert(!r.ok && r.error.code === "invalid_enum" && (r.error as { field: string }).field === "pace", JSON.stringify(r));
  });

  check("an unknown cue family in the identity is rejected", () => {
    const r = validateSonicIdentity({ prohibitedCueFamilies: ["not_a_family"] });
    assert(!r.ok && r.error.code === "invalid_cue_family", JSON.stringify(r));
  });

  check("min>max music gap is rejected; out-of-range gap is rejected", () => {
    assert(validateSonicIdentity({ minimumMusicGapMs: 9000, maximumMusicGapMs: 1000 }).ok === false, "order enforced");
    const r = validateSonicIdentity({ minimumMusicGapMs: -1 });
    assert(!r.ok && r.error.code === "invalid_music_gap", JSON.stringify(r));
  });

  check("the default identity is permissive (nothing prohibited)", () => {
    assert(DEFAULT_SONIC_IDENTITY.prohibitedCueFamilies.length === 0 && DEFAULT_SONIC_IDENTITY.humorEffectsAllowed, "permissive default");
  });

  check("cue families are role-scoped", () => {
    assert(isCueFamily("brand_main") && isCueFamily("hard_hit") && !isCueFamily("nope"), "family recognition");
    assert(isCueFamilyValidForRole("intro", "brand_main"), "brand_main valid for intro");
    assert(!isCueFamilyValidForRole("outro", "brand_main"), "brand_main NOT valid for outro");
    assert(!isCueFamilyValidForRole("reaction", "hard_hit"), "transition family NOT valid for reaction");
    assert(isCueFamilyValidForRole("stinger", "hard_hit"), "stinger carries transition families");
    assert(isCueFamilyValidForRole("intro", null), "null family allowed");
  });

  check("identity prohibitions block families (explicit, allow-list, humor, crowd)", () => {
    const newsId = validateSonicIdentity({ broadcastStyle: "newsroom", humorEffectsAllowed: false, crowdEffectsAllowed: false, prohibitedCueFamilies: ["hard_hit"] });
    assert(newsId.ok, "news identity valid"); if (!newsId.ok) return;
    assert(!cueFamilyAllowedByIdentity(newsId.identity, "hard_hit").ok, "explicit prohibition");
    assert(!cueFamilyAllowedByIdentity(newsId.identity, "comedy_button").ok, "humor disabled blocks comedy");
    assert(!cueFamilyAllowedByIdentity(newsId.identity, "crowd_positive").ok, "crowd disabled blocks arena");
    assert(cueFamilyAllowedByIdentity(newsId.identity, "topic_reset").ok, "neutral transition allowed");

    const allowListId = validateSonicIdentity({ allowedCueFamilies: ["brand_main"] });
    assert(allowListId.ok, "allow-list identity valid"); if (!allowListId.ok) return;
    assert(cueFamilyAllowedByIdentity(allowListId.identity, "brand_main").ok, "in allow-list");
    assert(!cueFamilyAllowedByIdentity(allowListId.identity, "close_main").ok, "not in allow-list -> blocked");
  });

  check("cue metadata validates and is authoritative ONLY when verified", () => {
    const r = validateCueMetadata({ cueFamily: "brand_main", genre: "sports", moods: ["hype"], bpm: 120, instrumentation: ["drums", "brass"], suitability: { intro: true, underSpeech: false } });
    assert(r.ok, JSON.stringify(r)); if (!r.ok) return;
    assert(r.metadata.bpm === 120 && r.metadata.suitability?.intro === true, "metadata normalized");
    assert(validateCueMetadata({ bpm: 9999 }).ok === false, "bad bpm rejected");
    // verification gating
    assert(verifiedCueMetadata({ metadataState: "verified", cueMetadata: { genre: "sports" } })?.genre === "sports", "verified is authoritative");
    assert(verifiedCueMetadata({ metadataState: "suggested", cueMetadata: { genre: "sports" } }) === null, "suggested is NOT authoritative");
    assert(verifiedCueMetadata({ metadataState: "unclassified", cueMetadata: null }) === null, "unclassified is null");
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
