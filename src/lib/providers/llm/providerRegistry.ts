// THE ONE PLACE a provider NAME becomes a provider INSTANCE.
//
// WHY THIS FILE EXISTS. There used to be two switches: getLLMProvider() in
// factory.ts and instantiateProvider() in routing.ts. On 2026-08-06 three new
// providers were added to the factory and not to the router. Every ordinary
// call worked. Every ROUTED call threw "Unknown provider 'xai'". The live smoke
// test passed, because it goes through the factory — and a paid evaluation run
// generated nine scripts' worth of API calls and produced nothing before anyone
// saw it.
//
// Two lists of the same thing will drift, and the drift will be invisible from
// whichever one you happen to test. So there is one list, and both callers ask
// it. Adding a provider means editing this file and nothing else.
//
// buildProvider returns NULL for an unknown name rather than throwing, because
// the two callers must fail differently and both are right: the factory falls
// back to the stub (an unset LLM_PROVIDER is normal in development), while the
// router raises a categorized error (a routed name that cannot be built is a
// real configuration defect and must stop the chain).

import { LLMProvider } from "./interface";
import { StubLLMProvider } from "./stub";
import { OpenAILLMProvider } from "./openai";
import { AnthropicLLMProvider } from "./anthropic";
import { NvidiaNimLLMProvider } from "./nvidia";
import { ZaiLLMProvider } from "./zai";
import { XaiLLMProvider } from "./xai";
import { MoonshotLLMProvider } from "./moonshot";
import { GoogleLLMProvider } from "./google";

/**
 * Every provider this application can build.
 *
 * OpenAI is present but is routed NOWHERE — no profile chain, no role default,
 * no evaluation slate. It stays buildable so an operator can reach it on
 * purpose, and is absent from everything that could select it silently.
 */
export const SUPPORTED_LLM_PROVIDERS = [
  "nvidia",
  "zai",
  "anthropic",
  "xai",
  "moonshot",
  "google",
  "openai",
  "stub",
] as const;

export type SupportedLlmProvider = (typeof SUPPORTED_LLM_PROVIDERS)[number];

export function isSupportedProvider(name: string): name is SupportedLlmProvider {
  return (SUPPORTED_LLM_PROVIDERS as readonly string[]).includes(name.toLowerCase());
}

/** Human-readable list for error messages, so they cannot go stale either. */
export function supportedProviderList(): string {
  return SUPPORTED_LLM_PROVIDERS.join(", ");
}

/**
 * Build a provider by name, or null when nothing is registered under that name.
 *
 * NVIDIA, Z.ai, xAI, Moonshot and Google all speak the OpenAI wire protocol, but
 * each is its OWN provider: its own credential, its own cost-ledger name, its
 * own capability records. Folding any of them into the "openai" case would make
 * the ledger misreport who wrote an episode and would break judge independence,
 * which is decided by PROVIDER.
 */
export function buildProvider(provider: string, model?: string): LLMProvider | null {
  switch (provider.toLowerCase()) {
    case "nvidia":
      return new NvidiaNimLLMProvider(model);
    case "zai":
      return new ZaiLLMProvider(model);
    case "anthropic":
      return new AnthropicLLMProvider(model);
    case "xai":
      return new XaiLLMProvider(model);
    case "moonshot":
      return new MoonshotLLMProvider(model);
    case "google":
      return new GoogleLLMProvider(model);
    case "openai":
      return new OpenAILLMProvider(model);
    case "stub":
      return new StubLLMProvider();
    default:
      return null;
  }
}
