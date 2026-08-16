// OpenRouter — one credential, many labs, OpenAI-compatible.
//
// WHY THIS PROVIDER EXISTS: it is the only route we have measured that makes
// Kimi both FAST and AFFORDABLE, and Kimi is the strongest non-Anthropic writer
// on public creative-writing evaluation.
//
// MEASURED 2026-08-15, identical request, identical schema, temperature 1:
//
//   openrouter  moonshotai/kimi-k2.6    420 ms   schema OK   95 words
//   openrouter  moonshotai/kimi-k3      574 ms   schema OK   87 words
//   moonshot    kimi-k3              19,192 ms   schema OK   91 words
//   moonshot    kimi-k2.6            45,443 ms   schema OK   47 words
//
// The same K2.6 weights are 108x faster here than on Moonshot's own endpoint.
// This is the third time in one investigation that the PROVIDER, not the model,
// decided whether a route was usable — see cerebras.ts for the other two.
//
// PRICING (per 1M tokens, read from OpenRouter's own /models response):
//   moonshotai/kimi-k2.6   $0.65 / $3.41    262k context
//   moonshotai/kimi-k3     $3.00 / $15.00   1M context
//   moonshotai/kimi-k2.5   $0.57 / $2.85
//
// K2.6 scores 78.5 on EQ-Bench longform creative writing — second only to Kimi
// K3 (79.6) among open models, and above Claude Sonnet 5 (78.3). Against the
// measured token counts of a real episode it writes both hosts for ~$0.16,
// where Opus 5 costs $0.89. That is the "balanced" tier: 83% off the writers for
// a 7.8-point drop in creative score.
//
// NOT FREE. OpenRouter's free allowance is 20 RPM / 50 requests per day, and an
// episode is 22 model calls — about two episodes before it stops. The rates
// above are the PAID ones and are what the balanced tier actually bills. Do not
// route the free tier here; see profiles.ts freeIndependentChain.
//
// TEMPERATURE: Kimi rejects anything but 1 with a 400 ("invalid temperature:
// only 1 is allowed for this model"). OpenRouter forwards that constraint, so
// the same pin moonshot.ts applies is applied here.

import {
  OpenAICompatibleConfig,
  OpenAICompatibleLLMProvider,
  numberFromEnv,
  requireApiKey,
} from "./openaiCompatible";
import { ShapeContext, ShapeResult } from "./nvidiaRequestProfiles";
import { readRoutingEnv } from "./routingEnv";

export const OPENROUTER_DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";

export const OPENROUTER_DEFAULT_MODEL = "moonshotai/kimi-k2.6";

/**
 * Models that reject any temperature other than 1. Kimi is the family we route
 * here; the pin is keyed on the model rather than the provider so a future
 * non-Kimi OpenRouter route keeps its caller's temperature.
 */
export function openrouterPinsTemperature(model: string): boolean {
  return /kimi|moonshot/i.test(model);
}

export class OpenRouterLLMProvider extends OpenAICompatibleLLMProvider {
  constructor(modelOverride?: string) {
    const model = modelOverride || readRoutingEnv("OPENROUTER_MODEL") || OPENROUTER_DEFAULT_MODEL;
    const config: OpenAICompatibleConfig = {
      provider: "openrouter",
      model,
      baseUrl: readRoutingEnv("OPENROUTER_BASE_URL") || OPENROUTER_DEFAULT_BASE_URL,
      apiKey: requireApiKey(
        "openrouter",
        "OPENROUTER_API_KEY",
        "OpenRouter",
        "Create a key at openrouter.ai/keys and set OPENROUTER_API_KEY on BOTH the web and worker services.",
      ),
      // Generous relative to the 420 ms we measured, because OpenRouter routes to
      // whichever upstream is healthiest and that choice varies per call — the
      // fast path is not guaranteed, and a writer call is not worth failing over
      // a transient slow backend.
      timeoutMs: numberFromEnv("OPENROUTER_REQUEST_TIMEOUT_MS", 180_000),
      maxRetries: numberFromEnv("OPENROUTER_MAX_RETRIES", 2),
      // Priced, not free. Rates come from LLM_PRICE_OPENROUTER_<MODEL>_IN/_OUT —
      // per-model, because this one credential reaches models whose rates differ
      // by 5x (see costLedger's per-model resolution).
      unpriced: false,
    };
    super(config);
  }

  protected shapeModelFields(ctx: ShapeContext): ShapeResult {
    const pin = openrouterPinsTemperature(this.model);
    const configured = Number(readRoutingEnv("OPENROUTER_REASONING_HEADROOM_TOKENS"));
    const headroom = Number.isFinite(configured) && configured > 0 ? Math.round(configured) : 2048;
    return {
      fields: pin ? { temperature: 1 } : {},
      // Kimi reasons by default and bills it against max_tokens. Measured on
      // 2026-08-15: a 2,000-token ceiling produced out=2000 with EMPTY content —
      // the model spent the whole allowance thinking. At 6,000 the same request
      // returned 95 words in 420 ms. Headroom, not suppression.
      maxTokensAdd: pin ? headroom : 0,
      diagnostics: {
        reasoningRequested: false,
        note:
          `openrouter: ${pin ? `temperature FORCED to 1 (Kimi rejects any other value with a 400) and +${headroom} answer headroom (this family reasons by default and bills it against max_tokens)` : "no provider-specific fields sent"}. ` +
          `Caller wanted reasoning: ${ctx.wantsReasoning}.`,
      },
    };
  }
}

export default OpenRouterLLMProvider;
