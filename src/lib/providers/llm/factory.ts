import { LLMProvider } from "./interface";
import { StubLLMProvider } from "./stub";
import { OpenAILLMProvider } from "./openai";
import { AnthropicLLMProvider } from "./anthropic";

export function getLLMProvider(opts: { provider?: string; model?: string } = {}): LLMProvider {
  const providerType = (opts.provider || process.env.LLM_PROVIDER || "stub").toLowerCase();

  switch (providerType) {
    case "openai":
      return new OpenAILLMProvider(opts.model);
    case "anthropic":
      return new AnthropicLLMProvider(opts.model);
    case "stub":
    default:
      return new StubLLMProvider();
  }
}

/**
 * LLM used for script WRITING specifically. Dialogue quality is extremely
 * model-sensitive, so this can be pointed at a stronger model than the rest
 * of the pipeline via SCRIPT_LLM_PROVIDER / SCRIPT_LLM_MODEL.
 */
export function getScriptLLMProvider(): LLMProvider {
  return getLLMProvider({
    provider: process.env.SCRIPT_LLM_PROVIDER || process.env.LLM_PROVIDER,
    model: process.env.SCRIPT_LLM_MODEL || undefined,
  });
}

export default getLLMProvider;
