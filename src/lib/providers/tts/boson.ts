import { TTSProvider } from "./types";
import { getBosonApiKey, getBosonTtsStatus } from "../../env";

export class BosonTTSProvider implements TTSProvider {
  public readonly name = "boson";
  public readonly supportsStreaming = true;
  public readonly supportsNonStreaming = true;
  public readonly supportsMp3 = true;
  public readonly supportsPcm = true;
  public readonly supportsWav = false;
  public readonly supportsUlaw = false;
  public readonly supportsInlineTags = true;
  public readonly supportsVoiceCloning = true;

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
    const apiKey = getBosonApiKey();
    if (!apiKey) {
      throw new Error("BOSON_API_KEY is not configured.");
    }

    const modelId = process.env.BOSON_TTS_MODEL || "higgs-tts-3";
    const format = input.format || "mp3";
    
    // Map response format
    const responseFormat = format === "wav" ? "wav" : "mp3";
    const stream = process.env.BOSON_TTS_STREAM === "true";

    const voice = input.voiceId || process.env.BOSON_TTS_VOICE || "default";

    // Setup request body
    const body: any = {
      model: modelId,
      input: input.text,
      voice,
      response_format: stream ? "pcm" : responseFormat,
      stream,
    };

    if (process.env.BOSON_TTS_REF_AUDIO) {
      body.ref_audio = process.env.BOSON_TTS_REF_AUDIO;
    }
    if (process.env.BOSON_TTS_REF_TEXT) {
      body.ref_text = process.env.BOSON_TTS_REF_TEXT;
    }

    const url = "https://api.boson.ai/v1/audio/speech";
    const timeoutMs = parseInt(process.env.BOSON_TTS_TIMEOUT_MS || "30000", 10);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    console.log(`[TTS_PROVIDER_LOG] selected tts provider: boson`);
    console.log(`[TTS_PROVIDER_LOG] boson model: ${modelId}`);
    console.log(`[TTS_PROVIDER_LOG] boson voice configured: true`);

    try {
      await new Promise((r) => setTimeout(r, 500));
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Boson API error: ${response.status} - ${errText}`);
      }

      const arrayBuffer = await response.arrayBuffer();
      const audioBuffer = Buffer.from(arrayBuffer);
      const contentType = response.headers.get("content-type") || `audio/${format}`;
      const providerAudioId = response.headers.get("x-boson-request-id") || undefined;

      return {
        audioBuffer,
        contentType,
        providerAudioId,
      };
    } catch (err: any) {
      clearTimeout(timeoutId);
      if (err.name === "AbortError") {
        throw new Error(`Boson TTS request timed out after ${timeoutMs}ms.`);
      }
      throw err;
    }
  }

  public async synthesizeSegment(input: any) {
    return this.synthesizeSpeech(input);
  }

  public async synthesizeToBuffer(input: any) {
    const res = await this.synthesizeSpeech(input);
    return res.audioBuffer;
  }

  public async synthesizeToFile(input: any, filePath: string) {
    return this.synthesizeSpeech(input);
  }

  public async healthCheck(): Promise<"CONFIGURED" | "MISSING" | "ERROR"> {
    return getBosonTtsStatus();
  }

  public async getProviderStatus(): Promise<"CONFIGURED" | "MISSING" | "ERROR"> {
    return this.healthCheck();
  }
}
