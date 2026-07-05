import { TTSProvider } from "./types";
import { StubTTSProvider } from "./stub";
import { ElevenLabsTTSProvider } from "./elevenlabs";
import { CartesiaTTSProvider } from "./cartesia";
import { OpenAITTSProvider } from "./openai";
import { BosonTTSProvider } from "./boson";
import { FishTTSProvider } from "./fish";

/**
 * Instantiate a TTS provider. Pass an explicit provider id to honor a
 * per-episode or per-host choice; with no argument this falls back to the
 * TTS_PROVIDER env default. Unknown/missing ids resolve to the stub.
 */
export function getTTSProvider(providerName?: string): TTSProvider {
  const providerType = (providerName || process.env.TTS_PROVIDER || "stub").toLowerCase();

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
