import { LLMProvider, LLMUsage, GenerateTextOptions, GenerateStructuredOutputOptions } from "./interface";
import { estimateCostUsd, recordLlmCall } from "./costLedger";

/**
 * THE ONE PLACE an Anthropic model id is declared valid.
 *
 * An id that is not on this list is not merely unusual — it 404s, and it does so
 * at the moment the paid backup rung actually fires, which is the worst possible
 * time to discover a typo. `npm run test:anthropic-model-ids` asserts that the
 * in-code default and every id this repo configures is a member, so an invalid
 * default cannot ship silently. Adding a model means adding it HERE and adding a
 * classification row to the same test.
 *
 * Verified against Anthropic's current model catalog on 2026-08-11. The 5 family
 * (opus/sonnet/fable) and Haiku 4.5 are current; the 4.6/4.8 entries are older
 * generations that remain served and are legal to pin deliberately.
 */
export const ANTHROPIC_MODEL_ALLOWLIST = [
  "claude-opus-5",
  "claude-sonnet-5",
  "claude-fable-5",
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-sonnet-4-6",
  "claude-haiku-4-5",
  "claude-haiku-4-5-20251001",
] as const;

export type AnthropicModelId = (typeof ANTHROPIC_MODEL_ALLOWLIST)[number];

/**
 * The model used when neither a call-site override nor ANTHROPIC_MODEL is set.
 *
 * Opus 5 deliberately: this repository's settled decision is that Opus 5 writes
 * scripts. It is a current, valid id ($5/$25 per MTok) — an audit note claiming
 * otherwise was checked against the catalog on 2026-08-11 and did not hold.
 */
export const ANTHROPIC_DEFAULT_MODEL: AnthropicModelId = "claude-opus-5";

export function isAllowedAnthropicModel(model: string): boolean {
  return (ANTHROPIC_MODEL_ALLOWLIST as readonly string[]).includes(model);
}

/**
 * Opus 4.7+, Opus 5, Sonnet 5, and Fable 5 reject sampling params (400).
 * Matched by substring: "opus-5" cannot collide with "opus-4-5", and the
 * dated legacy ids (opus-4-5-20251101) keep their own separate entries.
 * A model NOT listed here is assumed to be an older one that still accepts
 * temperature — adding a new frontier model means adding it to both lists.
 *
 * Free function rather than a method so the classification can be asserted
 * per-id without constructing a provider (which requires a live credential).
 */
export function anthropicSupportsSampling(model: string): boolean {
  const m = model.toLowerCase();
  return !(
    m.includes("opus-4-7") ||
    m.includes("opus-4-8") ||
    m.includes("opus-5") ||
    m.includes("sonnet-5") ||
    m.includes("fable") ||
    m.includes("mythos")
  );
}

/**
 * Which quality lever buildBody actually pulls for a model.
 *
 * buildBody is an if/else: it sends `temperature` to a sampling-capable model
 * and only reaches the adaptive-thinking branch when sampling is NOT supported.
 * That is fine for every model whose two classifications are mutually exclusive,
 * and silently wrong for one that is BOTH — such a model gets temperature and no
 * thinking, and no thinking headroom either, with nothing anywhere saying so.
 *
 * Extracted as a named function so the branch a model takes is a value that can
 * be asserted, rather than a control-flow detail you have to re-derive by
 * reading two matchers and an if/else. Behaviour is unchanged.
 *
 *   "sampling"          — temperature is sent; thinking is NOT enabled
 *   "adaptive-thinking" — thinking:{type:"adaptive"} + max_tokens headroom
 *   "neither"           — no temperature, no thinking (pre-adaptive, or a model
 *                         that rejects sampling and has no adaptive support)
 */
export type AnthropicTuningMode = "sampling" | "adaptive-thinking" | "neither";

export function anthropicTuningMode(model: string): AnthropicTuningMode {
  if (anthropicSupportsSampling(model)) return "sampling";
  if (anthropicSupportsAdaptiveThinking(model)) return "adaptive-thinking";
  return "neither";
}

/**
 * Models the if/else above SHADOWS: both sampling-capable and adaptive-capable,
 * so the adaptive branch is unreachable for them. Empty is the healthy state.
 */
export function anthropicModelsWithShadowedThinking(): string[] {
  return ANTHROPIC_MODEL_ALLOWLIST.filter(
    (m) => anthropicSupportsSampling(m) && anthropicSupportsAdaptiveThinking(m)
  );
}

/** Models where adaptive thinking is supported and worth enabling. */
export function anthropicSupportsAdaptiveThinking(model: string): boolean {
  const m = model.toLowerCase();
  return (
    m.includes("opus-4-6") ||
    m.includes("opus-4-7") ||
    m.includes("opus-4-8") ||
    m.includes("opus-5") ||
    m.includes("sonnet-4-6") ||
    m.includes("sonnet-5") ||
    m.includes("fable") ||
    m.includes("mythos")
  );
}

/**
 * Anthropic Claude provider, hardened for modern models (Opus 5, Opus 4.7/4.8,
 * Sonnet 5, Fable 5):
 *
 * - Model-aware parameters: Opus 4.7+/Opus 5/Sonnet 5/Fable 5 REJECT temperature/
 *   top_p/top_k with a 400 — we only send temperature to models that accept
 *   it. Adaptive thinking is enabled on models that support it (it is NOT on
 *   by default on Opus 4.7/4.8 when the field is omitted).
 * - Response parsing finds the TEXT content block (with thinking enabled,
 *   content[0] can be a thinking block — never assume position 0).
 * - JSON forcing is instruction-based: assistant prefill returns a 400 on
 *   Opus 4.6+ so it must not be used. Parsing tolerates code fences and
 *   leading prose by extracting the outermost JSON object.
 * - Retries 429/500/529 (and network errors) with exponential backoff,
 *   honoring retry-after.
 * - Tracks cumulative token usage for cost reporting.
 */
export class AnthropicLLMProvider implements LLMProvider {
  name = "anthropic";
  private apiKey: string;
  private model: string;
  private usage: LLMUsage = { inputTokens: 0, outputTokens: 0, requestCount: 0 };

  constructor(modelOverride?: string) {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key || key === "your-anthropic-api-key") {
      throw new Error("[Anthropic] Missing or default ANTHROPIC_API_KEY environment variable. Set ANTHROPIC_API_KEY to use Claude for script generation.");
    }
    this.apiKey = key;
    this.model = modelOverride || process.env.ANTHROPIC_MODEL || ANTHROPIC_DEFAULT_MODEL;
  }

  getAccumulatedUsage(): LLMUsage {
    return { ...this.usage };
  }

  /** See anthropicSupportsSampling — the classification lives at module scope
   *  so it can be asserted per-id without a live credential. */
  private supportsSampling(): boolean {
    return anthropicSupportsSampling(this.model);
  }

  private supportsAdaptiveThinking(): boolean {
    return anthropicSupportsAdaptiveThinking(this.model);
  }

  private buildBody(options: GenerateTextOptions, systemPrompt: string | undefined): Record<string, any> {
    const body: Record<string, any> = {
      model: this.model,
      messages: [{ role: "user", content: options.prompt }],
      max_tokens: options.maxTokens || 8192,
    };
    // System prompt as content blocks with prompt-cache breakpoints. Within
    // one episode the big script system prompt / evidence packet is byte-
    // identical across many calls — the first call writes the cache (1.25x),
    // every later call reads it at 0.1x input price. cache_control on a
    // too-short prefix is a silent no-op, so the marker is always safe.
    const systemBlocks: any[] = [];
    if (systemPrompt) {
      systemBlocks.push({ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } });
    }
    if (options.cacheableContext) {
      systemBlocks.push({ type: "text", text: options.cacheableContext, cache_control: { type: "ephemeral" } });
    }
    if (systemBlocks.length > 0) {
      body.system = systemBlocks;
    }
    // Switch on the NAMED mode rather than re-deriving the if/else here, so the
    // branch this code takes and the branch anthropicTuningMode() reports can
    // never drift apart. Same behaviour as the original if/else.
    const mode = anthropicTuningMode(this.model);
    if (mode === "sampling") {
      if (options.temperature !== undefined) body.temperature = options.temperature;
    } else if (mode === "adaptive-thinking") {
      // Adaptive thinking is the quality lever on these models (sampling
      // params are gone). Not on by default on Opus 4.7/4.8 — set explicitly.
      body.thinking = { type: "adaptive" };
      // Thinking tokens COUNT AGAINST max_tokens. Callers size maxTokens for
      // the visible JSON/text they expect, so without headroom the thinking
      // spend truncates the answer mid-JSON (the v11 outline call died at
      // exactly its 8000 cap and forced the single-shot fallback; the semantic
      // reviewer's intermittent parse failures on v6-v9 were the same
      // mechanism). Headroom only raises the CAP — actual billed output is
      // whatever the model produces.
      const headroom = Number(process.env.LLM_THINKING_HEADROOM_TOKENS) || 8192;
      body.max_tokens = (options.maxTokens || 8192) + headroom;
    }
    // Effort is the cost/quality dial that replaced sampling params on these
    // models (API default is "high"). Left unset unless an operator opts in,
    // so behavior is unchanged until someone deliberately tunes it. Applies
    // only where adaptive thinking does — older models reject output_config.
    const effort = (process.env.LLM_EFFORT || "").trim().toLowerCase();
    if (effort && this.supportsAdaptiveThinking()) {
      body.output_config = { effort };
    }
    return body;
  }

  private async request(body: Record<string, any>): Promise<any> {
    const maxRetries = 2;
    let lastErr: Error | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const startedAt = Date.now();
      try {
        const response = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": this.apiKey,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify(body),
        });

        if (response.ok) {
          const data = await response.json();
          const u = data?.usage;
          if (u) {
            this.usage.inputTokens += u.input_tokens || 0;
            this.usage.outputTokens += u.output_tokens || 0;
            this.usage.requestCount += 1;
            // Measurement only: per-stage cost ledger, provider-reported counts.
            const tkIn = u.input_tokens || 0;
            const tkOut = u.output_tokens || 0;
            const tkCacheRead = u.cache_read_input_tokens || 0;
            const tkCacheWrite = u.cache_creation_input_tokens || 0;
            recordLlmCall({
              provider: this.name,
              model: this.model,
              tkIn,
              tkOut,
              tkCacheRead,
              tkCacheWrite,
              durationMs: Date.now() - startedAt,
              // This provider previously recorded no cost at all, so every
              // Anthropic call logged `cost=unpriced` no matter how the operator
              // configured LLM_PRICE_ANTHROPIC_*. Anthropic is the one PAID rung
              // in the chain, which made the unpriced calls exactly the ones
              // worth pricing. `unpriced: false` is not an assumption — it is
              // what capabilities.ts already declares for this provider.
              estimatedCostUsd: estimateCostUsd(
                this.name,
                { tkIn, tkOut, tkCacheRead, tkCacheWrite },
                false
              ),
            });
          }
          return data;
        }

        const errorText = await response.text();
        const retryable = response.status === 429 || response.status === 500 || response.status === 529;
        lastErr = new Error(`[Anthropic] API request failed with status ${response.status}: ${errorText}`);
        if (!retryable || attempt === maxRetries) {
          throw lastErr;
        }
        const retryAfter = Number(response.headers.get("retry-after"));
        const delayMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2000 * Math.pow(4, attempt);
        console.warn(`[Anthropic] ${response.status} — retrying in ${Math.round(delayMs / 1000)}s (attempt ${attempt + 1}/${maxRetries}).`);
        await new Promise((r) => setTimeout(r, delayMs));
      } catch (err: any) {
        if (err === lastErr) throw err; // non-retryable API error re-thrown above
        // Network-level failure — retry unless out of attempts
        lastErr = err;
        if (attempt === maxRetries) throw err;
        await new Promise((r) => setTimeout(r, 2000 * Math.pow(4, attempt)));
      }
    }
    throw lastErr || new Error("[Anthropic] Request failed.");
  }

  /** With thinking enabled, content[0] may be a thinking block — find the text. */
  private extractText(data: any): string {
    const blocks = Array.isArray(data?.content) ? data.content : [];
    const textBlock = blocks.find((b: any) => b?.type === "text" && typeof b.text === "string" && b.text.length > 0);
    if (!textBlock) {
      if (data?.stop_reason === "refusal") {
        throw new Error("[Anthropic] Request was refused by the model's safety system.");
      }
      throw new Error(`[Anthropic] No text content in response (stop_reason: ${data?.stop_reason}).`);
    }
    return textBlock.text as string;
  }

  async generateText(options: GenerateTextOptions): Promise<string> {
    console.log(`[Anthropic] Requesting messages via model: ${this.model}`);
    const data = await this.request(this.buildBody(options, options.systemPrompt));
    return this.extractText(data);
  }

  async generateStructuredOutput<T = any>(options: GenerateStructuredOutputOptions): Promise<T> {
    console.log(`[Anthropic] Requesting structured output (JSON forced) via model: ${this.model}`);

    // Instruction-based JSON forcing — assistant prefill 400s on Opus 4.6+.
    const systemPromptWithJson = `${options.systemPrompt || ""}\n\nCRITICAL: Respond with a single valid JSON object and nothing else. Start your response with '{' immediately — no markdown code fences, no preamble, no commentary after the closing '}'.`;

    const data = await this.request(this.buildBody(options, systemPromptWithJson));
    let content = this.extractText(data).trim();

    // Strip markdown code fences if present despite instructions
    if (content.startsWith("```")) {
      const lines = content.split("\n");
      if (lines[0].startsWith("```")) lines.shift();
      if (lines.length && lines[lines.length - 1].startsWith("```")) lines.pop();
      content = lines.join("\n").trim();
    }

    try {
      return JSON.parse(content) as T;
    } catch {
      // Last resort: extract the outermost JSON object from surrounding prose.
      const first = content.indexOf("{");
      const last = content.lastIndexOf("}");
      if (first !== -1 && last > first) {
        try {
          return JSON.parse(content.slice(first, last + 1)) as T;
        } catch (innerErr: any) {
          console.error("[Anthropic] Failed to parse JSON response content:", content.slice(0, 500));
          throw new Error(`[Anthropic] Failed to parse output as valid JSON: ${innerErr.message}`);
        }
      }
      console.error("[Anthropic] Failed to parse JSON response content:", content.slice(0, 500));
      throw new Error("[Anthropic] Failed to parse output as valid JSON: no JSON object found in response.");
    }
  }
}

export default AnthropicLLMProvider;
