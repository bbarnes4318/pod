import { LLMProvider } from "./interface";
import { StubLLMProvider } from "./stub";
import { OpenAILLMProvider } from "./openai";
import { AnthropicLLMProvider } from "./anthropic";
import { NvidiaNimLLMProvider } from "./nvidia";
import { ZaiLLMProvider } from "./zai";
import { XaiLLMProvider } from "./xai";
import { MoonshotLLMProvider } from "./moonshot";
import { GoogleLLMProvider } from "./google";
import { LEGACY_ANTHROPIC_VERIFY_MODEL } from "./routing";

export function getLLMProvider(opts: { provider?: string; model?: string } = {}): LLMProvider {
  const providerType = (opts.provider || process.env.LLM_PROVIDER || "stub").toLowerCase();

  switch (providerType) {
    case "openai":
      return new OpenAILLMProvider(opts.model);
    case "anthropic":
      return new AnthropicLLMProvider(opts.model);
    // NVIDIA NIM and Z.ai share the OpenAI wire protocol but are their OWN
    // providers: each records its own name in the cost ledger, carries its own
    // credential and timeout configuration, and has its own capability records.
    // Never fold them into the "openai" case.
    case "nvidia":
      return new NvidiaNimLLMProvider(opts.model);
    case "zai":
      return new ZaiLLMProvider(opts.model);
    // Same rule as NVIDIA and Z.ai above: these speak the OpenAI wire protocol
    // but are their OWN providers, with their own credentials, cost records and
    // capability entries. Folding any of them into the "openai" case would make
    // the ledger lie about who wrote an episode and would break the judge
    // independence check, which decides by PROVIDER.
    case "xai":
      return new XaiLLMProvider(opts.model);
    case "moonshot":
      return new MoonshotLLMProvider(opts.model);
    case "google":
      return new GoogleLLMProvider(opts.model);
    case "stub":
    default:
      return new StubLLMProvider();
  }
}

/** Providers this factory can build. */
export const SUPPORTED_LLM_PROVIDERS = [
  "nvidia",
  "zai",
  "anthropic",
  "xai",
  "moonshot",
  "google",
  // OpenAI stays BUILDABLE but is routed nowhere: it is in no profile chain, no
  // role default and no evaluation slate. Kept so an operator can still reach it
  // deliberately, removed from everything that would select it silently.
  "openai",
  "stub",
] as const;

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
 * cheaper model than the script writer by default when the chain resolves to
 * Anthropic. Override via VERIFY_LLM_PROVIDER / VERIFY_MODEL. Non-Anthropic and
 * stub chains keep their existing model — we never silently upgrade "stub" to a
 * paid call.
 */
export function resolveVerifyLLMConfig(): { provider: string; model?: string } {
  const base = resolveFactCheckLLMConfig();
  const provider = (process.env.VERIFY_LLM_PROVIDER || base.provider).toLowerCase();
  const model =
    process.env.VERIFY_MODEL ||
    (provider === "anthropic" ? LEGACY_ANTHROPIC_VERIFY_MODEL : base.model);
  return { provider, model };
}

export function getVerifyLLMProvider(): LLMProvider {
  const cfg = resolveVerifyLLMConfig();
  return getLLMProvider({ provider: cfg.provider, model: cfg.model });
}

/**
 * Role-based routing is the preferred entry point for new call sites; these
 * grouped helpers remain because they ARE the legacy contract.
 *
 *   getRoleLLMProvider("script_movement")   // routed, profile-aware
 *   getScriptLLMProvider()                  // SCRIPT_LLM_* only
 *
 * See routing.ts for the resolution order and roles.ts for the role list.
 */
export { getRoleLLMProvider, resolveRolePlan, roleRouteReport } from "./routing";
export type { LLMRole } from "./roles";

export default getLLMProvider;
