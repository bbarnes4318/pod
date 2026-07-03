import { SynthesizeSpeechResult, TTSProvider } from "./types";

export class StubTTSProvider implements TTSProvider {
  name = "stub";

  async synthesizeSpeech(): Promise<SynthesizeSpeechResult> {
    throw new Error("TTS provider is stub. Real audio generation is disabled. Please configure a real TTS provider in your environment variables.");
  }
}

export default StubTTSProvider;
