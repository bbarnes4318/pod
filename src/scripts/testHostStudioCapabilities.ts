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
import { compactFishDeliveryCue } from "../lib/providers/tts/fishDialogue";

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

  await check("Fish receives a compact per-host delivery cue, not generic chair behavior", () => {
    const settings = { ...defaultHostStudioSettings(), pace: "fast" as const, energy: "big" as const };
    const compiled = compileHostStudioProfile(settings);
    const cue = compactFishDeliveryCue({
      speakerHostId: "host-test",
      formatRoleId: "chair_b",
      direction: `Delivery style: ${compiled.speakingStyle} This is a conversation.`,
      intensityLevel: compiled.performanceProfile.peakIntensity,
      angerStyle: compiled.performanceProfile.angerStyle,
      maxCueDensity: compiled.performanceProfile.maxCueDensity,
      profileVersion: 1,
      providerOverrides: compiled.performanceProfile.providerOverrides.fish,
    });
    assert(!!cue, "Fish delivery cue was not generated");
    assert(/fast and immediate/i.test(cue), `pace was not present in Fish cue: ${cue}`);
    assert(/never reads or announces/i.test(cue), `anti-reader instruction was not present: ${cue}`);
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

  await check("the default UI hides provider jargon and exposes the four simple steps", () => {
    const ui = source("app/studio/hosts/CharacterStudio.tsx");
    for (const label of ["Who they are", "How they act", "Voice", "Preview", "Design a new voice", "Clone my voice"]) {
      assert(ui.includes(label), `missing simple UI label: ${label}`);
    }
    assert(!ui.includes("TTS engine"), "default UI still exposes TTS-engine jargon");
    assert(!ui.includes("Voice id <span"), "default UI still exposes a raw voice-id form outside the advanced path");
  });

  await check("voice cloning is ownership-gated and requires explicit permission", () => {
    const actions = source("app/studio/hosts/actions.ts");
    assert(/requireOwnedHost\(hostId\)/.test(actions), "voice creation is not owner-gated");
    assert(/own this voice or have written permission/i.test(actions), "clone permission attestation is not enforced");
    assert(/visibility", "private"/.test(source("lib/providers/tts/fishVoiceStudio.ts")), "created voices are not private");
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
