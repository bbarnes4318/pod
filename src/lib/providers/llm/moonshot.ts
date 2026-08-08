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

  /**
   * OBSERVED 2026-08-06, and it is the same trap Z.ai's GLM set: kimi-k3 REASONS
   * BY DEFAULT and bills that reasoning against max_tokens. Every fixture in the
   * first evaluation run came back `finish_reason: length` with completely empty
   * content — the model spent the whole allowance thinking and never wrote an
   * answer. Scored naively that reads as "this model cannot write", when the
   * truth is that it was never given room to.
   *
   * There is no documented switch to disable it, so the fix is headroom rather
   * than suppression: raise the ceiling so the answer has somewhere to go. This
   * mirrors shapeZaiRequest, which exists for exactly this reason.
   */
  protected shapeModelFields(ctx: ShapeContext): ShapeResult {
    const configured = Number(readRoutingEnv("MOONSHOT_REASONING_HEADROOM_TOKENS"));
    const headroom = Number.isFinite(configured) && configured > 0 ? Math.round(configured) : 2048;
    return {
      fields: {},
      maxTokensAdd: headroom,
      diagnostics: {
        reasoningRequested: false,
        note:
          `moonshot-kimi: no provider-specific fields sent, but +${headroom} tokens of ANSWER HEADROOM are added because ` +
          `this model reasons by default and bills it against max_tokens. Caller wanted reasoning: ${ctx.wantsReasoning}. ` +
          "A reasoning-only response is still reported as output_limit, never as an empty success.",
      },
    };
  }
}

export default MoonshotLLMProvider;
