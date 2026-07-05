// Centralized, provider-aware TTS voice resolution.
//
// The old flow passed host.ttsVoiceId into whatever engine won provider
// resolution, which could send an ElevenLabs voice id to Boson/Fish (each
// engine's id space is disjoint). This module is the single place that pairs
// a resolved provider with a voice id that is valid FOR that provider.
//
// Resolution order (documented in docs/TTS_PROVIDERS.md):
//   provider: trigger override > episode pin > host default (non-stub) > env > stub
//   voice:    run override > episode override > host voice (only if the host's
//             own engine matches the resolved provider) > per-provider env
//             fallback > provider safe default (or a clear error).

import {
  FISH_REFERENCE_ID_RE,
  OPENAI_TTS_VOICE_NAMES,
  isTtsProviderId,
} from "./providerIds";

export interface TtsVoiceOverride {
  provider: string;
  voiceId: string;
  voiceName?: string;
}

/** Keyed by host slug (preferred) or host id. */
export type TtsVoiceOverrides = Record<string, TtsVoiceOverride>;

export type TtsVoiceSource =
  | "run_override"
  | "episode_override"
  | "host_default"
  | "env_default"
  | "provider_default";

export interface ResolvedTtsVoice {
  provider: string;
  /** Empty string means "let the engine use its own default voice" (Fish with no reference_id). */
  voiceId: string;
  voiceName?: string;
  voiceSource: TtsVoiceSource;
}

export interface HostVoiceContext {
  id: string;
  slug: string;
  name: string;
  ttsProvider?: string | null;
  ttsVoiceId?: string | null;
}

export interface ResolveTtsInput {
  /** Explicit choice on this trigger (admin console / job payload). */
  providerOverride?: string | null;
  /** Per-run voice picks travelling with the trigger (not yet persisted). */
  runVoiceOverrides?: TtsVoiceOverrides | null;
  /** Episode.ttsProvider — engine pinned at build time. */
  episodeProvider?: string | null;
  /** Episode.ttsVoiceOverrides — voice picks pinned on the episode. */
  episodeVoiceOverrides?: TtsVoiceOverrides | null;
  host: HostVoiceContext;
  /** process.env.TTS_PROVIDER (injectable for tests). */
  envProvider?: string | null;
}

// Cartesia's provider previously hard-coded these per-speaker fallbacks; they
// stay the safety net so a stub/missing voice never produces a random voice.
const CARTESIA_DEFAULTS: Record<string, string> = {
  "max-voltage": "e2d48e7b-cd73-4c4c-bc1e-f232580e8709",
  "dr-linebreak": "3ccc4544-84f7-45e3-ae57-5c52b5a1fac6",
};
const CARTESIA_GENERIC_DEFAULT = "a5136bf9-224c-4d76-b823-52bd5efcffcc"; // Jameson

function normalizeProvider(value?: string | null): string | null {
  const v = value?.trim().toLowerCase();
  return v ? v : null;
}

function isStubVoiceId(voiceId?: string | null): boolean {
  return !voiceId || voiceId.includes("stub");
}

/** Is this voice id plausibly valid for the given provider? */
export function isVoiceIdValidForProvider(provider: string, voiceId?: string | null): boolean {
  if (isStubVoiceId(voiceId)) return false;
  const id = (voiceId as string).trim();
  if (!id) return false;
  switch (provider) {
    case "fish":
      return FISH_REFERENCE_ID_RE.test(id);
    case "openai":
      return (OPENAI_TTS_VOICE_NAMES as readonly string[]).includes(id.toLowerCase());
    default:
      return true;
  }
}

function isMaxVoltage(host: HostVoiceContext): boolean {
  return host.slug === "max-voltage" || host.name === "Max Voltage";
}

function isDrLinebreak(host: HostVoiceContext): boolean {
  return host.slug === "dr-linebreak" || host.name === "Dr. Linebreak";
}

/** Per-provider, per-host env fallback voice id. */
function envVoiceFor(provider: string, host: HostVoiceContext): string | undefined {
  const pick = (maxVar?: string, docVar?: string, sharedVar?: string) =>
    (isMaxVoltage(host) ? maxVar : isDrLinebreak(host) ? docVar : undefined) || sharedVar || undefined;

  switch (provider) {
    case "boson":
      return pick(
        process.env.BOSON_MAX_VOLTAGE_VOICE_ID,
        process.env.BOSON_DR_LINEBREAK_VOICE_ID,
        process.env.BOSON_TTS_VOICE
      );
    case "fish":
      return pick(
        process.env.FISH_MAX_VOLTAGE_VOICE_ID,
        process.env.FISH_DR_LINEBREAK_VOICE_ID,
        process.env.FISH_TTS_VOICE
      );
    case "elevenlabs":
      return pick(
        process.env.ELEVENLABS_MAX_VOLTAGE_VOICE_ID,
        process.env.ELEVENLABS_DR_LINEBREAK_VOICE_ID,
        process.env.ELEVENLABS_VOICE_ID
      );
    case "cartesia":
      return pick(
        process.env.CARTESIA_MAX_VOLTAGE_VOICE_ID,
        process.env.CARTESIA_DR_LINEBREAK_VOICE_ID,
        process.env.CARTESIA_VOICE_ID
      );
    case "openai":
      return pick(
        process.env.OPENAI_MAX_VOLTAGE_VOICE,
        process.env.OPENAI_DR_LINEBREAK_VOICE,
        process.env.OPENAI_TTS_VOICE
      );
    default:
      return undefined;
  }
}

/** Find this host's entry in an overrides map — slug key preferred, id accepted. */
function overrideFor(
  overrides: TtsVoiceOverrides | null | undefined,
  host: HostVoiceContext
): TtsVoiceOverride | undefined {
  if (!overrides || typeof overrides !== "object") return undefined;
  return overrides[host.slug] || overrides[host.id];
}

/**
 * Resolve which engine voices this host's lines and which voice id to send.
 * Never returns a voice id from a different provider than the resolved one:
 * overrides only apply when their own `provider` matches, the host's voice
 * only applies when the host's own engine matches, and Fish/OpenAI ids are
 * format-validated on top.
 */
export function resolveTtsProviderAndVoice(input: ResolveTtsInput): ResolvedTtsVoice {
  const { host } = input;

  const hostProvider = normalizeProvider(host.ttsProvider);
  const provider =
    normalizeProvider(input.providerOverride) ||
    normalizeProvider(input.episodeProvider) ||
    (hostProvider && hostProvider !== "stub" ? hostProvider : null) ||
    normalizeProvider(input.envProvider) ||
    "stub";

  // Stub never calls a real API; hand back whatever the host has so error
  // messages stay recognizable.
  if (provider === "stub") {
    return { provider, voiceId: host.ttsVoiceId || "stub-voice", voiceSource: "host_default" };
  }

  // 1-2. Run override, then episode override — only when the entry was picked
  // FOR the resolved provider.
  const candidates: Array<{ entry: TtsVoiceOverride | undefined; source: TtsVoiceSource }> = [
    { entry: overrideFor(input.runVoiceOverrides, host), source: "run_override" },
    { entry: overrideFor(input.episodeVoiceOverrides, host), source: "episode_override" },
  ];
  for (const { entry, source } of candidates) {
    if (!entry) continue;
    if (normalizeProvider(entry.provider) !== provider) continue;
    if (!isVoiceIdValidForProvider(provider, entry.voiceId)) continue;
    const voiceId = provider === "openai" ? entry.voiceId.trim().toLowerCase() : entry.voiceId.trim();
    return { provider, voiceId, voiceName: entry.voiceName, voiceSource: source };
  }

  // 3. Host default — only when the host's own engine IS the resolved one.
  if (hostProvider === provider && isVoiceIdValidForProvider(provider, host.ttsVoiceId)) {
    return { provider, voiceId: (host.ttsVoiceId as string).trim(), voiceSource: "host_default" };
  }

  // 4. Provider-specific env fallback.
  const envVoice = envVoiceFor(provider, host);
  if (envVoice && isVoiceIdValidForProvider(provider, envVoice)) {
    const voiceId = provider === "openai" ? envVoice.trim().toLowerCase() : envVoice.trim();
    return { provider, voiceId, voiceSource: "env_default" };
  }

  // 5. Provider safe defaults, else a clear error.
  switch (provider) {
    case "boson":
      return { provider, voiceId: "default", voiceSource: "provider_default" };
    case "openai":
      return { provider, voiceId: "alloy", voiceSource: "provider_default" };
    case "fish":
      // Fish works without a reference_id (engine default voice); empty means
      // "send no reference_id".
      return { provider, voiceId: "", voiceSource: "provider_default" };
    case "cartesia": {
      const fallback = CARTESIA_DEFAULTS[host.slug] || CARTESIA_GENERIC_DEFAULT;
      return { provider, voiceId: fallback, voiceSource: "provider_default" };
    }
    default:
      throw new Error(
        `No voice ID configured for provider ${provider} and host ${host.name}. ` +
          `Pick a voice for this episode, set the host's default voice, or configure the provider's env voice ids.`
      );
  }
}

/** Model id the provider will use, for AudioSegment.providerMetadata. */
export function getTtsModelId(provider: string): string | undefined {
  switch (provider) {
    case "elevenlabs":
      return process.env.ELEVENLABS_MODEL_ID || process.env.ELEVENLABS_MODEL || "eleven_v3";
    case "cartesia":
      return process.env.CARTESIA_MODEL_ID || process.env.CARTESIA_MODEL || "sonic-3";
    case "openai":
      return process.env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts";
    case "boson":
      return process.env.BOSON_TTS_MODEL || "higgs-tts-3";
    case "fish":
      return (process.env.FISH_MODEL || "s2.1-pro-free").trim();
    default:
      return undefined;
  }
}

/**
 * Validate operator-supplied voice overrides at the API boundary (server
 * actions / episode build). Throws with a clear message on bad input; returns
 * a normalized copy, or undefined when there is nothing to store.
 */
export function validateTtsVoiceOverridesInput(
  raw: unknown
): TtsVoiceOverrides | undefined {
  if (raw === null || raw === undefined) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Voice overrides must be an object keyed by host slug.");
  }

  const normalized: TtsVoiceOverrides = {};
  for (const [hostKey, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (entry === null || entry === undefined) continue;
    if (typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`Voice override for '${hostKey}' must be an object with provider and voiceId.`);
    }
    const { provider, voiceId, voiceName } = entry as Record<string, unknown>;
    const providerId = typeof provider === "string" ? provider.trim().toLowerCase() : "";
    if (!isTtsProviderId(providerId)) {
      throw new Error(`Voice override for '${hostKey}' has unknown TTS provider '${String(provider)}'.`);
    }
    const id = typeof voiceId === "string" ? voiceId.trim() : "";
    if (!id) continue; // empty pick = no override for this host
    if (providerId === "fish" && !FISH_REFERENCE_ID_RE.test(id)) {
      throw new Error(
        `Voice override for '${hostKey}': Fish reference IDs are 32-character hex strings ('${id}' is not).`
      );
    }
    if (providerId === "openai" && !(OPENAI_TTS_VOICE_NAMES as readonly string[]).includes(id.toLowerCase())) {
      throw new Error(
        `Voice override for '${hostKey}': OpenAI voice must be one of ${OPENAI_TTS_VOICE_NAMES.join(", ")}.`
      );
    }
    normalized[hostKey] = {
      provider: providerId,
      voiceId: providerId === "openai" ? id.toLowerCase() : id,
      ...(typeof voiceName === "string" && voiceName.trim() ? { voiceName: voiceName.trim() } : {}),
    };
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}
