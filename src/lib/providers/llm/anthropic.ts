import { LLMProvider, LLMUsage, GenerateTextOptions, GenerateStructuredOutputOptions } from "./interface";
import { recordLlmCall } from "./costLedger";

/**
 * Anthropic Claude provider, hardened for modern models (Opus 4.7/4.8,
 * Sonnet 5, Fable 5):
 *
 * - Model-aware parameters: Opus 4.7+/Sonnet 5/Fable 5 REJECT temperature/
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
    this.model = modelOverride || process.env.ANTHROPIC_MODEL || "claude-opus-4-8";
  }

  getAccumulatedUsage(): LLMUsage {
    return { ...this.usage };
  }

  /** Opus 4.7+, Sonnet 5, and Fable 5 reject sampling params (400). */
  private supportsSampling(): boolean {
    const m = this.model.toLowerCase();
    return !(
      m.includes("opus-4-7") ||
      m.includes("opus-4-8") ||
      m.includes("sonnet-5") ||
      m.includes("fable") ||
      m.includes("mythos")
    );
  }

  /** Models where adaptive thinking is supported and worth enabling. */
  private supportsAdaptiveThinking(): boolean {
    const m = this.model.toLowerCase();
    return (
      m.includes("opus-4-6") ||
      m.includes("opus-4-7") ||
      m.includes("opus-4-8") ||
      m.includes("sonnet-4-6") ||
      m.includes("sonnet-5") ||
      m.includes("fable") ||
      m.includes("mythos")
    );
  }

  private buildBody(options: GenerateTextOptions, systemPrompt: string | undefined): Record<string, any> {
    const body: Record<string, any> = {
      model: this.model,
      messages: [{ role: "user", content: options.prompt }],
      max_tokens: options.maxTokens || 8192,
    };
    if (systemPrompt) {
      body.system = systemPrompt;
    }
    if (this.supportsSampling()) {
      if (options.temperature !== undefined) body.temperature = options.temperature;
    } else if (this.supportsAdaptiveThinking()) {
      // Adaptive thinking is the quality lever on these models (sampling
      // params are gone). Not on by default on Opus 4.7/4.8 — set explicitly.
      body.thinking = { type: "adaptive" };
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
            recordLlmCall({
              provider: this.name,
              model: this.model,
              tkIn: u.input_tokens || 0,
              tkOut: u.output_tokens || 0,
              tkCacheRead: u.cache_read_input_tokens || 0,
              tkCacheWrite: u.cache_creation_input_tokens || 0,
              durationMs: Date.now() - startedAt,
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
