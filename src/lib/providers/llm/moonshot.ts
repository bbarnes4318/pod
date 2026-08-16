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
      // TEMPERATURE IS PINNED TO 1, and this is the fix for a real dead end.
      //
      // Kimi rejects any other value outright:
      //
      //   HTTP 400 — "invalid temperature: only 1 is allowed for this model"
      //
      // Every caller in this pipeline passes a creative temperature (0.6-0.8),
      // so EVERY Moonshot call 400'd. Combined with a stale credential that was
      // returning 404s, the provider looked permanently unreachable and Kimi was
      // written off as "not available to this account" in two separate places —
      // including the comment at the top of this file.
      //
      // It was never an access problem. Verified 2026-08-15 with temperature 1:
      // kimi-k3 and kimi-k2.6 both return schema-valid dialogue. This field
      // overwrites the caller's value because shapeModelFields is applied AFTER
      // the generic temperature assignment in openaiCompatible.
      fields: { temperature: 1 },
      maxTokensAdd: headroom,
      diagnostics: {
        reasoningRequested: false,
        note:
          `moonshot-kimi: temperature FORCED to 1 (the only value this model accepts; anything else is a 400), ` +
          `plus +${headroom} tokens of ANSWER HEADROOM because this model reasons by default and bills it ` +
          `against max_tokens. Caller wanted reasoning: ${ctx.wantsReasoning}. ` +
          "A reasoning-only response is still reported as output_limit, never as an empty success.",
      },
    };
  }
}

export default MoonshotLLMProvider;
