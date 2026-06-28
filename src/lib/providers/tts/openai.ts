import { TTSProvider } from "./types";

export class OpenAITTSProvider implements TTSProvider {
  name = "openai";

  async synthesizeSpeech(input: {
    text: string;
    voiceId: string;
    speakerName?: string;
    tone?: string;
    format?: "mp3" | "wav";
  }): Promise<{
    audioBuffer: Buffer;
    contentType: string;
    durationMs?: number;
    providerAudioId?: string;
    raw?: unknown;
  }> {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error("OPENAI_API_KEY is not configured.");
    }

    const model = process.env.OPENAI_TTS_MODEL || "tts-1";
    const format = input.format || "mp3";
    
    // Map host voice ID to OpenAI allowed voices: alloy, echo, fable, onyx, nova, shimmer
    // If not matching, use alloy as default
    const allowedVoices = ["alloy", "echo", "fable", "onyx", "nova", "shimmer"];
    const voice = allowedVoices.includes(input.voiceId.toLowerCase())
      ? input.voiceId.toLowerCase()
      : "alloy";

    const response = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        input: input.text,
        voice,
        response_format: format === "wav" ? "wav" : "mp3",
      }),
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
