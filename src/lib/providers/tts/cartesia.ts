import { SynthesizeSpeechInput, SynthesizeSpeechResult, TTSProvider } from "./types";
import { stripAudioTags } from "@/lib/audio/speechText";

/**
 * Cartesia provider tuned for conversational dialogue.
 *
 * - Defaults to the sonic-3 family (natural laughter + emotion, ~40ms TTFA)
 *   instead of the older sonic-2. Override with CARTESIA_MODEL_ID.
 * - Sonic 3 understands [laughter] inline; we translate our whitelisted
 *   laugh-type tags to that form and strip tags the model doesn't support.
 */
export class CartesiaTTSProvider implements TTSProvider {
  name = "cartesia";

  async synthesizeSpeech(input: SynthesizeSpeechInput): Promise<SynthesizeSpeechResult> {
    const apiKey = process.env.CARTESIA_API_KEY;
    if (!apiKey) {
      throw new Error("CARTESIA_API_KEY is not configured.");
    }

    // Accept both env spellings; older deploys set CARTESIA_MODEL.
    const modelId = process.env.CARTESIA_MODEL_ID || process.env.CARTESIA_MODEL || "sonic-3";
    const isSonic3Plus = !/^sonic-2/.test(modelId) && modelId !== "sonic" && modelId !== "sonic-english";
    const format = input.format || "mp3";

    const outputFormat =
      format === "mp3"
        ? {
            container: "mp3",
            sample_rate: 44100,
            bit_rate: 128000,
          }
        : {
            container: "raw",
            encoding: "pcm_s16le",
            sample_rate: 44100,
          };

    const transcript = isSonic3Plus
      ? translateTagsForSonic3(input.text)
      : stripAudioTags(input.text);

    const response = await fetch("https://api.cartesia.ai/tts/bytes", {
      method: "POST",
      headers: {
        "X-API-Key": apiKey,
        "Cartesia-Version": "2024-06-10",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        transcript,
        model_id: modelId,
        voice: {
          mode: "id",
          id: input.voiceId,
        },
        output_format: outputFormat,
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Cartesia API error: ${response.status} - ${errText}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    const audioBuffer = Buffer.from(arrayBuffer);
    const contentType = response.headers.get("content-type") || `audio/${format}`;

    return {
      audioBuffer,
      contentType,
    };
  }
}

const LAUGH_TAGS = /\[(laughs( hard| softly)?|chuckles)\]/gi;

function translateTagsForSonic3(text: string): string {
  // Sonic 3 renders [laughter] natively; other conversational tags are not
  // documented for it, so strip them rather than risk them being spoken.
  const withLaughter = text.replace(LAUGH_TAGS, "[laughter]");
  return withLaughter
    .replace(/\[(?!laughter\])[^\[\]]{1,40}\]/g, " ")
    .replace(/[ \t]+/g, " ")
    .trim();
}
