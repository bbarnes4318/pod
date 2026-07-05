import { SynthesizeSpeechInput, SynthesizeSpeechResult, TTSProvider } from "./types";
import { OPENAI_TTS_VOICE_NAMES } from "./providerIds";
import { stripAudioTags } from "@/lib/audio/speechText";

/**
 * OpenAI TTS provider tuned for conversational dialogue.
 *
 * - Defaults to gpt-4o-mini-tts, which accepts an `instructions` prompt that
 *   steers tone, pacing, and emotion per request — the older tts-1 model has
 *   no delivery controls at all. Override with OPENAI_TTS_MODEL.
 * - Builds the instructions from the host's persona brief plus the line's
 *   tone/energy so delivery follows the script instead of one flat read.
 */
export class OpenAITTSProvider implements TTSProvider {
  name = "openai";

  async synthesizeSpeech(input: SynthesizeSpeechInput): Promise<SynthesizeSpeechResult> {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error("OPENAI_API_KEY is not configured.");
    }

    const model = process.env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts";
    const supportsInstructions = model.includes("gpt-4o") || model.includes("tts-latest");
    const format = input.format || "mp3";

    // OpenAI TTS voices are fixed names. An explicit valid pick wins;
    // otherwise per-speaker env vars, the shared env default, then "alloy".
    const allowed = OPENAI_TTS_VOICE_NAMES as readonly string[];
    const asOpenAiVoice = (v?: string | null): string | undefined =>
      v && allowed.includes(v.toLowerCase()) ? v.toLowerCase() : undefined;
    let voice = asOpenAiVoice(input.voiceId);
    if (!voice) {
      if (input.speakerName === "Max Voltage") {
        voice = asOpenAiVoice(process.env.OPENAI_MAX_VOLTAGE_VOICE);
      } else if (input.speakerName === "Dr. Linebreak") {
        voice = asOpenAiVoice(process.env.OPENAI_DR_LINEBREAK_VOICE);
      }
      if (!voice) voice = asOpenAiVoice(process.env.OPENAI_TTS_VOICE) || "alloy";
    }

    const body: Record<string, unknown> = {
      model,
      // OpenAI TTS has no audio-tag support; delivery is steered via instructions.
      input: stripAudioTags(input.text),
      voice,
      response_format: format === "wav" ? "wav" : "mp3",
    };

    if (supportsInstructions) {
      body.instructions = buildInstructions(input);
    }

    const response = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`OpenAI TTS API error: ${response.status} - ${errText}`);
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

const TONE_DIRECTION: Record<string, string> = {
  heated: "Fired up and combative — raised voice, fast, jabbing emphasis.",
  sarcastic: "Dripping sarcasm — exaggerated mock-sincerity, drawn-out words.",
  analytical: "Calm and precise, like walking someone through the numbers.",
  dismissive: "Bored contempt — waving the argument away.",
  amused: "Trying not to laugh; warmth behind the words.",
  incredulous: "Genuinely can't believe what was just said — pitch rises.",
  conceding: "Grudging agreement — slower, slightly deflated.",
  excited: "Big energy, quick pace, riding the moment.",
  reflective: "Slower, thoughtful, lower volume.",
  setup: "Conversational, setting the table for what's next.",
  transition: "Casual pivot, light energy.",
};

function buildInstructions(input: SynthesizeSpeechInput): string {
  const parts: string[] = [];
  parts.push(
    input.voiceDirection ||
      "You are a sports podcast host mid-conversation with a co-host."
  );
  const toneDir = TONE_DIRECTION[(input.tone || "").toLowerCase()];
  if (toneDir) parts.push(toneDir);
  if (input.energy === "high") parts.push("High vocal energy.");
  if (input.energy === "low") parts.push("Low-key, relaxed delivery.");
  if (input.isInterruption) {
    parts.push("You are cutting your co-host off — start abruptly, mid-breath, no ramp-up.");
  }
  parts.push(
    "Sound like natural spontaneous speech, not narration: uneven pacing, real emphasis, audible breaths where natural."
  );
  return parts.join(" ");
}
