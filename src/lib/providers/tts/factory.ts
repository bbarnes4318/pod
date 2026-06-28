import { TTSProvider } from "./interface";
import { StubTTSProvider } from "./stub";

export function getTTSProvider(): TTSProvider {
  const providerType = process.env.TTS_PROVIDER?.toLowerCase() || "stub";

  switch (providerType) {
    case "elevenlabs":
      console.log("[TTSFactory] ElevenLabs requested (not fully implemented in architectural stub phase). Falling back to Stub.");
      return new StubTTSProvider();
    case "cartesia":
      console.log("[TTSFactory] Cartesia requested (not fully implemented in architectural stub phase). Falling back to Stub.");
      return new StubTTSProvider();
    case "stub":
    default:
      return new StubTTSProvider();
  }
}

export default getTTSProvider;
