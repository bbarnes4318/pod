// Groq — OpenAI-compatible chat completions at api.groq.com.
//
// WHY THIS PROVIDER EXISTS: it is the FALLBACK for schema-constrained output,
// behind Cerebras. Same model id, different company, so a failover changes the
// endpoint without changing the output shape — cross-provider redundancy we have
// never had on the free path, where every previous rung was a different model
// with a different failure mode.
//
// MEASURED 2026-08-15, identical request and schema:
//
//   groq  openai/gpt-oss-120b  strict   5,238 ms   valid
//   groq  openai/gpt-oss-20b   strict   1,344 ms   valid
//
// Slower than Cerebras' 703 ms, still three orders of magnitude better than the
// 584,006 ms nemotron rung it replaces.
//
// ⚠️ THE TRAP THIS FILE EXISTS TO DOCUMENT.
//
// Strict schema works on `openai/gpt-oss-20b` and `openai/gpt-oss-120b` ONLY.
// Every other Groq model IGNORES `strict` — and `llama-3.3-70b-versatile`, the
// model that headlines essentially every "best free LLM API" article, rejects
// `response_format: json_schema` outright:
//
//   HTTP 400 — "This model does not support response format `json_schema`"
//
// Measured, not inferred, in both strict and non-strict mode. Wiring Llama here
// on the strength of a listicle would have broken every structured role in the
// pipeline at once. That is why GROQ_STRICT_SCHEMA_MODELS is enforced below
// rather than left as a comment.
//
// Groq's catalogue on this account is small: gpt-oss 20b/120b, llama-3.1-8b-
// instant, llama-3.3-70b-versatile, qwen3.6-27b, plus whisper and guard models.
// `moonshotai/kimi-k2-instruct` is NOT available (404).
//
// NOT FOR PROSE — same reason as Cerebras: gpt-oss-120b scores 35.8 on EQ-Bench
// longform creative writing, gpt-oss-20b scores 21.2. Structural roles only.

import {
  OpenAICompatibleConfig,
  OpenAICompatibleLLMProvider,
  numberFromEnv,
  requireApiKey,
} from "./openaiCompatible";
import { ShapeContext, ShapeResult } from "./nvidiaRequestProfiles";
import { readRoutingEnv } from "./routingEnv";

export const GROQ_DEFAULT_BASE_URL = "https://api.groq.com/openai/v1";

export const GROQ_DEFAULT_MODEL = "openai/gpt-oss-120b";

/**
 * The ONLY Groq models that honour a JSON schema. Verified by live probe, not
 * by reading the docs: everything else either silently ignores `strict` or 400s.
 */
export const GROQ_STRICT_SCHEMA_MODELS = ["openai/gpt-oss-120b", "openai/gpt-oss-20b"] as const;

export function groqSupportsStrictSchema(model: string): boolean {
  return (GROQ_STRICT_SCHEMA_MODELS as readonly string[]).includes(model);
}

export class GroqLLMProvider extends OpenAICompatibleLLMProvider {
  constructor(modelOverride?: string) {
    const model = modelOverride || readRoutingEnv("GROQ_MODEL") || GROQ_DEFAULT_MODEL;
    const config: OpenAICompatibleConfig = {
      provider: "groq",
      model,
      baseUrl: readRoutingEnv("GROQ_BASE_URL") || GROQ_DEFAULT_BASE_URL,
      apiKey: requireApiKey(
        "groq",
        "GROQ_API_KEY",
        "Groq",
        "Create a free key at console.groq.com and set GROQ_API_KEY on BOTH the web and worker services.",
      ),
      // Measured worst case was 5.2s; 60s is generous without letting a wedged
      // request hold an episode open the way the NVIDIA rungs did.
      timeoutMs: numberFromEnv("GROQ_REQUEST_TIMEOUT_MS", 60_000),
      maxRetries: numberFromEnv("GROQ_MAX_RETRIES", 2),
      unpriced: true,
    };
    super(config);
  }

  /**
   * No provider-specific fields, for the same measured reason as Cerebras: gpt-oss
   * on Groq returned complete, schema-valid content with plain max_tokens in
   * 1,344 ms (20b) and 5,238 ms (120b). No reasoning headroom is required, and
   * inventing one would shape the request for a behaviour this endpoint does not
   * have.
   */
  protected shapeModelFields(ctx: ShapeContext): ShapeResult {
    const strict = groqSupportsStrictSchema(this.model);
    return {
      fields: {},
      maxTokensAdd: 0,
      diagnostics: {
        reasoningRequested: false,
        note:
          `groq: no provider-specific fields sent. strictSchemaCapable=${strict}` +
          (strict
            ? "."
            : " — THIS MODEL IGNORES OR REJECTS json_schema (llama-3.3-70b returns HTTP 400). " +
              "Only openai/gpt-oss-120b and openai/gpt-oss-20b honour a schema on Groq.") +
          ` Caller wanted reasoning: ${ctx.wantsReasoning}.`,
      },
    };
  }
}

export default GroqLLMProvider;
