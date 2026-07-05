// Canonical TTS provider ids, shared by client pickers and server-side
// validation. Keep in sync with the factory switch in ./factory.ts.
export const TTS_PROVIDER_IDS = ["elevenlabs", "cartesia", "openai", "boson", "fish", "stub"] as const;

export type TtsProviderId = (typeof TTS_PROVIDER_IDS)[number];

export function isTtsProviderId(value: string): value is TtsProviderId {
  return (TTS_PROVIDER_IDS as readonly string[]).includes(value);
}

/** Listener-facing name for a provider id; unknown ids pass through as-is. */
export function ttsProviderLabel(value: string): string {
  return isTtsProviderId(value) ? TTS_PROVIDER_LABELS[value] : value;
}

/** OpenAI TTS uses a fixed set of voice names rather than opaque ids. */
export const OPENAI_TTS_VOICE_NAMES = [
  "alloy", "ash", "ballad", "cedar", "coral", "echo", "fable",
  "marin", "nova", "onyx", "sage", "shimmer", "verse",
] as const;

/** Fish reference ids are 32-char hex strings; anything else must never be sent. */
export const FISH_REFERENCE_ID_RE = /^[0-9a-f]{32}$/i;

/** Listener-facing names for the pickers. */
export const TTS_PROVIDER_LABELS: Record<TtsProviderId, string> = {
  elevenlabs: "ElevenLabs",
  cartesia: "Cartesia",
  openai: "OpenAI",
  boson: "Boson AI",
  fish: "Fish Audio",
  stub: "Stub",
};
