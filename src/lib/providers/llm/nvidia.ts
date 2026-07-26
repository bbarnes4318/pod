// NVIDIA NIM hosted endpoints (build.nvidia.com / integrate.api.nvidia.com).
//
// Hosted NIM is a free service intended for development, prototyping and
// evaluation — which is exactly this application's stage — so it is an ACTIVE
// primary provider here, not a curiosity. What that status implies:
//
//   - Capacity is shared and rate limits are real: a 429 is expected traffic
//     shaping, handled by the base class's backoff, and the role's Z.ai
//     secondary picks up when the limit persists.
//   - Model ids come from the NVIDIA catalog and can be renamed there. Every id
//     is env-overridable (NVIDIA_MODEL_*), and the capability registry marks
//     them unverified until a live probe confirms them, so nothing here can
//     silently shrink a caller's request on the strength of a guess.
//   - APP_DEPLOYMENT_STAGE=live produces an advisory about the trial nature of
//     the endpoint. It never disables it — see deploymentStage.ts.

import {
  OpenAICompatibleConfig,
  OpenAICompatibleLLMProvider,
  numberFromEnv,
  requireApiKey,
} from "./openaiCompatible";
import { MODEL_IDS } from "./capabilities";
import { readRoutingEnv } from "./routingEnv";

export const NVIDIA_DEFAULT_BASE_URL = "https://integrate.api.nvidia.com/v1";

export class NvidiaNimLLMProvider extends OpenAICompatibleLLMProvider {
  constructor(modelOverride?: string) {
    const model =
      modelOverride || readRoutingEnv("NVIDIA_MODEL") || MODEL_IDS.nvidia.deepseekFlash;
    const config: OpenAICompatibleConfig = {
      provider: "nvidia",
      model,
      baseUrl: readRoutingEnv("NVIDIA_BASE_URL") || NVIDIA_DEFAULT_BASE_URL,
      apiKey: requireApiKey(
        "nvidia",
        "NVIDIA_API_KEY",
        "NVIDIA NIM",
        "Create a key at build.nvidia.com and set NVIDIA_API_KEY on BOTH the web and worker services.",
      ),
      timeoutMs: numberFromEnv("NVIDIA_REQUEST_TIMEOUT_MS", 240_000),
      maxRetries: numberFromEnv("NVIDIA_MAX_RETRIES", 2),
      // Declared, unverified: NIM reasoning models are driven through the chat
      // template rather than a top-level field. If a model rejects it, the base
      // class drops the field once and re-sends (recorded as a parameter
      // downgrade, never as a transient retry).
      reasoningSpelling: "chat_template_kwargs",
      unpriced: true,
    };
    super(config);
  }
}

export default NvidiaNimLLMProvider;
