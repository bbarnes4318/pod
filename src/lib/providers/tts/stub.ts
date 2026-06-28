import { TTSProvider } from "./types";

export class StubTTSProvider implements TTSProvider {
  name = "stub";

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
    throw new Error("TTS provider is stub. Real audio generation is disabled. Please configure a real TTS provider in your environment variables.");
  }
}

export default StubTTSProvider;
