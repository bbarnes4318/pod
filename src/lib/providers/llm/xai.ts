// xAI (Grok) — OpenAI-compatible chat completions at api.x.ai.
//
// WHY THIS PROVIDER IS HERE, and what that claim is worth: Grok is the only
// frontier family carrying live X data and a documented low hallucination rate.
// Those map onto two roles this show has specific trouble with — story
// selection (what is actually being argued about right now) and fact-checking
// (the stage where this pipeline has historically inflated numbers).
//
// That is a reason to ENTER the bake-off, not a result. Which model wins which
// role is decided by `npm run eval:models` against our own fixtures and the
// stored blind scores. Nothing in this file is evidence of quality.
//
// Model ids are env-overridable on purpose: a vendor renaming a checkpoint is a
// one-variable fix, never a code change.

import {
  OpenAICompatibleConfig,
  OpenAICompatibleLLMProvider,
  numberFromEnv,
  requireApiKey,
} from "./openaiCompatible";
import { MODEL_IDS } from "./capabilities";
import { ShapeContext, ShapeResult } from "./nvidiaRequestProfiles";
import { readRoutingEnv } from "./routingEnv";

export const XAI_DEFAULT_BASE_URL = "https://api.x.ai/v1";

export class XaiLLMProvider extends OpenAICompatibleLLMProvider {
  constructor(modelOverride?: string) {
    const model = modelOverride || readRoutingEnv("XAI_MODEL") || MODEL_IDS.xai.grok43;
    const config: OpenAICompatibleConfig = {
      provider: "xai",
      model,
      baseUrl: readRoutingEnv("XAI_BASE_URL") || XAI_DEFAULT_BASE_URL,
      apiKey: requireApiKey(
        "xai",
        "XAI_API_KEY",
        "xAI",
        "Create a key at console.x.ai and set XAI_API_KEY on BOTH the web and worker services.",
      ),
      timeoutMs: numberFromEnv("XAI_REQUEST_TIMEOUT_MS", 240_000),
      maxRetries: numberFromEnv("XAI_MAX_RETRIES", 2),
      // No verified price table entry yet, so cost is recorded as null rather
      // than as a number nobody checked. `npm run probe:llm-contract` is what
      // upgrades this, the same as it does for every other provider here.
      unpriced: true,
    };
    super(config);
  }

  /**
   * No provider-specific fields. Grok's reasoning controls have not been
   * observed working from this application, and shaping a field nobody has
   * watched succeed is how a request starts failing in a way that cannot be
   * attributed. `npm run probe:llm-contract` is what changes this.
   */
  protected shapeModelFields(ctx: ShapeContext): ShapeResult {
    return {
      fields: {},
      diagnostics: {
        reasoningRequested: false,
        note:
          "xai-grok: no provider-specific fields sent, so no reasoning was REQUESTED even when the caller wanted it. " +
          `Caller wanted reasoning: ${ctx.wantsReasoning}. Grok 4.x reasons on its own for many requests, so reasoning ` +
          "content coming back does NOT mean this shaping asked for it.",
      },
    };
  }
}

export default XaiLLMProvider;
