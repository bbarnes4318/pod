import { TTSProvider, GenerateSpeechOptions } from "./interface";

export class StubTTSProvider implements TTSProvider {
  name = "stub-tts";

  async generateSpeech(options: GenerateSpeechOptions): Promise<Buffer> {
    console.log(`[StubTTSProvider] generateSpeech called with voiceId: ${options.voiceId || "default"} and text length: ${options.text.length}`);
    // Returns a tiny 1KB dummy buffer representing mock audio data
    return Buffer.alloc(1024);
  }
}

export default StubTTSProvider;
