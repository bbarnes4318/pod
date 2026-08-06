// Moonshot (Kimi) — OpenAI-compatible chat completions at api.moonshot.ai.
//
// WHY THIS PROVIDER IS HERE: Kimi K3 is the strongest non-Anthropic model on
// public creative-writing evaluation, from a lab with no shared lineage with
// Anthropic. That combination is exactly what the SECOND HOST WRITER needs.
//
// The host-convergence problem this codebase keeps hitting is not a prompt
// problem. Two isolated briefs handed to one model produce two versions of that
// model. Fixing it requires a genuinely different writer behind Host B, and a
// weak one would just trade convergence for a bad second host. A top-tier model
// from an unrelated lab is the only shape that solves both at once.
//
// Whether it actually writes a better Host B than the alternatives is settled by
// `npm run eval:models` on our fixtures. This comment is a rationale for testing
// it, not a result.
//
// NOTE: the docs host moved from platform.moonshot.ai to platform.kimi.ai, but
// the API base URL below is still the documented production endpoint.

import {
  OpenAICompatibleConfig,
  OpenAICompatibleLLMProvider,
  numberFromEnv,
  requireApiKey,
} from "./openaiCompatible";
import { MODEL_IDS } from "./capabilities";
import { ShapeContext, ShapeResult } from "./nvidiaRequestProfiles";
import { readRoutingEnv } from "./routingEnv";

export const MOONSHOT_DEFAULT_BASE_URL = "https://api.moonshot.ai/v1";

export class MoonshotLLMProvider extends OpenAICompatibleLLMProvider {
  constructor(modelOverride?: string) {
    const model = modelOverride || readRoutingEnv("MOONSHOT_MODEL") || MODEL_IDS.moonshot.kimiK3;
    const config: OpenAICompatibleConfig = {
      provider: "moonshot",
      model,
      baseUrl: readRoutingEnv("MOONSHOT_BASE_URL") || MOONSHOT_DEFAULT_BASE_URL,
      apiKey: requireApiKey(
        "moonshot",
        "MOONSHOT_API_KEY",
        "Moonshot (Kimi)",
        "Create a key at platform.moonshot.ai and set MOONSHOT_API_KEY on BOTH the web and worker services.",
      ),
      timeoutMs: numberFromEnv("MOONSHOT_REQUEST_TIMEOUT_MS", 240_000),
      maxRetries: numberFromEnv("MOONSHOT_MAX_RETRIES", 2),
      unpriced: true,
    };
    super(config);
  }

  /** See xai.ts — nothing provider-specific until a live probe says otherwise. */
  protected shapeModelFields(ctx: ShapeContext): ShapeResult {
    return {
      fields: {},
      diagnostics: {
        reasoningRequested: false,
        note:
          "moonshot-kimi: no provider-specific fields sent. " +
          `Caller wanted reasoning: ${ctx.wantsReasoning}.`,
      },
    };
  }
}

export default MoonshotLLMProvider;
