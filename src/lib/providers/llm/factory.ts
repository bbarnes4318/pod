import { LLMProvider } from "./interface";
import { StubLLMProvider } from "./stub";

export function getLLMProvider(): LLMProvider {
  const providerType = process.env.LLM_PROVIDER?.toLowerCase() || "stub";

  switch (providerType) {
    case "openai":
      console.log("[LLMFactory] OpenAI requested (not fully implemented in architectural stub phase). Falling back to Stub.");
      return new StubLLMProvider();
    case "anthropic":
      console.log("[LLMFactory] Anthropic requested (not fully implemented in architectural stub phase). Falling back to Stub.");
      return new StubLLMProvider();
    case "stub":
    default:
      return new StubLLMProvider();
  }
}

export default getLLMProvider;
