import { TTSProvider } from "./types";

export class CartesiaTTSProvider implements TTSProvider {
  name = "cartesia";

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
    const apiKey = process.env.CARTESIA_API_KEY;
    if (!apiKey) {
      throw new Error("CARTESIA_API_KEY is not configured.");
    }

    const modelId = process.env.CARTESIA_MODEL_ID || "sonic-2";
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

    const response = await fetch("https://api.cartesia.ai/tts/bytes", {
      method: "POST",
      headers: {
        "X-API-Key": apiKey,
        "Cartesia-Version": "2024-06-10",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        transcript: input.text,
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
