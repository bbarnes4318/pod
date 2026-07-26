import { LLMProvider } from "./interface";
import { StubLLMProvider } from "./stub";
import { OpenAILLMProvider } from "./openai";
import { AnthropicLLMProvider } from "./anthropic";
import { GeminiLLMProvider } from "./gemini";

/** Every provider this factory can build. Exported so readiness checks and the
 *  configuration UI validate against the SAME list the factory switches on,
 *  rather than a second copy that drifts. */
export const SUPPORTED_LLM_PROVIDERS = ["gemini", "anthropic", "openai", "stub"] as const;
export type SupportedLLMProvider = (typeof SUPPORTED_LLM_PROVIDERS)[number];

export function isSupportedLLMProvider(value: string): value is SupportedLLMProvider {
  return (SUPPORTED_LLM_PROVIDERS as readonly string[]).includes(value);
}

export function getLLMProvider(opts: { provider?: string; model?: string } = {}): LLMProvider {
  const providerType = (opts.provider || process.env.LLM_PROVIDER || "stub").toLowerCase();

  switch (providerType) {
    case "gemini":
      return new GeminiLLMProvider(opts.model);
    case "openai":
      return new OpenAILLMProvider(opts.model);
    case "anthropic":
      return new AnthropicLLMProvider(opts.model);
    case "stub":
      return new StubLLMProvider();
    default:
      // An unrecognised value used to fall through to the stub, which turns a
      // typo ("gemeni") into placeholder content that looks like a model
      // quality problem. Naming the value and the legal set makes it a
      // one-line fix instead of an investigation.
      throw new Error(
        `[LLM] Unknown provider '${providerType}'. Supported: ${SUPPORTED_LLM_PROVIDERS.join(", ")}. ` +
          `Check LLM_PROVIDER / SCRIPT_LLM_PROVIDER / FACTCHECK_LLM_PROVIDER / VERIFY_LLM_PROVIDER.`
      );
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

/**
 * Every provider a configured stage would actually construct, keyed by role.
 *
 * Readiness previously resolved only LLM_PROVIDER and SCRIPT_LLM_PROVIDER, so a
 * deployment whose VERIFY_LLM_PROVIDER pointed at a provider with no key passed
 * the audit and then failed at the fact-check stage — after paying for a script.
 * Resolving all four roles HERE, next to the functions that build them, is what
 * stops the readiness list and the factory from disagreeing.
 *
 * Note the roles inherit: factcheck falls back to script, script falls back to
 * global, verify falls back to factcheck. A mixed configuration is normal, not
 * an edge case.
 */
export function resolveConfiguredLLMProviders(): {
  byRole: Record<"global" | "script" | "factcheck" | "verify", { provider: string; model?: string }>;
  providers: Set<string>;
} {
  const global = (process.env.LLM_PROVIDER || "").trim().toLowerCase();
  const script = (process.env.SCRIPT_LLM_PROVIDER || global).trim().toLowerCase();
  const factcheck = resolveFactCheckLLMConfig();
  const verify = resolveVerifyLLMConfig();

  const byRole = {
    global: { provider: global, model: undefined as string | undefined },
    script: { provider: script, model: process.env.SCRIPT_LLM_MODEL || undefined },
    factcheck,
    verify,
  };
  const providers = new Set(
    Object.values(byRole)
      .map((r) => r.provider)
      .filter((p): p is string => Boolean(p))
  );
  return { byRole, providers };
}

export default getLLMProvider;
