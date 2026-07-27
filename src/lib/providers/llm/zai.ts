// Z.ai — independent free provider and launch candidate.
//
// IMPORTANT, AND EASY TO GET WRONG: Z.ai publishes two different APIs. The
// coding-plan endpoint (an Anthropic-shaped API sold with a coding subscription)
// is NOT what this application uses. This provider talks to the GENERAL-PURPOSE
// OpenAI-compatible API at https://api.z.ai/api/paas/v4, which is why the base
// URL default is spelled out here rather than assembled from a hostname.
//
// Z.ai's role in the architecture is deliberate: it is the secondary for every
// NVIDIA-primary role AND the sole provider of the free_independent profile, so
// the whole production chain can be exercised without NVIDIA hosted capacity.
// Its free tier is quota-limited — a 429 whose body mentions quota/credit is
// classified as quota_exhausted rather than transient, so the chain moves on
// instead of retrying against an exhausted allowance.

import {
  OpenAICompatibleConfig,
  OpenAICompatibleLLMProvider,
  numberFromEnv,
  requireApiKey,
} from "./openaiCompatible";
import { MODEL_IDS } from "./capabilities";
import { ShapeContext, ShapeResult, shapeZaiRequest } from "./nvidiaRequestProfiles";
import { readRoutingEnv } from "./routingEnv";

export const ZAI_DEFAULT_BASE_URL = "https://api.z.ai/api/paas/v4";

export class ZaiLLMProvider extends OpenAICompatibleLLMProvider {
  constructor(modelOverride?: string) {
    const model = modelOverride || readRoutingEnv("ZAI_MODEL") || MODEL_IDS.zai.glmFlash;
    const config: OpenAICompatibleConfig = {
      provider: "zai",
      model,
      baseUrl: readRoutingEnv("ZAI_BASE_URL") || ZAI_DEFAULT_BASE_URL,
      apiKey: requireApiKey(
        "zai",
        "ZAI_API_KEY",
        "Z.ai",
        "Create a key for the GENERAL-PURPOSE API (not the coding plan) at z.ai and set ZAI_API_KEY on BOTH the web and worker services.",
      ),
      timeoutMs: numberFromEnv("ZAI_REQUEST_TIMEOUT_MS", 240_000),
      maxRetries: numberFromEnv("ZAI_MAX_RETRIES", 2),
      unpriced: true,
    };
    super(config);
  }

  /** GLM's top-level thinking object — a different vendor, a different contract. */
  protected shapeModelFields(ctx: ShapeContext): ShapeResult {
    return shapeZaiRequest(ctx);
  }
}

export default ZaiLLMProvider;
