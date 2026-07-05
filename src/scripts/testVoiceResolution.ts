// Unit tests for the centralized provider-aware TTS voice resolution.
// Run with: npm run test:voice-resolution
// No DB or network needed — pure functions plus process.env manipulation.

import {
  resolveTtsProviderAndVoice,
  validateTtsVoiceOverridesInput,
  HostVoiceContext,
} from "../lib/providers/tts/voiceResolution";

let passed = 0;
let failed = 0;

function check(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err: any) {
    failed++;
    console.error(`  ✗ ${name}\n      ${err.message}`);
  }
}

function assertEqual(actual: unknown, expected: unknown, label = "value") {
  if (actual !== expected) {
    throw new Error(`expected ${label} '${String(expected)}', got '${String(actual)}'`);
  }
}

function assertThrows(fn: () => void, includes: string) {
  try {
    fn();
  } catch (err: any) {
    if (!String(err.message).includes(includes)) {
      throw new Error(`threw, but message '${err.message}' does not include '${includes}'`);
    }
    return;
  }
  throw new Error(`expected an error including '${includes}', but nothing was thrown`);
}

const VOICE_ENV_VARS = [
  "TTS_PROVIDER",
  "BOSON_MAX_VOLTAGE_VOICE_ID", "BOSON_DR_LINEBREAK_VOICE_ID", "BOSON_TTS_VOICE",
  "FISH_MAX_VOLTAGE_VOICE_ID", "FISH_DR_LINEBREAK_VOICE_ID", "FISH_TTS_VOICE",
  "ELEVENLABS_MAX_VOLTAGE_VOICE_ID", "ELEVENLABS_DR_LINEBREAK_VOICE_ID", "ELEVENLABS_VOICE_ID",
  "CARTESIA_MAX_VOLTAGE_VOICE_ID", "CARTESIA_DR_LINEBREAK_VOICE_ID", "CARTESIA_VOICE_ID",
  "OPENAI_MAX_VOLTAGE_VOICE", "OPENAI_DR_LINEBREAK_VOICE", "OPENAI_TTS_VOICE",
];

function clearVoiceEnv() {
  for (const v of VOICE_ENV_VARS) delete process.env[v];
}

const ELEVEN_ID = "21m00Tcm4TlvDq8ikWAM";
const FISH_ID = "0123456789abcdef0123456789abcdef";
const BOSON_ID = "a7f5f188-3e51-440b-9364-4d06098e3671";

const maxVoltage: HostVoiceContext = {
  id: "host-a-id",
  slug: "max-voltage",
  name: "Max Voltage",
  ttsProvider: "elevenlabs",
  ttsVoiceId: ELEVEN_ID,
};

const drLinebreak: HostVoiceContext = {
  id: "host-b-id",
  slug: "dr-linebreak",
  name: "Dr. Linebreak",
  ttsProvider: "elevenlabs",
  ttsVoiceId: ELEVEN_ID,
};

console.log("Provider resolution order:");

check("trigger override beats episode, host, and env", () => {
  clearVoiceEnv();
  process.env.TTS_PROVIDER = "cartesia";
  process.env.BOSON_TTS_VOICE = "belinda";
  const r = resolveTtsProviderAndVoice({
    providerOverride: "boson",
    episodeProvider: "fish",
    host: maxVoltage,
    envProvider: process.env.TTS_PROVIDER,
  });
  assertEqual(r.provider, "boson", "provider");
});

check("episode provider beats host and env", () => {
  clearVoiceEnv();
  const r = resolveTtsProviderAndVoice({
    episodeProvider: "boson",
    host: maxVoltage,
    envProvider: "cartesia",
  });
  assertEqual(r.provider, "boson", "provider");
});

check("host provider (non-stub) beats env", () => {
  clearVoiceEnv();
  const r = resolveTtsProviderAndVoice({ host: maxVoltage, envProvider: "cartesia" });
  assertEqual(r.provider, "elevenlabs", "provider");
});

check("host provider 'stub' means unset and falls through to env", () => {
  clearVoiceEnv();
  process.env.BOSON_TTS_VOICE = "belinda";
  const r = resolveTtsProviderAndVoice({
    host: { ...maxVoltage, ttsProvider: "stub" },
    envProvider: "boson",
  });
  assertEqual(r.provider, "boson", "provider");
});

console.log("Voice resolution (provider-aware):");

check("episode voice override used when its provider matches", () => {
  clearVoiceEnv();
  const r = resolveTtsProviderAndVoice({
    episodeProvider: "boson",
    episodeVoiceOverrides: { "max-voltage": { provider: "boson", voiceId: BOSON_ID, voiceName: "Growler" } },
    host: maxVoltage,
  });
  assertEqual(r.voiceId, BOSON_ID, "voiceId");
  assertEqual(r.voiceSource, "episode_override", "voiceSource");
  assertEqual(r.voiceName, "Growler", "voiceName");
});

check("run voice override beats episode voice override", () => {
  clearVoiceEnv();
  const r = resolveTtsProviderAndVoice({
    providerOverride: "boson",
    runVoiceOverrides: { "max-voltage": { provider: "boson", voiceId: "run-voice" } },
    episodeVoiceOverrides: { "max-voltage": { provider: "boson", voiceId: BOSON_ID } },
    host: maxVoltage,
  });
  assertEqual(r.voiceId, "run-voice", "voiceId");
  assertEqual(r.voiceSource, "run_override", "voiceSource");
});

check("override for a DIFFERENT provider is ignored (no cross-engine voice)", () => {
  clearVoiceEnv();
  const r = resolveTtsProviderAndVoice({
    providerOverride: "boson",
    episodeVoiceOverrides: { "max-voltage": { provider: "elevenlabs", voiceId: ELEVEN_ID } },
    host: { ...maxVoltage, ttsProvider: "boson", ttsVoiceId: BOSON_ID },
  });
  assertEqual(r.voiceId, BOSON_ID, "voiceId (host default, not the ElevenLabs override)");
  assertEqual(r.voiceSource, "host_default", "voiceSource");
});

check("host ElevenLabs voice id is NOT sent to Boson (safe default instead)", () => {
  clearVoiceEnv();
  const r = resolveTtsProviderAndVoice({ providerOverride: "boson", host: maxVoltage });
  assertEqual(r.provider, "boson", "provider");
  assertEqual(r.voiceId, "default", "voiceId");
  assertEqual(r.voiceSource, "provider_default", "voiceSource");
});

check("host voice used only when host engine matches resolved provider", () => {
  clearVoiceEnv();
  const r = resolveTtsProviderAndVoice({ host: maxVoltage, envProvider: undefined });
  assertEqual(r.provider, "elevenlabs", "provider");
  assertEqual(r.voiceId, ELEVEN_ID, "voiceId");
  assertEqual(r.voiceSource, "host_default", "voiceSource");
});

check("ElevenLabs/Boson ids never become a Fish reference_id", () => {
  clearVoiceEnv();
  const r = resolveTtsProviderAndVoice({
    providerOverride: "fish",
    episodeVoiceOverrides: { "max-voltage": { provider: "fish", voiceId: BOSON_ID } }, // not 32-hex
    host: { ...maxVoltage, ttsProvider: "fish", ttsVoiceId: ELEVEN_ID }, // not 32-hex either
  });
  assertEqual(r.voiceId, "", "voiceId (engine default, nothing invalid sent)");
  assertEqual(r.voiceSource, "provider_default", "voiceSource");
});

check("Fish accepts a valid 32-hex reference id from an episode override", () => {
  clearVoiceEnv();
  const r = resolveTtsProviderAndVoice({
    providerOverride: "fish",
    episodeVoiceOverrides: { "max-voltage": { provider: "fish", voiceId: FISH_ID } },
    host: maxVoltage,
  });
  assertEqual(r.voiceId, FISH_ID, "voiceId");
  assertEqual(r.voiceSource, "episode_override", "voiceSource");
});

check("Boson accepts a manual voice id and 'default'", () => {
  clearVoiceEnv();
  const custom = resolveTtsProviderAndVoice({
    providerOverride: "boson",
    runVoiceOverrides: { "max-voltage": { provider: "boson", voiceId: BOSON_ID } },
    host: maxVoltage,
  });
  assertEqual(custom.voiceId, BOSON_ID, "custom voiceId");
  const dflt = resolveTtsProviderAndVoice({
    providerOverride: "boson",
    runVoiceOverrides: { "dr-linebreak": { provider: "boson", voiceId: "default" } },
    host: drLinebreak,
  });
  assertEqual(dflt.voiceId, "default", "default voiceId");
  assertEqual(dflt.voiceSource, "run_override", "voiceSource");
});

check("per-host env fallback applies when no override/host voice matches", () => {
  clearVoiceEnv();
  process.env.BOSON_DR_LINEBREAK_VOICE_ID = "belinda";
  const r = resolveTtsProviderAndVoice({ providerOverride: "boson", host: drLinebreak });
  assertEqual(r.voiceId, "belinda", "voiceId");
  assertEqual(r.voiceSource, "env_default", "voiceSource");
});

check("overrides keyed by host id also resolve (slug preferred)", () => {
  clearVoiceEnv();
  const r = resolveTtsProviderAndVoice({
    providerOverride: "boson",
    episodeVoiceOverrides: { "host-a-id": { provider: "boson", voiceId: BOSON_ID } },
    host: maxVoltage,
  });
  assertEqual(r.voiceId, BOSON_ID, "voiceId");
});

check("ElevenLabs with no usable voice fails with a clear message", () => {
  clearVoiceEnv();
  assertThrows(
    () =>
      resolveTtsProviderAndVoice({
        providerOverride: "elevenlabs",
        host: { ...maxVoltage, ttsProvider: "boson", ttsVoiceId: BOSON_ID },
      }),
    "No voice ID configured for provider elevenlabs and host Max Voltage"
  );
});

check("OpenAI: valid name accepted, invalid name falls through to safe default", () => {
  clearVoiceEnv();
  const good = resolveTtsProviderAndVoice({
    providerOverride: "openai",
    runVoiceOverrides: { "max-voltage": { provider: "openai", voiceId: "Onyx" } },
    host: maxVoltage,
  });
  assertEqual(good.voiceId, "onyx", "voiceId (normalized)");
  const bad = resolveTtsProviderAndVoice({
    providerOverride: "openai",
    runVoiceOverrides: { "max-voltage": { provider: "openai", voiceId: "not-a-voice" } },
    host: maxVoltage,
  });
  assertEqual(bad.voiceId, "alloy", "voiceId (safe default)");
  assertEqual(bad.voiceSource, "provider_default", "voiceSource");
});

check("stub resolution never throws", () => {
  clearVoiceEnv();
  const r = resolveTtsProviderAndVoice({ host: { ...maxVoltage, ttsProvider: "stub" } });
  assertEqual(r.provider, "stub", "provider");
});

console.log("Input validation (server-action boundary):");

check("valid overrides normalize and pass through", () => {
  const v = validateTtsVoiceOverridesInput({
    "max-voltage": { provider: "Boson", voiceId: ` ${BOSON_ID} `, voiceName: "Growler" },
  });
  assertEqual(v?.["max-voltage"].provider, "boson", "provider");
  assertEqual(v?.["max-voltage"].voiceId, BOSON_ID, "voiceId");
});

check("unknown provider is rejected", () => {
  assertThrows(
    () => validateTtsVoiceOverridesInput({ "max-voltage": { provider: "acme", voiceId: "x" } }),
    "unknown TTS provider"
  );
});

check("non-32-hex Fish reference id is rejected", () => {
  assertThrows(
    () => validateTtsVoiceOverridesInput({ "max-voltage": { provider: "fish", voiceId: ELEVEN_ID } }),
    "32-character hex"
  );
});

check("unknown OpenAI voice name is rejected", () => {
  assertThrows(
    () => validateTtsVoiceOverridesInput({ "max-voltage": { provider: "openai", voiceId: "brian" } }),
    "OpenAI voice must be one of"
  );
});

check("empty picks collapse to undefined", () => {
  assertEqual(validateTtsVoiceOverridesInput({ "max-voltage": { provider: "boson", voiceId: "  " } }), undefined);
  assertEqual(validateTtsVoiceOverridesInput(undefined), undefined);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
