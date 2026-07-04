import { SynthesizeSpeechInput, SynthesizeSpeechResult, TTSProvider } from "./types";
import { stripAudioTags } from "@/lib/audio/speechText";

/**
 * ElevenLabs provider tuned for conversational podcast dialogue.
 *
 * - Defaults to the expressive `eleven_v3` model, which interprets inline
 *   audio tags ([laughs], [sighs], ...) and has far wider emotional range
 *   than eleven_multilingual_v2. Override with ELEVENLABS_MODEL_ID.
 * - Sends previous_text/next_text so prosody carries across lines instead of
 *   resetting to "announcer voice" on every request.
 * - Maps the script's tone/energy metadata onto voice_settings instead of
 *   using one fixed stability for the whole episode.
 */
export class ElevenLabsTTSProvider implements TTSProvider {
  name = "elevenlabs";

  async synthesizeSpeech(input: SynthesizeSpeechInput): Promise<SynthesizeSpeechResult> {
    const apiKey = process.env.ELEVENLABS_API_KEY;
    if (!apiKey) {
      throw new Error("ELEVENLABS_API_KEY is not configured.");
    }

    // Accept both env spellings; older deploys set ELEVENLABS_MODEL.
    const modelId =
      process.env.ELEVENLABS_MODEL_ID || process.env.ELEVENLABS_MODEL || "eleven_v3";
    const isV3 = modelId.startsWith("eleven_v3");

    const format = input.format || "mp3";
    const outputFormat = format === "mp3" ? "mp3_44100_128" : "pcm_44100";

    // v3 interprets bracketed audio tags; older models would read them aloud.
    const text = isV3 ? input.text : stripAudioTags(input.text);

    const body: Record<string, unknown> = {
      text,
      model_id: modelId,
      voice_settings: buildVoiceSettings(isV3, input),
    };

    // Prosody continuity across the same speaker's lines.
    if (input.previousText) body.previous_text = stripAudioTags(input.previousText);
    if (input.nextText) body.next_text = stripAudioTags(input.nextText);

    const url = `https://api.elevenlabs.io/v1/text-to-speech/${input.voiceId}?output_format=${outputFormat}`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`ElevenLabs API error: ${response.status} - ${errText}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    const audioBuffer = Buffer.from(arrayBuffer);
    const contentType = response.headers.get("content-type") || `audio/${format}`;
    const providerAudioId =
      response.headers.get("request-id") ||
      response.headers.get("history-item-id") ||
      undefined;

    return {
      audioBuffer,
      contentType,
      providerAudioId,
    };
  }
}

const HOT_TONES = new Set(["heated", "excited", "incredulous", "amused", "sarcastic"]);
const FLAT_TONES = new Set(["analytical", "reflective", "conceding", "setup", "transition"]);

function buildVoiceSettings(isV3: boolean, input: SynthesizeSpeechInput) {
  const energy = input.energy || "medium";
  const tone = (input.tone || "").toLowerCase();
  const hot = energy === "high" || HOT_TONES.has(tone);
  const calm = energy === "low" && FLAT_TONES.has(tone);

  if (isV3) {
    // v3 stability is a mode selector: 0.0 Creative / 0.5 Natural / 1.0 Robust.
    // Creative gives the widest emotional range and best tag response; Robust
    // is reserved for genuinely flat delivery so voices stay recognizable.
    return {
      stability: hot ? 0.0 : calm ? 1.0 : 0.5,
      similarity_boost: 0.75,
      use_speaker_boost: true,
    };
  }

  // v2-style models: continuous ranges. Lower stability widens emotional
  // variation; style adds expressiveness; small speed shifts mirror how
  // people speed up when fired up and slow down when making a point.
  return {
    stability: hot ? 0.3 : calm ? 0.65 : 0.45,
    similarity_boost: 0.75,
    style: hot ? 0.45 : 0.15,
    use_speaker_boost: true,
    speed: energy === "high" ? 1.06 : energy === "low" ? 0.94 : 1.0,
  };
}
