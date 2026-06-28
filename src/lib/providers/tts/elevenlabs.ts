import { TTSProvider } from "./types";

export class ElevenLabsTTSProvider implements TTSProvider {
  name = "elevenlabs";

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
    const apiKey = process.env.ELEVENLABS_API_KEY;
    if (!apiKey) {
      throw new Error("ELEVENLABS_API_KEY is not configured.");
    }

    const modelId = process.env.ELEVENLABS_MODEL_ID || "eleven_multilingual_v2";
    const format = input.format || "mp3";
    const outputFormat = format === "mp3" ? "mp3_44100_128" : "pcm_44100";

    const url = `https://api.elevenlabs.io/v1/text-to-speech/${input.voiceId}?output_format=${outputFormat}`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text: input.text,
        model_id: modelId,
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75,
        },
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`ElevenLabs API error: ${response.status} - ${errText}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    const audioBuffer = Buffer.from(arrayBuffer);
    const contentType = response.headers.get("content-type") || `audio/${format}`;
    const providerAudioId = response.headers.get("history-item-id") || undefined;

    return {
      audioBuffer,
      contentType,
      providerAudioId,
    };
  }
}
