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

/**
 * LLM used for semantic fact-checking. A weak checker rubber-stamps a strong
 * writer, so this defaults to the same model that WROTE the script
 * (SCRIPT_LLM_*), overridable via FACTCHECK_LLM_PROVIDER / FACTCHECK_LLM_MODEL,
 * falling back to the global LLM_PROVIDER. Only "stub" when none are set.
 */
export function resolveFactCheckLLMConfig(): { provider: string; model?: string } {
  if (process.env.FACTCHECK_LLM_PROVIDER) {
    return {
      provider: process.env.FACTCHECK_LLM_PROVIDER.toLowerCase(),
      model: process.env.FACTCHECK_LLM_MODEL || undefined,
    };
  }
  if (process.env.SCRIPT_LLM_PROVIDER) {
    return {
      provider: process.env.SCRIPT_LLM_PROVIDER.toLowerCase(),
      model: process.env.SCRIPT_LLM_MODEL || undefined,
    };
  }
  return {
    provider: (process.env.LLM_PROVIDER || "stub").toLowerCase(),
    model: undefined,
  };
}

export function getFactCheckLLMProvider(): LLMProvider {
  const cfg = resolveFactCheckLLMConfig();
  return getLLMProvider({ provider: cfg.provider, model: cfg.model });
}

/**
 * LLM used for VERIFICATION work: the self-verify grounding rewrites and the
 * semantic fact-check reviewer. These are structured grading/rewrite tasks
 * against supplied evidence — not creative generation — so they run on a
 * cheaper model than the script writer by default (claude-sonnet-5 when the
 * chain resolves to Anthropic). Override via VERIFY_LLM_PROVIDER /
 * VERIFY_MODEL. Non-Anthropic and stub chains keep their existing model — we
 * never silently upgrade "stub" to a paid call.
 */
export function resolveVerifyLLMConfig(): { provider: string; model?: string } {
  const base = resolveFactCheckLLMConfig();
  const provider = (process.env.VERIFY_LLM_PROVIDER || base.provider).toLowerCase();
  const model =
    process.env.VERIFY_MODEL ||
    (provider === "anthropic" ? "claude-sonnet-5" : base.model);
  return { provider, model };
}

export function getVerifyLLMProvider(): LLMProvider {
  const cfg = resolveVerifyLLMConfig();
  return getLLMProvider({ provider: cfg.provider, model: cfg.model });
}

export default getLLMProvider;
