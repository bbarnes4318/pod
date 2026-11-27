// Network-free regression for the customer-facing Host Studio.
// Run: npx tsx --conditions=react-server src/scripts/testHostStudioCapabilities.ts

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  compileHostStudioProfile,
  defaultHostStudioSettings,
  settingsFromHost,
} from "../lib/hosts/hostStudioProfile";
import {
  buildFishVoiceDesignBody,
  createFishVoiceModel,
  designFishVoice,
  FISH_CREATE_MODEL_URL,
  FISH_VOICE_DESIGN_URL,
} from "../lib/providers/tts/fishVoiceStudio";
import { FISH_VOICE_DESCRIPTION_MAX, FISH_VOICE_TEST_LINE_MAX } from "../lib/providers/tts/fishVoiceLimits";
import { SPORTS_CHARACTER_PACK } from "../lib/hosts/sportsCharacterPack";
import { voiceBriefForHost } from "../lib/hosts/voiceBriefs";

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function check(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve().then(fn).then(() => {
    passed++;
    console.log(`  ✓ ${name}`);
  }).catch((error) => {
    failed++;
    console.error(`  ✗ ${name}\n      ${error instanceof Error ? error.message : String(error)}`);
  });
}

const source = (path: string) => readFileSync(join(__dirname, "..", path), "utf8");

/** Source with comments removed, for checks about what a component RENDERS
 *  rather than what its author wrote about it. A comment naming a removed
 *  button is documentation, not a button. */
function withoutComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .join("\n");
}

async function main() {
  console.log("Host Studio personality + voice capabilities\n");

  await check("simple behavior choices compile into both script and TTS controls", () => {
    const settings = {
      ...defaultHostStudioSettings(),
      rolePreset: "skeptic" as const,
      belief: "Every clean public story is hiding one uncomfortable tradeoff.",
      energy: "big" as const,
      pace: "fast" as const,
      humor: "playful" as const,
      interruptions: "jumps_in" as const,
      concessions: "stubborn" as const,
      finish: "theatrical" as const,
      pressure: "quieter_sharper" as const,
      pauses: "tight" as const,
      bannedPhrases: ["At the end of the day"],
      prohibitedTraits: ["robot voice", "announcer cadence"],
    };
    const compiled = compileHostStudioProfile(settings);
    assert(/skeptic/i.test(compiled.role), "role preset did not reach the script persona");
    assert(/jumps in/i.test(compiled.speakingStyle), "interruption behavior did not reach speaking style");
    assert(compiled.performanceProfile.interruptionBehavior === "assertive", "interruption behavior did not reach TTS profile");
    assert(compiled.performanceProfile.angerStyle === "slower_quieter", "pressure behavior did not reach TTS profile");
    // Fish renders a scene in ONE request, so temperature is cast-wide and a
    // per-host control could only ever collapse. The input was removed.
    assert(compiled.performanceProfile.providerOverrides.fish === undefined, "per-host Fish sampling must no longer be authored — it cannot be applied per host");
    assert(compiled.bannedPhrases.includes("At the end of the day"), "banned phrase was lost");
    assert(compiled.performanceProfile.prohibitedTraits.includes("robot voice"), "delivery prohibition was lost");
  });

  await check("existing hosts can be opened in the simple controls without a stored UI blob", () => {
    const derived = settingsFromHost({
      role: "A stubborn former coach",
      worldview: "Effort is visible on film.",
      speakingStyle: "Fast and blunt.",
      intensityLevel: 7,
      argumentPatterns: ["Ask who missed the assignment"],
      bannedPhrases: ["It is what it is"],
      catchphrases: [],
      performanceProfile: compileHostStudioProfile({ ...defaultHostStudioSettings(), pace: "fast", interruptions: "jumps_in" }).performanceProfile,
    });
    assert(derived.pace === "fast", "pace was not derived from the existing performance profile");
    assert(derived.interruptions === "jumps_in", "interruption setting was not derived");
    assert(derived.customRole === "A stubborn former coach", "existing role was not preserved");
  });

  await check("voice design request matches Fish's current contract", () => {
    const body = buildFishVoiceDesignBody({
      instruction: "Warm middle-aged voice with dry humor",
      referenceText: "Let's get into it.",
      candidateCount: 3,
      speed: 1.1,
    });
    assert(body.instruction.includes("dry humor"), "voice instruction was lost");
    assert(body.reference_text === "Let's get into it.", "reference text was lost");
    assert(body.n === 3, "candidate count was not preserved");
    assert(body.speed === 1.1, "voice-design speed was not preserved");
  });

  await check("voice design returns playable candidates through the official endpoint", async () => {
    process.env.FISH_API_KEY = "test-key-for-host-studio";
    let called = "";
    const candidates = await designFishVoice({ instruction: "Warm and direct", referenceText: "Hello", candidateCount: 2 }, async (url, init) => {
      called = String(url);
      assert((init?.headers as Record<string, string>).model === "voice-design-1", "voice-design model header missing");
      return new Response(JSON.stringify({ candidates: [
        { id: "a", index: 0, audio_base64: "UklGRg==", sample_rate: 44100, duration_ms: 900 },
        { id: "b", index: 1, audio_base64: "UklGRg==", sample_rate: 44100, duration_ms: 920 },
      ] }), { status: 200, headers: { "content-type": "application/json" } });
    });
    assert(called === FISH_VOICE_DESIGN_URL, `wrong voice-design endpoint: ${called}`);
    assert(candidates.length === 2, "voice candidates were not returned");
  });

  await check("selected designs and authorized recordings create private Fish models", async () => {
    process.env.FISH_API_KEY = "test-key-for-host-studio";
    let called = "";
    const result = await createFishVoiceModel({
      title: "Private Host Voice",
      sourceTag: "authorized-clone",
      samples: [{ bytes: new Uint8Array([1, 2, 3]), filename: "sample.wav", contentType: "audio/wav", transcript: "hello" }],
    }, async (url, init) => {
      called = String(url);
      const form = init?.body as FormData;
      assert(form.get("visibility") === "private", "voice model was not private");
      assert(form.get("train_mode") === "fast", "fast voice creation was not requested");
      assert(form.getAll("voices").length === 1, "voice file was not uploaded");
      return new Response(JSON.stringify({ _id: "1234567890abcdef1234567890abcdef", state: "created", title: "Private Host Voice" }), { status: 201, headers: { "content-type": "application/json" } });
    });
    assert(called === FISH_CREATE_MODEL_URL, `wrong create-model endpoint: ${called}`);
    assert(result.id.length === 32, "created voice id was not returned");
  });

  // ASSERTION UPDATED for the Talent Studio reconstruction. CharacterStudio was
  // split into modules (TalentCard, TalentProfile, TalentWizard, talentModel),
  // and the four-step editor ("Who they are / How they act / Voice / Preview")
  // became five: Identity, Personality, Performance, Voice, Final review. The
  // old Preview step is now the "Preview" group inside Performance. Same fields,
  // same save actions; this checks the new labels in the file that renders them.
  await check("the default UI hides provider jargon and exposes the five simple steps", () => {
    const ui = source("app/studio/hosts/TalentWizard.tsx");
    for (const label of ["Identity", "Personality", "Performance", "Voice", "Final review", "Preview", "Design a new voice", "Clone my voice"]) {
      assert(ui.includes(label), `missing simple UI label: ${label}`);
    }
    for (const file of ["CharacterStudio.tsx", "TalentCard.tsx", "TalentWizard.tsx", "TalentProfile.tsx", "TalentInsights.tsx"]) {
      const text = source(`app/studio/hosts/${file}`);
      assert(!text.includes("TTS engine"), `${file} still exposes TTS-engine jargon`);
      assert(!text.includes("Voice id <span"), `${file} still exposes a raw voice-id form outside the advanced path`);
    }
  });

  await check("voice cloning is ownership-gated and requires explicit permission", () => {
    const actions = source("app/studio/hosts/actions.ts");
    assert(/requireOwnedHost\(hostId\)/.test(actions), "voice creation is not owner-gated");
    assert(/own this voice or have written permission/i.test(actions), "clone permission attestation is not enforced");
    assert(/visibility", "private"/.test(source("lib/providers/tts/fishVoiceStudio.ts")), "created voices are not private");
  });

  await check("EVERY host card offers Edit — a shared starter forks on the way in", () => {
    // THE REGRESSION THIS EXISTS TO PREVENT.
    //
    // The card used to render "Edit host" only when `host.canEdit` was true, and
    // "Copy and customize" otherwise. A new account owns nothing, so every host
    // on its screen was a shared starter and NOT ONE of them showed an Edit
    // button. The app looked like it could not edit a host at all. It could —
    // there is a four-step editor behind that button, voice step included — but
    // no path led to it, which is the same thing as not having it.
    //
    // So: the button is unconditional. If the underlying host is shared, the
    // handler clones it first and opens the COPY. The gate that remains is on
    // the DATA (a shared host is still never mutated in place), not on the
    // user's ability to get where they were going.
    // File paths updated for the Talent Studio split: the button lives on the
    // card (TalentCard.tsx) and on the profile; the fork itself moved, unchanged,
    // into the shared `useEditHost` hook in talentModel.ts so both use one copy.
    const ui = source("app/studio/hosts/TalentCard.tsx");
    const hook = source("app/studio/hosts/talentModel.ts");
    // Comments stripped first: this check is about what the card RENDERS, and a
    // comment explaining the old button is not the old button. Checking raw
    // source would make the prose below fail its own test.
    const rendered = withoutComments(ui);
    assert(
      !rendered.includes("Copy and customize"),
      "the card still routes shared hosts to a 'Copy and customize' button instead of Edit"
    );
    assert(
      /onClick=\{editHost\}/.test(ui),
      "the card's edit button no longer goes through editHost, which is what performs the fork"
    );
    assert(
      /onClick=\{editHost\}/.test(source("app/studio/hosts/TalentProfile.tsx")),
      "the profile's edit button no longer goes through editHost"
    );
    // The fork must open the COPY. Passing the clone's id back is the whole
    // mechanism; without it the editor opens on the starter and saves nothing.
    assert(
      /onEdit\(result\.hostId\)/.test(hook),
      "editHost does not open the newly created copy — the fork would be invisible"
    );
    assert(
      /if \(host\.canEdit\) \{\s*onEdit\(\);/.test(hook),
      "an already-owned host should open directly, with no pointless clone"
    );
    // And the server action has to keep handing the id back for any of it to work.
    assert(
      /return \{ success: true as const, hostId: copy\.id \}/.test(source("app/studio/hosts/actions.ts")),
      "cloneHostToRoster no longer returns the new host id"
    );
  });

  await check("every catalog character's voice brief is accepted by Fish Voice Design as written", () => {
    // Five briefs once shipped test lines over Fish's 150-character limit: the
    // designer would have failed for those characters on the first click.
    assert(SPORTS_CHARACTER_PACK.length === 16, `expected 16 catalog characters, found ${SPORTS_CHARACTER_PACK.length}`);
    for (const character of SPORTS_CHARACTER_PACK) {
      const { description, previewText } = character.fishVoiceDesign;
      assert(description.trim().length > 0 && description.length <= FISH_VOICE_DESCRIPTION_MAX, `${character.slug}: description is ${description.length} chars`);
      assert(previewText.length <= FISH_VOICE_TEST_LINE_MAX, `${character.slug}: test line is ${previewText.length} chars (max ${FISH_VOICE_TEST_LINE_MAX})`);
      const body = buildFishVoiceDesignBody({ instruction: description, referenceText: previewText, candidateCount: 3 });
      assert(body.instruction === description.trim() && body.reference_text === previewText.trim(), `${character.slug}: brief was altered`);
    }
  });

  await check("a catalog character opens the voice designer with its own brief", () => {
    const rocco = SPORTS_CHARACTER_PACK.find((character) => character.slug === "rocco-vale")!;
    const seeded = voiceBriefForHost({ slug: "rocco-vale", name: "Rocco Vale" });
    assert(seeded?.description === rocco.fishVoiceDesign.description, "seeded slug did not find the brief");
    assert(seeded?.testLine === rocco.fishVoiceDesign.previewText, "seeded slug returned the wrong test line");
    assert(voiceBriefForHost({ slug: "rocco-vale-1a2b3c", name: "Rocco Vale" })?.description === rocco.fishVoiceDesign.description, "a roster copy lost the brief");
    assert(voiceBriefForHost({ slug: null, name: "rocco vale" }) !== null, "name fallback failed");
    assert(voiceBriefForHost({ slug: "my-own-host", name: "My Own Host" }) === null, "a non-catalog host was given a catalog brief");
    const page = source("app/studio/hosts/page.tsx");
    assert(/voiceBrief: voiceBriefForHost\(/.test(page), "the hosts page no longer passes the brief to the UI");
  });

  await check("a host without a voice gets Create voice on its card, saved straight to Fish", () => {
    // Path updated: the card moved to TalentCard.tsx in the Talent Studio split.
    const ui = withoutComments(source("app/studio/hosts/TalentCard.tsx"));
    assert(ui.includes("Create voice"), "the card has no Create voice button");
    assert(/<VoiceDesigner[\s\S]*?brief=\{host\.voiceBrief\}/.test(ui), "the card's designer is not given the character's brief");
    assert(/saveDesignedHostVoice\(host\.id/.test(ui), "the card does not save the picked take as the host's voice");
    assert(/previewText: selection\.testLine/.test(ui), "the saved voice is not trained on the words the take actually spoke");
    const designer = source("app/studio/hosts/VoiceDesigner.tsx");
    assert(/designHostVoice\(/.test(designer), "the designer does not call Fish Voice Design");
    assert(designer.includes("Create 3 more takes"), "the designer cannot ask for more takes");
  });

  await check("only a host with a real voice can be put on air, and only by its owner", () => {
    const actions = source("app/studio/hosts/actions.ts");
    const fn = actions.slice(actions.indexOf("export async function setHostOnAir"));
    assert(fn.length > 0 && /requireOwnedHost\(hostId\)/.test(fn.slice(0, 400)), "setHostOnAir is not owner-gated");
    assert(/FISH_DESIGN_PENDING/.test(fn.slice(0, 1400)), "setHostOnAir does not refuse a catalog placeholder voice");
    assert(/isVoiceIdValidForProvider\(host\.ttsProvider, host\.ttsVoiceId\)/.test(fn.slice(0, 1400)), "setHostOnAir does not check the voice id");
    assert(/setHostOnAir\(host\.id, !host\.isActive\)/.test(source("app/studio/hosts/TalentCard.tsx")), "the card has no on-air switch");
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
