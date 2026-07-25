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
  "BOSON_HOST_A_VOICE_ID", "BOSON_HOST_B_VOICE_ID", "BOSON_HOST_C_VOICE_ID", "BOSON_HOST_D_VOICE_ID",
  "FISH_HOST_A_VOICE_ID", "FISH_HOST_B_VOICE_ID", "FISH_HOST_C_VOICE_ID", "FISH_HOST_D_VOICE_ID",
  "ELEVENLABS_HOST_A_VOICE_ID", "ELEVENLABS_HOST_B_VOICE_ID",
  "CARTESIA_HOST_A_VOICE_ID", "CARTESIA_HOST_B_VOICE_ID",
  "OPENAI_HOST_A_VOICE_ID", "OPENAI_HOST_B_VOICE_ID",
  "FISH_VOICE_ID_BERNIE_LINE_TWO", "FISH_VOICE_ID_RAY_FORTY_ONE",
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

const zabala: HostVoiceContext = {
  id: "host-a-id",
  slug: "bernie-line-two",
  name: 'Bernadette "Line Two" Zabala',
  ttsProvider: "elevenlabs",
  ttsVoiceId: ELEVEN_ID,
  seatIndex: 0,
};

const meachum: HostVoiceContext = {
  id: "host-b-id",
  slug: "ray-forty-one",
  name: 'Ray "Forty-One" Meachum',
  ttsProvider: "elevenlabs",
  ttsVoiceId: ELEVEN_ID,
  seatIndex: 1,
};

/** Capture console.warn for the duration of fn. The silent fallthrough onto a
 *  shared voice is the bug this module exists to make loud, so the warning is
 *  behavior worth asserting. */
function captureWarnings(fn: () => void): string[] {
  const seen: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    seen.push(args.map(String).join(" "));
  };
  try {
    fn();
  } finally {
    console.warn = original;
  }
  return seen;
}

console.log("Provider resolution order:");

check("trigger override beats episode, host, and env", () => {
  clearVoiceEnv();
  process.env.TTS_PROVIDER = "cartesia";
  process.env.BOSON_TTS_VOICE = "belinda";
  const r = resolveTtsProviderAndVoice({
    providerOverride: "boson",
    episodeProvider: "fish",
    host: zabala,
    envProvider: process.env.TTS_PROVIDER,
  });
  assertEqual(r.provider, "boson", "provider");
});

check("episode provider beats host and env", () => {
  clearVoiceEnv();
  const r = resolveTtsProviderAndVoice({
    episodeProvider: "boson",
    host: zabala,
    envProvider: "cartesia",
  });
  assertEqual(r.provider, "boson", "provider");
});

check("host provider (non-stub) beats env", () => {
  clearVoiceEnv();
  const r = resolveTtsProviderAndVoice({ host: zabala, envProvider: "cartesia" });
  assertEqual(r.provider, "elevenlabs", "provider");
});

check("host provider 'stub' means unset and falls through to env", () => {
  clearVoiceEnv();
  process.env.BOSON_TTS_VOICE = "belinda";
  const r = resolveTtsProviderAndVoice({
    host: { ...zabala, ttsProvider: "stub" },
    envProvider: "boson",
  });
  assertEqual(r.provider, "boson", "provider");
});

console.log("Voice resolution (provider-aware):");

check("episode voice override used when its provider matches", () => {
  clearVoiceEnv();
  const r = resolveTtsProviderAndVoice({
    episodeProvider: "boson",
    episodeVoiceOverrides: { "bernie-line-two": { provider: "boson", voiceId: BOSON_ID, voiceName: "Growler" } },
    host: zabala,
  });
  assertEqual(r.voiceId, BOSON_ID, "voiceId");
  assertEqual(r.voiceSource, "episode_override", "voiceSource");
  assertEqual(r.voiceName, "Growler", "voiceName");
});

check("run voice override beats episode voice override", () => {
  clearVoiceEnv();
  const r = resolveTtsProviderAndVoice({
    providerOverride: "boson",
    runVoiceOverrides: { "bernie-line-two": { provider: "boson", voiceId: "run-voice" } },
    episodeVoiceOverrides: { "bernie-line-two": { provider: "boson", voiceId: BOSON_ID } },
    host: zabala,
  });
  assertEqual(r.voiceId, "run-voice", "voiceId");
  assertEqual(r.voiceSource, "run_override", "voiceSource");
});

check("override for a DIFFERENT provider is ignored (no cross-engine voice)", () => {
  clearVoiceEnv();
  const r = resolveTtsProviderAndVoice({
    providerOverride: "boson",
    episodeVoiceOverrides: { "bernie-line-two": { provider: "elevenlabs", voiceId: ELEVEN_ID } },
    host: { ...zabala, ttsProvider: "boson", ttsVoiceId: BOSON_ID },
  });
  assertEqual(r.voiceId, BOSON_ID, "voiceId (host default, not the ElevenLabs override)");
  assertEqual(r.voiceSource, "host_default", "voiceSource");
});

check("host ElevenLabs voice id is NOT sent to Boson (safe default instead)", () => {
  clearVoiceEnv();
  const r = resolveTtsProviderAndVoice({ providerOverride: "boson", host: zabala });
  assertEqual(r.provider, "boson", "provider");
  assertEqual(r.voiceId, "default", "voiceId");
  assertEqual(r.voiceSource, "provider_default", "voiceSource");
});

check("host voice used only when host engine matches resolved provider", () => {
  clearVoiceEnv();
  const r = resolveTtsProviderAndVoice({ host: zabala, envProvider: undefined });
  assertEqual(r.provider, "elevenlabs", "provider");
  assertEqual(r.voiceId, ELEVEN_ID, "voiceId");
  assertEqual(r.voiceSource, "host_default", "voiceSource");
});

check("ElevenLabs/Boson ids never become a Fish reference_id", () => {
  clearVoiceEnv();
  const r = resolveTtsProviderAndVoice({
    providerOverride: "fish",
    episodeVoiceOverrides: { "bernie-line-two": { provider: "fish", voiceId: BOSON_ID } }, // not 32-hex
    host: { ...zabala, ttsProvider: "fish", ttsVoiceId: ELEVEN_ID }, // not 32-hex either
  });
  assertEqual(r.voiceId, "", "voiceId (engine default, nothing invalid sent)");
  assertEqual(r.voiceSource, "provider_default", "voiceSource");
});

check("Fish accepts a valid 32-hex reference id from an episode override", () => {
  clearVoiceEnv();
  const r = resolveTtsProviderAndVoice({
    providerOverride: "fish",
    episodeVoiceOverrides: { "bernie-line-two": { provider: "fish", voiceId: FISH_ID } },
    host: zabala,
  });
  assertEqual(r.voiceId, FISH_ID, "voiceId");
  assertEqual(r.voiceSource, "episode_override", "voiceSource");
});

check("Boson accepts a manual voice id and 'default'", () => {
  clearVoiceEnv();
  const custom = resolveTtsProviderAndVoice({
    providerOverride: "boson",
    runVoiceOverrides: { "bernie-line-two": { provider: "boson", voiceId: BOSON_ID } },
    host: zabala,
  });
  assertEqual(custom.voiceId, BOSON_ID, "custom voiceId");
  const dflt = resolveTtsProviderAndVoice({
    providerOverride: "boson",
    runVoiceOverrides: { "ray-forty-one": { provider: "boson", voiceId: "default" } },
    host: meachum,
  });
  assertEqual(dflt.voiceId, "default", "default voiceId");
  assertEqual(dflt.voiceSource, "run_override", "voiceSource");
});

check("per-host env fallback applies when no override/host voice matches", () => {
  clearVoiceEnv();
  process.env.BOSON_DR_LINEBREAK_VOICE_ID = "belinda";
  const r = resolveTtsProviderAndVoice({ providerOverride: "boson", host: meachum });
  assertEqual(r.voiceId, "belinda", "voiceId");
  assertEqual(r.voiceSource, "env_default", "voiceSource");
});

console.log("Seat-keyed env fallbacks:");

const FISH_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const FISH_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const FISH_SHARED = "cccccccccccccccccccccccccccccccc";
const FISH_SLUG = "dddddddddddddddddddddddddddddddd";

/** A host with no usable voice of their own, so resolution reaches the env
 *  layer. Seat comes from the argument. */
const seated = (seatIndex: number | undefined, over: Partial<HostVoiceContext> = {}): HostVoiceContext => ({
  id: "seated-id",
  slug: "some-host",
  name: "Some Host",
  ttsProvider: "fish",
  ttsVoiceId: null,
  seatIndex,
  ...over,
});

check("seat 0 picks FISH_HOST_A_VOICE_ID", () => {
  clearVoiceEnv();
  process.env.FISH_HOST_A_VOICE_ID = FISH_A;
  process.env.FISH_HOST_B_VOICE_ID = FISH_B;
  const r = resolveTtsProviderAndVoice({ providerOverride: "fish", host: seated(0) });
  assertEqual(r.voiceId, FISH_A, "voiceId");
  assertEqual(r.voiceSource, "env_default", "voiceSource");
});

check("seat 1 picks FISH_HOST_B_VOICE_ID", () => {
  clearVoiceEnv();
  process.env.FISH_HOST_A_VOICE_ID = FISH_A;
  process.env.FISH_HOST_B_VOICE_ID = FISH_B;
  const r = resolveTtsProviderAndVoice({ providerOverride: "fish", host: seated(1) });
  assertEqual(r.voiceId, FISH_B, "voiceId");
});

check("seats 2 and 3 reach HOST_C and HOST_D", () => {
  clearVoiceEnv();
  process.env.FISH_HOST_C_VOICE_ID = FISH_A;
  process.env.FISH_HOST_D_VOICE_ID = FISH_B;
  assertEqual(
    resolveTtsProviderAndVoice({ providerOverride: "fish", host: seated(2) }).voiceId,
    FISH_A,
    "seat 2 voiceId"
  );
  assertEqual(
    resolveTtsProviderAndVoice({ providerOverride: "fish", host: seated(3) }).voiceId,
    FISH_B,
    "seat 3 voiceId"
  );
});

check("the host's own slug var still beats the seat var", () => {
  clearVoiceEnv();
  process.env.FISH_HOST_A_VOICE_ID = FISH_A;
  process.env.FISH_VOICE_ID_BERNIE_LINE_TWO = FISH_SLUG;
  const r = resolveTtsProviderAndVoice({
    providerOverride: "fish",
    host: seated(0, { slug: "bernie-line-two", ttsProvider: "fish", ttsVoiceId: null }),
  });
  assertEqual(r.voiceId, FISH_SLUG, "voiceId");
});

check("DEPRECATED FISH_MAX_VOLTAGE_VOICE_ID still resolves for seat 0", () => {
  clearVoiceEnv();
  process.env.FISH_MAX_VOLTAGE_VOICE_ID = FISH_A;
  const r = resolveTtsProviderAndVoice({ providerOverride: "fish", host: seated(0) });
  assertEqual(r.voiceId, FISH_A, "voiceId");
  assertEqual(r.voiceSource, "env_default", "voiceSource");
});

check("DEPRECATED FISH_DR_LINEBREAK_VOICE_ID still resolves for seat 1", () => {
  clearVoiceEnv();
  process.env.FISH_DR_LINEBREAK_VOICE_ID = FISH_B;
  const r = resolveTtsProviderAndVoice({ providerOverride: "fish", host: seated(1) });
  assertEqual(r.voiceId, FISH_B, "voiceId");
});

check("the seat var wins over the deprecated named var", () => {
  clearVoiceEnv();
  process.env.FISH_HOST_B_VOICE_ID = FISH_B;
  process.env.FISH_DR_LINEBREAK_VOICE_ID = FISH_A;
  const r = resolveTtsProviderAndVoice({ providerOverride: "fish", host: seated(1) });
  assertEqual(r.voiceId, FISH_B, "voiceId");
});

check("a seat with no var of its own falls to shared AND warns", () => {
  clearVoiceEnv();
  process.env.FISH_HOST_A_VOICE_ID = FISH_A;
  process.env.FISH_TTS_VOICE = FISH_SHARED;
  let r: ReturnType<typeof resolveTtsProviderAndVoice> | undefined;
  const warnings = captureWarnings(() => {
    r = resolveTtsProviderAndVoice({
      providerOverride: "fish",
      host: seated(1, { name: 'Ray "Forty-One" Meachum', slug: "ray-forty-one" }),
    });
  });
  assertEqual(r?.voiceId, FISH_SHARED, "voiceId");
  assertEqual(warnings.length, 1, "warning count");
  if (!warnings[0].includes("Meachum")) throw new Error(`warning does not name the host: ${warnings[0]}`);
  if (!warnings[0].includes("seat B")) throw new Error(`warning does not name the seat: ${warnings[0]}`);
  if (!warnings[0].includes("FISH_HOST_B_VOICE_ID")) {
    throw new Error(`warning does not name the fix: ${warnings[0]}`);
  }
});

check("an unseated host falls to shared AND warns", () => {
  clearVoiceEnv();
  process.env.FISH_TTS_VOICE = FISH_SHARED;
  let r: ReturnType<typeof resolveTtsProviderAndVoice> | undefined;
  const warnings = captureWarnings(() => {
    r = resolveTtsProviderAndVoice({ providerOverride: "fish", host: seated(undefined) });
  });
  assertEqual(r?.voiceId, FISH_SHARED, "voiceId");
  assertEqual(warnings.length, 1, "warning count");
  if (!warnings[0].includes("unseated")) throw new Error(`warning does not flag the missing seat: ${warnings[0]}`);
});

check("a seat-specific voice resolves with NO warning", () => {
  clearVoiceEnv();
  process.env.FISH_HOST_B_VOICE_ID = FISH_B;
  process.env.FISH_TTS_VOICE = FISH_SHARED;
  const warnings = captureWarnings(() => {
    resolveTtsProviderAndVoice({ providerOverride: "fish", host: seated(1) });
  });
  assertEqual(warnings.length, 0, "warning count");
});

check("no voice anywhere warns before the engine default", () => {
  clearVoiceEnv();
  let r: ReturnType<typeof resolveTtsProviderAndVoice> | undefined;
  const warnings = captureWarnings(() => {
    r = resolveTtsProviderAndVoice({ providerOverride: "fish", host: seated(1) });
  });
  assertEqual(r?.voiceId, "", "voiceId (Fish engine default)");
  assertEqual(r?.voiceSource, "provider_default", "voiceSource");
  assertEqual(warnings.length, 1, "warning count");
});

console.log("Meachum acceptance (the ticket's three bullets, offline):");

const MEACHUM_OWN = "36780e7121b84d5c9c24cbd2f15eaaa4";
const meachumSeeded: HostVoiceContext = {
  id: "meachum-id",
  slug: "ray-forty-one",
  name: 'Ray "Forty-One" Meachum',
  ttsProvider: "fish",
  ttsVoiceId: MEACHUM_OWN,
  seatIndex: 1,
};

check("his own reference id wins with FISH_TTS_VOICE unset", () => {
  clearVoiceEnv();
  const r = resolveTtsProviderAndVoice({ providerOverride: "fish", host: meachumSeeded });
  assertEqual(r.voiceId, MEACHUM_OWN, "voiceId");
  assertEqual(r.voiceSource, "host_default", "voiceSource");
});

check("FISH_HOST_B_VOICE_ID set + his voice cleared resolves to seat B, no warning", () => {
  clearVoiceEnv();
  process.env.FISH_HOST_B_VOICE_ID = FISH_B;
  process.env.FISH_TTS_VOICE = FISH_SHARED;
  let r: ReturnType<typeof resolveTtsProviderAndVoice> | undefined;
  const warnings = captureWarnings(() => {
    r = resolveTtsProviderAndVoice({
      providerOverride: "fish",
      host: { ...meachumSeeded, ttsVoiceId: null },
    });
  });
  assertEqual(r?.voiceId, FISH_B, "voiceId");
  assertEqual(warnings.length, 0, "warning count");
});

check("both unset falls to shared AND warns, naming him and seat B", () => {
  clearVoiceEnv();
  process.env.FISH_TTS_VOICE = FISH_SHARED;
  let r: ReturnType<typeof resolveTtsProviderAndVoice> | undefined;
  const warnings = captureWarnings(() => {
    r = resolveTtsProviderAndVoice({
      providerOverride: "fish",
      host: { ...meachumSeeded, ttsVoiceId: null },
    });
  });
  assertEqual(r?.voiceId, FISH_SHARED, "voiceId");
  assertEqual(warnings.length, 1, "warning count");
  if (!warnings[0].includes("Meachum") || !warnings[0].includes("seat B")) {
    throw new Error(`warning does not name host and seat: ${warnings[0]}`);
  }
});

check("Zabala and Meachum never collapse onto the same Fish voice", () => {
  clearVoiceEnv();
  process.env.FISH_HOST_A_VOICE_ID = FISH_A;
  process.env.FISH_HOST_B_VOICE_ID = FISH_B;
  const a = resolveTtsProviderAndVoice({
    providerOverride: "fish",
    host: { ...zabala, ttsProvider: "fish", ttsVoiceId: null, seatIndex: 0 },
  });
  const b = resolveTtsProviderAndVoice({
    providerOverride: "fish",
    host: { ...meachumSeeded, ttsVoiceId: null },
  });
  if (a.voiceId === b.voiceId) throw new Error(`both chairs resolved to ${a.voiceId}`);
});

check("Cartesia stock fallbacks are keyed by seat, so two chairs stay distinct", () => {
  clearVoiceEnv();
  const a = resolveTtsProviderAndVoice({
    providerOverride: "cartesia",
    host: seated(0, { ttsProvider: "cartesia", ttsVoiceId: null }),
  });
  const b = resolveTtsProviderAndVoice({
    providerOverride: "cartesia",
    host: seated(1, { ttsProvider: "cartesia", ttsVoiceId: null }),
  });
  assertEqual(a.voiceSource, "provider_default", "seat 0 voiceSource");
  if (a.voiceId === b.voiceId) throw new Error(`both chairs got the same Cartesia voice ${a.voiceId}`);
});

check("overrides keyed by host id also resolve (slug preferred)", () => {
  clearVoiceEnv();
  const r = resolveTtsProviderAndVoice({
    providerOverride: "boson",
    episodeVoiceOverrides: { "host-a-id": { provider: "boson", voiceId: BOSON_ID } },
    host: zabala,
  });
  assertEqual(r.voiceId, BOSON_ID, "voiceId");
});

check("ElevenLabs with no usable voice fails with a clear message", () => {
  clearVoiceEnv();
  assertThrows(
    () =>
      resolveTtsProviderAndVoice({
        providerOverride: "elevenlabs",
        host: { ...zabala, ttsProvider: "boson", ttsVoiceId: BOSON_ID },
      }),
    "No voice ID configured for provider elevenlabs and host Bernadette \"Line Two\" Zabala"
  );
});

check("OpenAI: valid name accepted, invalid name falls through to safe default", () => {
  clearVoiceEnv();
  const good = resolveTtsProviderAndVoice({
    providerOverride: "openai",
    runVoiceOverrides: { "bernie-line-two": { provider: "openai", voiceId: "Onyx" } },
    host: zabala,
  });
  assertEqual(good.voiceId, "onyx", "voiceId (normalized)");
  const bad = resolveTtsProviderAndVoice({
    providerOverride: "openai",
    runVoiceOverrides: { "bernie-line-two": { provider: "openai", voiceId: "not-a-voice" } },
    host: zabala,
  });
  assertEqual(bad.voiceId, "alloy", "voiceId (safe default)");
  assertEqual(bad.voiceSource, "provider_default", "voiceSource");
});

check("stub resolution never throws", () => {
  clearVoiceEnv();
  const r = resolveTtsProviderAndVoice({ host: { ...zabala, ttsProvider: "stub" } });
  assertEqual(r.provider, "stub", "provider");
});

console.log("Input validation (server-action boundary):");

check("valid overrides normalize and pass through", () => {
  const v = validateTtsVoiceOverridesInput({
    "bernie-line-two": { provider: "Boson", voiceId: ` ${BOSON_ID} `, voiceName: "Growler" },
  });
  assertEqual(v?.["bernie-line-two"].provider, "boson", "provider");
  assertEqual(v?.["bernie-line-two"].voiceId, BOSON_ID, "voiceId");
});

check("unknown provider is rejected", () => {
  assertThrows(
    () => validateTtsVoiceOverridesInput({ "bernie-line-two": { provider: "acme", voiceId: "x" } }),
    "unknown TTS provider"
  );
});

check("non-32-hex Fish reference id is rejected", () => {
  assertThrows(
    () => validateTtsVoiceOverridesInput({ "bernie-line-two": { provider: "fish", voiceId: ELEVEN_ID } }),
    "32-character hex"
  );
});

check("unknown OpenAI voice name is rejected", () => {
  assertThrows(
    () => validateTtsVoiceOverridesInput({ "bernie-line-two": { provider: "openai", voiceId: "brian" } }),
    "OpenAI voice must be one of"
  );
});

check("empty picks collapse to undefined", () => {
  assertEqual(validateTtsVoiceOverridesInput({ "bernie-line-two": { provider: "boson", voiceId: "  " } }), undefined);
  assertEqual(validateTtsVoiceOverridesInput(undefined), undefined);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
