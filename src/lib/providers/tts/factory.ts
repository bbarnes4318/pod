import { TTSProvider } from "./types";
import { StubTTSProvider } from "./stub";
import { ElevenLabsTTSProvider } from "./elevenlabs";
import { CartesiaTTSProvider } from "./cartesia";
import { OpenAITTSProvider } from "./openai";
import { BosonTTSProvider } from "./boson";
import { FishTTSProvider } from "./fish";

export function getTTSProvider(): TTSProvider {
  const providerType = process.env.TTS_PROVIDER?.toLowerCase() || "stub";

  switch (providerType) {
    case "elevenlabs":
      return new ElevenLabsTTSProvider();
    case "cartesia":
      return new CartesiaTTSProvider();
    case "openai":
      return new OpenAITTSProvider();
    case "boson":
      return new BosonTTSProvider();
    case "fish":
      return new FishTTSProvider();
    case "stub":
    default:
      return new StubTTSProvider();
  }
}

export default getTTSProvider;
