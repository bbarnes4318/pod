// Host Bible v8 — baseball cast landing contracts.
//
// Guards the silent-inheritance and silent-discard paths that a roster swap
// opens up, none of which surface as an error at render time:
//   - seat A inheriting the OUTGOING host's clone (array index, or an
//     identity-named env var belonging to a retired host),
//   - a retired host's real name going unguarded because the slug is a
//     nickname that does not contain it,
//   - a retired slug emitting an ordinary baseball word as a banned fragment,
//   - the 210-char cue budget truncating direction before it reaches Fish.
//
// NETWORK-FREE. Run: npm run test:baseball-cast

import {
  PLACEHOLDER_HOST_A_VOICE_ID,
  PLACEHOLDER_VOICE_ID,
  RETIRED_HOST_SLUGS,
  SEED_HOSTS,
  VANDERGRIFT_PROFILE,
  FETTIG_PROFILE,
  resolveSeatAVoice,
  resolveSeatBVoice,
  retiredHostNameFragments,
} from "../lib/hosts/roster";
import { hostPerformanceProfileSchema, resolveHostPerformanceProfile } from "../lib/hosts/performanceProfile";
import { buildPerformanceDirection } from "../lib/audio/performanceDirection";
import { compactFishDeliveryCue } from "../lib/providers/tts/fishDialogue";

let passed = 0, failed = 0;
function check(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.error(`  ✗ ${name}\n      ${(err as Error).message}`); }
}
function assert(c: boolean, m: string) { if (!c) throw new Error(m); }

const PLACEHOLDER_RE = /^PLACEHOLDER[_-]/i; // must match rssPublishingService.ts

function main() {
  console.log("\nSeating and identity\n");

  check("the roster is exactly Vandergrift (seat A) then Fettig (seat B)", () => {
    assert(SEED_HOSTS.length === 2, `expected 2 hosts, got ${SEED_HOSTS.length}`);
    assert(SEED_HOSTS[0].slug === "marisol-vandergrift", `index 0 must be Vandergrift, got ${SEED_HOSTS[0].slug}`);
    assert(SEED_HOSTS[1].slug === "ambrose-fettig", `index 1 must be Fettig, got ${SEED_HOSTS[1].slug}`);
  });

  check("the intensity gap keeps Vandergrift in chair A", () => {
    // hostCastingShared assigns chair A with `iInt >= jInt`, a STRICT numeric
    // comparison, so any positive gap is deterministic. The previous roster
    // asserted a gap of >= 2; that was margin, not a requirement of the code.
    // 9 vs 8 is the authored seating and it is sufficient.
    const gap = SEED_HOSTS[0].intensityLevel - SEED_HOSTS[1].intensityLevel;
    assert(gap > 0, `seat A must outrank seat B, gap was ${gap}`);
    assert(SEED_HOSTS[1].intensityLevel <= 8, "raising Fettig above 8 would move him into chair A");
  });

  check("neither new host can publish until a real voice is cast", () => {
    for (const host of SEED_HOSTS) {
      assert(PLACEHOLDER_RE.test(host.ttsVoiceId),
        `${host.name} ships on '${host.ttsVoiceId}', which rssPublishingService would NOT block`);
    }
  });

  check("seat A falls back to its own placeholder, never to whoever is first", () => {
    assert(resolveSeatAVoice({} as unknown as NodeJS.ProcessEnv) === PLACEHOLDER_HOST_A_VOICE_ID,
      "an unconfigured seat A must resolve to the publish-blocking placeholder");
    assert(String(PLACEHOLDER_HOST_A_VOICE_ID) !== String(PLACEHOLDER_VOICE_ID), "the two seats need distinct sentinels");
  });

  check("a retired host's identity env var cannot voice the incoming seat-A host", () => {
    // FISH_ZABALA_VOICE_ID names a host who is now retired. Honouring it would
    // hand Vandergrift Zabala's clone — silent inheritance via the environment.
    const env = { FISH_ZABALA_VOICE_ID: "c176f96ab88b4fb39f74e19165bacbdc" } as unknown as NodeJS.ProcessEnv;
    assert(resolveSeatAVoice(env) === PLACEHOLDER_HOST_A_VOICE_ID,
      "a retired host's identity var must be ignored, not inherited");
    const seat = { FISH_HOST_A_VOICE_ID: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" } as unknown as NodeJS.ProcessEnv;
    assert(resolveSeatAVoice(seat) === "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "the seat-keyed var must still win");
  });

  check("seat B still resolves through its documented precedence", () => {
    assert(resolveSeatBVoice(null, {} as NodeJS.ProcessEnv).voiceId === PLACEHOLDER_VOICE_ID, "fresh env → placeholder");
    assert(resolveSeatBVoice("36780e7121b84d5c9c24cbd2f15eaaa4", {} as NodeJS.ProcessEnv).voiceId === "36780e7121b84d5c9c24cbd2f15eaaa4",
      "a real stored voice must be preserved across a reseed");
  });

  console.log("\nRetiring the previous pair\n");

  check("both retired slugs are registered", () => {
    for (const slug of ["bernie-line-two", "cal-red-eye-mercer"]) {
      assert(RETIRED_HOST_SLUGS.includes(slug), `${slug} must be retired so the seed archives it`);
    }
  });

  check("the retired pair's real NAMES are guarded, not just their slugs", () => {
    const fragments = retiredHostNameFragments();
    // The slug is a nickname; mining it alone would never yield her surname.
    assert(fragments.includes("zabala"), "'zabala' must be guarded — her slug does not contain it");
    assert(fragments.includes("mercer"), "'mercer' must be guarded");
  });

  check("retiring them does NOT ban ordinary baseball English", () => {
    const fragments = retiredHostNameFragments();
    for (const word of ["line", "eyes"]) {
      assert(!fragments.includes(word),
        `'${word}' became a banned fragment — every baseball script mentioning a line drive would be held`);
    }
  });

  console.log("\nProfiles reach the engine intact\n");

  check("both authored profiles validate against the real schema", () => {
    for (const [label, profile] of [["Vandergrift", VANDERGRIFT_PROFILE], ["Fettig", FETTIG_PROFILE]] as const) {
      const parsed = hostPerformanceProfileSchema.safeParse(profile);
      assert(parsed.success, `${label} profile must validate: ${JSON.stringify(parsed.error?.issues)}`);
    }
  });

  check("stored profiles are used, not silently replaced by derived ones", () => {
    for (const host of SEED_HOSTS) {
      const { source } = resolveHostPerformanceProfile(host.performanceProfile, host);
      assert(source === "stored", `${host.name} fell back to a '${source}' profile — the authored performance is gone`);
    }
  });

  check("the acoustic inverse survives into the Fish cue", () => {
    const cueFor = (i: number) => {
      const host = SEED_HOSTS[i];
      const { profile } = resolveHostPerformanceProfile(host.performanceProfile, host);
      return compactFishDeliveryCue({
        speakerHostId: host.slug,
        formatRoleId: i === 0 ? "chair_a" : "chair_b",
        direction: buildPerformanceDirection({
          formatId: "two_host_debate", roleId: i === 0 ? "chair_a" : "chair_b",
          host: { name: host.name, speakingStyle: host.speakingStyle },
          profile, sceneType: "argument_escalation",
        }),
        intensityLevel: profile.peakIntensity, angerStyle: profile.angerStyle,
        maxCueDensity: profile.maxCueDensity, profileVersion: 1,
      })!;
    };
    const a = cueFor(0), b = cueFor(1);
    assert(/never louder/i.test(a), `Vandergrift's cue must carry the downward anger branch: ${a}`);
    assert(!/never louder/i.test(b), `Fettig must NOT inherit the quiet-anger branch: ${b}`);
    assert(a !== b, "the two hosts must not receive the same cue");
  });

  check("the 210-char cue budget lands DIRECTION, not accent", () => {
    for (const host of SEED_HOSTS) {
      const { profile } = resolveHostPerformanceProfile(host.performanceProfile, host);
      const cue = compactFishDeliveryCue({
        speakerHostId: host.slug, formatRoleId: "chair_a",
        direction: buildPerformanceDirection({
          formatId: "two_host_debate", roleId: "chair_a",
          host: { name: host.name, speakingStyle: host.speakingStyle },
          profile, sceneType: "cold_open",
        }),
        intensityLevel: profile.peakIntensity, angerStyle: profile.angerStyle,
        maxCueDensity: profile.maxCueDensity, profileVersion: 1,
      })!;
      // The accent sentence is authored LAST precisely so it truncates first.
      assert(!/accent is/i.test(cue), `${host.name}'s accent sentence reached the cue, crowding out direction: ${cue}`);
      assert(/Play (her|him)/i.test(cue), `${host.name}'s opening direction did not survive: ${cue}`);
    }
  });

  check("no fragment instruction is authored into either speaking style", () => {
    for (const host of SEED_HOSTS) {
      assert(!/\bfragment/i.test(host.speakingStyle),
        `${host.name}'s speakingStyle instructs fragments — that produced 27% verbless sentences last time`);
      assert(/contraction/i.test(host.speakingStyle), `${host.name} must carry an explicit contraction instruction`);
    }
  });

  check("neither host carries a catchphrase that could be spoken out of context", () => {
    for (const host of SEED_HOSTS) {
      assert(host.catchphrases.length === 0, `${host.name} has catchphrases; the last roster literally said "Line two." on air`);
    }
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main();
