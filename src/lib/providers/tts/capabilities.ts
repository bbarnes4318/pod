// Verified per-engine capability matrix. AUTHORITY: docs/TTS_SCENE_CAPABILITIES.md
// — every value here must be traceable to a `verified_documentation` row there
// (or be an explicitly documented conservative default). Never widen a value
// beyond what that file supports.
//
// Client-safe: no Node imports; env reads are guarded.

import type { TtsProviderCapabilities } from "./sceneTypes";

function envInt(name: string, fallback: number): number {
  const v = typeof process !== "undefined" ? Number(process.env?.[name]) : NaN;
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
}

/** Documented reliable budget for ElevenLabs Text to Dialogue: ≤2,000 chars
 *  across all inputs[].text per request (official API reference / SDK). */
export const ELEVENLABS_DIALOGUE_RECOMMENDED_MAX_CHARS = 2000;
/** Documented cap: max 10 unique voice ids per dialogue request. */
export const ELEVENLABS_DIALOGUE_MAX_SPEAKERS = 10;

export function getTtsProviderCapabilities(providerId: string): TtsProviderCapabilities {
  switch ((providerId || "").toLowerCase()) {
    case "elevenlabs":
      return {
        providerId: "elevenlabs",
        renderUnits: ["single_line", "multi_speaker_scene"],
        maxSpeakers: ELEVENLABS_DIALOGUE_MAX_SPEAKERS,
        recommendedMaxCharacters: ELEVENLABS_DIALOGUE_RECOMMENDED_MAX_CHARS,
        // No hard cap documented for the dialogue endpoint — stay at the
        // recommended budget; do not invent one.
        supportsContinuation: false, // dialogue endpoint has no continuity fields; v3 rejects previous/next_text
        supportsSeed: true,          // best-effort determinism, 0..4294967295
        supportsMultipleCandidates: false,
        supportsWordTimestamps: true, // /v1/text-to-dialogue/with-timestamps (char alignment)
        supportsSpeakerTimestamps: true, // Text-to-Dialogue timestamps include provider-labelled voice_segments
        supportsInlineDeliveryCues: true, // eleven_v3 audio tags
        supportsNaturalLanguageDirection: false, // no instruction field
        mixedSpeakerOutput: true,
      };
    case "fish":
      return {
        providerId: "fish",
        renderUnits: ["single_line", "multi_speaker_scene"],
        // Provider cap unknown — bound by the platform's 4-seat cast instead.
        maxSpeakers: 4,
        // Not a documented provider limit: a conservative, overridable
        // operational budget (see docs/TTS_SCENE_CAPABILITIES.md).
        recommendedMaxCharacters: envInt("FISH_SCENE_MAX_CHARS", 2000),
        supportsContinuation: false,
        supportsSeed: false,
        supportsMultipleCandidates: false,
        supportsWordTimestamps: false,
        supportsSpeakerTimestamps: false,
        supportsInlineDeliveryCues: true, // inline natural-language cues (S2 family)
        supportsNaturalLanguageDirection: false,
        mixedSpeakerOutput: true,
      };
    case "openai":
      return {
        providerId: "openai",
        renderUnits: ["single_line"],
        maxSpeakers: 1,
        supportsContinuation: false,
        supportsSeed: false,
        supportsMultipleCandidates: false,
        supportsWordTimestamps: false,
        supportsSpeakerTimestamps: false,
        supportsInlineDeliveryCues: false,
        supportsNaturalLanguageDirection: true, // `instructions` (gpt-4o-mini-tts)
        mixedSpeakerOutput: true,
      };
    case "cartesia":
      return {
        providerId: "cartesia",
        renderUnits: ["single_line"],
        maxSpeakers: 1,
        supportsContinuation: false, // WS continuation contexts NOT re-verified — unused
        supportsSeed: false,
        supportsMultipleCandidates: false,
        supportsWordTimestamps: false,
        supportsSpeakerTimestamps: false,
        supportsInlineDeliveryCues: true,
        supportsNaturalLanguageDirection: false,
        mixedSpeakerOutput: true,
      };
    case "boson":
      return {
        providerId: "boson",
        renderUnits: ["single_line"],
        maxSpeakers: 1,
        supportsContinuation: false,
        supportsSeed: false,
        supportsMultipleCandidates: false,
        supportsWordTimestamps: false,
        supportsSpeakerTimestamps: false,
        supportsInlineDeliveryCues: true, // <|emotion:...|> control tokens
        supportsNaturalLanguageDirection: false,
        mixedSpeakerOutput: true,
      };
    default:
      return {
        providerId: providerId || "stub",
        renderUnits: ["single_line"],
        maxSpeakers: 1,
        supportsContinuation: false,
        supportsSeed: false,
        supportsMultipleCandidates: false,
        supportsWordTimestamps: false,
        supportsSpeakerTimestamps: false,
        supportsInlineDeliveryCues: false,
        supportsNaturalLanguageDirection: false,
        mixedSpeakerOutput: true,
      };
  }
}

/** Can this engine render a whole multi-speaker scene in one request? */
export function providerSupportsSceneRendering(providerId: string): boolean {
  return getTtsProviderCapabilities(providerId).renderUnits.includes("multi_speaker_scene");
}
