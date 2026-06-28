export interface TTSProvider {
  name: string;
  synthesizeSpeech(input: {
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
  }>;
}
