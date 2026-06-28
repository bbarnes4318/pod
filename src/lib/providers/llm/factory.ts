import { LLMProvider } from "./interface";
import { StubLLMProvider } from "./stub";
import { OpenAILLMProvider } from "./openai";
import { AnthropicLLMProvider } from "./anthropic";

export function getLLMProvider(): LLMProvider {
  const providerType = process.env.LLM_PROVIDER?.toLowerCase() || "stub";

  switch (providerType) {
    case "openai":
      return new OpenAILLMProvider();
    case "anthropic":
      return new AnthropicLLMProvider();
    case "stub":
    default:
      return new StubLLMProvider();
  }
}

export default getLLMProvider;
