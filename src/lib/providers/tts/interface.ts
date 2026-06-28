export interface GenerateSpeechOptions {
  text: string;
  voiceId?: string;
  modelId?: string;
}

export interface TTSProvider {
  name: string;
  generateSpeech(options: GenerateSpeechOptions): Promise<Buffer>;
}
