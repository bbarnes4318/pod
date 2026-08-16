// Cerebras — OpenAI-compatible chat completions at api.cerebras.ai.
//
// WHY THIS PROVIDER EXISTS: it is the fastest endpoint we have measured for
// SCHEMA-CONSTRAINED output, by a margin that is not close.
//
// MEASURED 2026-08-15, identical request, identical model id, identical schema:
//
//   cerebras  gpt-oss-120b  strict schema     703 ms   valid
//   groq      gpt-oss-120b  strict schema   5,238 ms   valid
//   nvidia    gpt-oss-120b  strict schema  300,775 ms  TIMED OUT
//
// A 428x spread on the same open weights. The free tier was never slow because
// the models were weak — it was slow because it sat on the wrong endpoints. The
// incumbent free verification rung (nemotron on NVIDIA) took 584,006 ms and then
// failed schema validation after a repair pass.
//
// STRICT MODE IS THE POINT. Cerebras runs constrained decoding for `strict:
// true`, which makes invalid JSON structurally impossible rather than merely
// unlikely. `structured_output_invalid_after_repair` is the single failure that
// killed the previous free tier, and this is the only free path that removes it
// instead of retrying past it.
//
// SCHEMA LIMITS, from Cerebras' docs and checked against our own payloads:
//   - 5,000 characters max        (our host-writer schema: 721)
//   - 10 levels of nesting max    (ours: 3)
//   - 500 object properties max
//   - top-level MUST be type "object", and EVERY object needs
//     additionalProperties:false — see openaiCompatible's strict-schema handling.
//
// NOT FOR PROSE. gpt-oss-120b scores 35.8 on EQ-Bench longform creative writing,
// near the bottom of the board (Opus 5 is 86.3, GLM-5.2 is 77.9). It is excellent
// at emitting a turn plan and hopeless at writing a line a listener would enjoy.
// Keep it on structural and judging roles; never route a host writer here.

import {
  OpenAICompatibleConfig,
  OpenAICompatibleLLMProvider,
  numberFromEnv,
  requireApiKey,
} from "./openaiCompatible";
import { ShapeContext, ShapeResult } from "./nvidiaRequestProfiles";
import { readRoutingEnv } from "./routingEnv";

export const CEREBRAS_DEFAULT_BASE_URL = "https://api.cerebras.ai/v1";

/** The only Cerebras models we have verified for strict structured output. */
export const CEREBRAS_DEFAULT_MODEL = "gpt-oss-120b";

export class CerebrasLLMProvider extends OpenAICompatibleLLMProvider {
  constructor(modelOverride?: string) {
    const model = modelOverride || readRoutingEnv("CEREBRAS_MODEL") || CEREBRAS_DEFAULT_MODEL;
    const config: OpenAICompatibleConfig = {
      provider: "cerebras",
      model,
      baseUrl: readRoutingEnv("CEREBRAS_BASE_URL") || CEREBRAS_DEFAULT_BASE_URL,
      apiKey: requireApiKey(
        "cerebras",
        "CEREBRAS_API_KEY",
        "Cerebras",
        "Create a free key at cloud.cerebras.ai and set CEREBRAS_API_KEY on BOTH the web and worker services.",
      ),
      // Deliberately short. A Cerebras call that has not answered in 60s is not
      // slow, it is broken — the measured p100 across every probe was 703 ms, so
      // a long timeout here would only convert a dead endpoint into a stalled
      // episode. The whole reason this provider is in the chain is latency.
      timeoutMs: numberFromEnv("CEREBRAS_REQUEST_TIMEOUT_MS", 60_000),
      maxRetries: numberFromEnv("CEREBRAS_MAX_RETRIES", 2),
      // Free tier. An explicit 0 rate is a MEASUREMENT (see costLedger's note on
      // unpriced vs zero); operators who move to a paid Cerebras plan set
      // LLM_PRICE_CEREBRAS_IN / _OUT rather than editing this.
      unpriced: true,
    };
    super(config);
  }

  /**
   * NOTHING PROVIDER-SPECIFIC IS SENT, and that is a measured result rather than
   * an omission.
   *
   * The Z.ai and Moonshot providers both have to add reasoning headroom because
   * those models reason by default and bill it against max_tokens, returning an
   * empty answer with `finish_reason: length`. gpt-oss on Cerebras does not do
   * that: every probe on 2026-08-15 returned complete, schema-valid content in
   * 531-703 ms with plain `max_tokens` and no extra fields.
   *
   * Adding speculative reasoning knobs here would be the mistake this codebase
   * has already made twice — shaping a request for a behaviour the endpoint does
   * not exhibit, then reading the resulting failure as a model weakness.
   */
  protected shapeModelFields(ctx: ShapeContext): ShapeResult {
    return {
      fields: {},
      maxTokensAdd: 0,
      diagnostics: {
        reasoningRequested: false,
        note:
          `cerebras: no provider-specific fields sent. Measured 703 ms for a strict-schema ` +
          `call with plain max_tokens and complete content. Caller wanted reasoning: ${ctx.wantsReasoning}.`,
      },
    };
  }
}

export default CerebrasLLMProvider;
