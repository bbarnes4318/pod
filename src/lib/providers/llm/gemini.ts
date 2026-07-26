import { LLMProvider, LLMUsage, GenerateTextOptions, GenerateStructuredOutputOptions } from "./interface";
import { recordLlmCall } from "./costLedger";

/**
 * Google Gemini provider (native `generateContent` REST API).
 *
 * WHY NATIVE AND NOT THE OPENAI-COMPATIBLE SHIM
 *
 * Google exposes an OpenAI-compatible `/v1beta/openai/chat/completions`
 * endpoint, and copying the OpenAI provider onto it would have been fewer
 * lines. Three things this pipeline depends on are only reachable natively:
 *
 *   1. `thoughtsTokenCount`. Gemini 3 models think by default and thinking
 *      tokens are billed at the OUTPUT rate. The compatibility shim reports a
 *      single `completion_tokens`, so the cost ledger could not separate what
 *      was spent reasoning from what was spent writing — and this repository's
 *      whole per-stage cost story is built on provider-reported counts.
 *   2. `thinkingLevel`. It is the cost/latency dial on Gemini 3 and has no
 *      OpenAI-shaped equivalent.
 *   3. `finishReason`. `MAX_TOKENS` is the failure mode that silently truncates
 *      a 16k-token script movement mid-JSON. Native returns it per candidate.
 *
 * PROVIDER-SPECIFIC BEHAVIOR WORTH KNOWING
 *
 * - Auth is the `x-goog-api-key` HEADER, not the `?key=` query parameter that
 *   also works. A key in a URL ends up in error strings, retry logs, and stack
 *   traces; a key in a header does not. That is the entire reason for the
 *   choice.
 * - `systemInstruction` is a separate top-level field, not a message with
 *   `role: "system"`. Gemini's only legal roles are "user" and "model".
 * - Structured output is `generationConfig.responseMimeType` +
 *   `responseSchema`, not a `response_format` wrapper.
 * - Thinking tokens are documented as priced with output but NOT documented as
 *   exempt from `maxOutputTokens`. Since a truncated script is expensive and a
 *   raised cap is free (the cap is a ceiling, not a spend), this adapter adds
 *   explicit headroom — the same fix the Anthropic provider needed for exactly
 *   this reason. See `resolveMaxOutputTokens`.
 */

/** Documented max OUTPUT tokens per model. Used to CLAMP, never to lower a
 *  caller's request below what it asked for. An unlisted model falls back to
 *  `DEFAULT_MODEL_MAX_OUTPUT_TOKENS`, which is deliberately generous so a newer
 *  model is not silently throttled by a stale table. */
const MODEL_MAX_OUTPUT_TOKENS: Record<string, number> = {
  "gemini-3.6-flash": 65536,
  "gemini-3.5-flash": 65536,
  "gemini-3.5-flash-lite": 65536,
  "gemini-3.1-pro-preview": 65536,
  "gemini-2.5-pro": 65536,
  "gemini-2.5-flash": 65536,
};
const DEFAULT_MODEL_MAX_OUTPUT_TOKENS = 65536;

export const GEMINI_FALLBACK_MODEL = "gemini-3.6-flash";
const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";

const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_MAX_RETRIES = 2;
/** Thinking tokens are not documented as exempt from maxOutputTokens. */
const DEFAULT_THINKING_HEADROOM_TOKENS = 8192;

/** Retryable transport/server conditions. 408 and 429 are the only 4xx here:
 *  every other 4xx means the REQUEST is wrong and retrying it just burns
 *  quota and delays a real error reaching the operator. */
const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

/** finishReason values that mean the model stopped for a content reason rather
 *  than because it was done. Treated as hard failures, never retried — a
 *  refusal is deterministic and a retry loop against one is pure cost. */
const REFUSAL_FINISH_REASONS = new Set([
  "SAFETY",
  "RECITATION",
  "BLOCKLIST",
  "PROHIBITED_CONTENT",
  "SPII",
  "IMAGE_SAFETY",
]);

interface GeminiPart {
  text?: string;
}
interface GeminiCandidate {
  content?: { parts?: GeminiPart[]; role?: string };
  finishReason?: string;
}
interface GeminiUsageMetadata {
  promptTokenCount?: number;
  cachedContentTokenCount?: number;
  candidatesTokenCount?: number;
  thoughtsTokenCount?: number;
  /** Newer alias seen in the thinking documentation. Read defensively. */
  totalThoughtTokens?: number;
  totalTokenCount?: number;
}
interface GeminiResponse {
  candidates?: GeminiCandidate[];
  promptFeedback?: { blockReason?: string };
  usageMetadata?: GeminiUsageMetadata;
  modelVersion?: string;
}

function positiveIntEnv(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
}

export class GeminiLLMProvider implements LLMProvider {
  name = "gemini";
  private apiKey: string;
  private model: string;
  private timeoutMs: number;
  private maxRetries: number;
  private usage: LLMUsage = { inputTokens: 0, outputTokens: 0, requestCount: 0 };

  constructor(modelOverride?: string) {
    const key = process.env.GEMINI_API_KEY;
    if (!key || !key.trim() || isPlaceholderKey(key)) {
      throw new Error(
        "[Gemini] Missing, blank, or placeholder GEMINI_API_KEY environment variable. " +
          "Set GEMINI_API_KEY to use Gemini. (Set it on BOTH the web and worker services.)"
      );
    }
    this.apiKey = key.trim();
    // Resolution order: explicit constructor override > GEMINI_MODEL > code
    // fallback. Matches the Anthropic and OpenAI providers exactly, so
    // SCRIPT_LLM_MODEL / VERIFY_MODEL reach this the same way they reach them.
    this.model = modelOverride || process.env.GEMINI_MODEL || GEMINI_FALLBACK_MODEL;
    this.timeoutMs = positiveIntEnv("GEMINI_REQUEST_TIMEOUT_MS", DEFAULT_TIMEOUT_MS);
    this.maxRetries = Number.isFinite(Number(process.env.GEMINI_MAX_RETRIES))
      ? Math.max(0, Math.floor(Number(process.env.GEMINI_MAX_RETRIES)))
      : DEFAULT_MAX_RETRIES;
  }

  getAccumulatedUsage(): LLMUsage {
    return { ...this.usage };
  }

  private modelMaxOutputTokens(): number {
    return MODEL_MAX_OUTPUT_TOKENS[this.model.toLowerCase()] ?? DEFAULT_MODEL_MAX_OUTPUT_TOKENS;
  }

  /**
   * The caller's requested budget, plus thinking headroom, clamped to the
   * model's documented ceiling.
   *
   * The rule this enforces: NEVER return less than the caller asked for unless
   * the model physically cannot produce it, and say so out loud when that
   * happens. The pipeline requests 7,000 tokens for an outline and 16,000 for
   * each script movement; an adapter that quietly capped those at 8,192 would
   * truncate every episode mid-JSON and look like a model quality problem.
   *
   * Headroom only raises the CEILING. Billing is whatever the model actually
   * emits, so this costs nothing when the model is concise.
   */
  private resolveMaxOutputTokens(requested: number | undefined): { value: number; warning?: string } {
    const ceiling = this.modelMaxOutputTokens();
    const want = requested && requested > 0 ? requested : 8192;
    const headroom = positiveIntEnv("GEMINI_THINKING_HEADROOM_TOKENS", DEFAULT_THINKING_HEADROOM_TOKENS);

    if (want > ceiling) {
      return {
        value: ceiling,
        warning:
          `[Gemini] Requested maxTokens=${want} exceeds the documented output ceiling for ${this.model} ` +
          `(${ceiling}); clamped to ${ceiling}. Output may be truncated — split the request or use a model with a larger output limit.`,
      };
    }
    // Room for thinking on top of the caller's budget, without exceeding the model.
    return { value: Math.min(want + headroom, ceiling) };
  }

  /**
   * `systemPrompt` and `cacheableContext` are joined into ONE
   * `systemInstruction`, in a fixed order, with the cacheable half LAST.
   *
   * This is not native context caching, and it deliberately is not: Gemini's
   * `cachedContents` API is an explicit create/TTL/delete resource, and wiring
   * a persistent cache lifecycle into a request-scoped adapter would add a
   * whole failure mode (stale handles, orphaned paid caches) for a saving this
   * pipeline has not measured. What this DOES guarantee is a byte-stable
   * prefix across the many calls in one episode, which is what Gemini's
   * implicit context caching keys on. The content is never discarded.
   */
  private buildSystemInstruction(options: GenerateTextOptions): { parts: GeminiPart[] } | undefined {
    const blocks = [options.systemPrompt, options.cacheableContext].filter(
      (b): b is string => typeof b === "string" && b.length > 0
    );
    if (blocks.length === 0) return undefined;
    return { parts: [{ text: blocks.join("\n\n") }] };
  }

  private buildBody(
    options: GenerateStructuredOutputOptions,
    opts: { json: boolean }
  ): { body: Record<string, unknown>; warning?: string } {
    const { value: maxOutputTokens, warning } = this.resolveMaxOutputTokens(options.maxTokens);

    const generationConfig: Record<string, unknown> = { maxOutputTokens };
    if (options.temperature !== undefined) generationConfig.temperature = options.temperature;

    if (opts.json) {
      generationConfig.responseMimeType = "application/json";
      // Only sent when the caller actually supplied one. Gemini rejects very
      // large or deeply nested schemas, and the pipeline's biggest payloads
      // (script movements) do NOT supply a schema — they rely on JSON mime type
      // plus instruction. Sending a synthesized schema for those would risk a
      // 400 on the most valuable call in the run.
      if (options.jsonSchema) generationConfig.responseSchema = options.jsonSchema;
    }

    // Thinking level: unset means Google's per-model default. Exposed so an
    // operator can trade reasoning for cost/latency without a code change.
    const thinkingLevel = (process.env.GEMINI_THINKING_LEVEL || "").trim().toLowerCase();
    if (thinkingLevel) generationConfig.thinkingLevel = thinkingLevel;

    const body: Record<string, unknown> = {
      // Gemini's only legal roles are "user" and "model" — the system prompt is
      // a separate top-level field, not a message.
      contents: [{ role: "user", parts: [{ text: options.prompt }] }],
      generationConfig,
    };
    const systemInstruction = this.buildSystemInstruction(options);
    if (systemInstruction) body.systemInstruction = systemInstruction;

    return { body, warning };
  }

  private async request(body: Record<string, unknown>): Promise<GeminiResponse> {
    const url = `${GEMINI_API_BASE}/models/${encodeURIComponent(this.model)}:generateContent`;
    let lastErr: Error | null = null;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const startedAt = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            // HEADER, not ?key= — see the class comment. A key in the URL leaks
            // into error strings and logs.
            "x-goog-api-key": this.apiKey,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        if (response.ok) {
          const data = (await response.json()) as GeminiResponse;
          this.recordUsage(data, Date.now() - startedAt);
          return data;
        }

        const errorText = redactKey(await response.text(), this.apiKey);
        lastErr = new Error(
          `[Gemini] API request failed with status ${response.status} (model: ${this.model}): ${errorText}`
        );
        if (!RETRYABLE_STATUSES.has(response.status) || attempt === this.maxRetries) throw lastErr;
        await sleep(this.backoffMs(attempt, response.headers.get("retry-after")), `${response.status}`, attempt, this.maxRetries);
      } catch (err: unknown) {
        if (err === lastErr) throw err; // non-retryable API error, already shaped
        const isAbort: boolean = err instanceof Error && err.name === "AbortError";
        const wrapped: Error = isAbort
          ? new Error(`[Gemini] Request timed out after ${this.timeoutMs}ms (model: ${this.model}).`)
          : new Error(`[Gemini] Network failure (model: ${this.model}): ${redactKey(String(err), this.apiKey)}`);
        lastErr = wrapped;
        // A timeout is safe to retry here: generateContent is a pure function
        // of its request body, so a repeat cannot double-apply anything.
        if (attempt === this.maxRetries) throw wrapped;
        await sleep(this.backoffMs(attempt, null), isAbort ? "timeout" : "network", attempt, this.maxRetries);
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastErr || new Error(`[Gemini] Request failed (model: ${this.model}).`);
  }

  /** Exponential backoff with jitter, honoring Retry-After when supplied. */
  private backoffMs(attempt: number, retryAfterHeader: string | null): number {
    const retryAfter = Number(retryAfterHeader);
    if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.min(retryAfter * 1000, 60_000);
    const base = Math.min(2000 * Math.pow(3, attempt), 30_000);
    // Jitter matters when the worker fires several stages concurrently: without
    // it, every retry from one 429 burst lands in the same millisecond.
    return base + Math.floor(Math.random() * 1000);
  }

  private recordUsage(data: GeminiResponse, durationMs: number): void {
    const u = data.usageMetadata;
    if (!u) return;
    const cached = u.cachedContentTokenCount || 0;
    // Thinking tokens are billed at the OUTPUT rate, so they belong in tkOut.
    // Folding them into input, or dropping them, would under-report the true
    // cost of a Gemini 3 call by the majority of its output spend.
    const thoughts = u.thoughtsTokenCount ?? u.totalThoughtTokens ?? 0;
    const promptTokens = u.promptTokenCount || 0;
    const outputTokens = (u.candidatesTokenCount || 0) + thoughts;

    this.usage.inputTokens += promptTokens;
    this.usage.outputTokens += outputTokens;
    this.usage.requestCount += 1;

    recordLlmCall({
      provider: this.name,
      model: this.model,
      // promptTokenCount INCLUDES cached tokens, so subtract them to get the
      // portion billed at the full input rate — matching how the OpenAI
      // provider splits prompt_tokens_details.cached_tokens.
      tkIn: Math.max(0, promptTokens - cached),
      tkOut: outputTokens,
      tkCacheRead: cached,
      durationMs,
    });
  }

  /**
   * Pull the text out of the first candidate, converting every "no usable
   * output" shape into a specific error rather than an empty string. An empty
   * string reaching a JSON parser produces a misleading parse error two layers
   * away from the real cause.
   */
  private extractText(data: GeminiResponse): string {
    const blocked = data.promptFeedback?.blockReason;
    if (blocked) {
      throw new Error(`[Gemini] Prompt was blocked before generation (blockReason: ${blocked}, model: ${this.model}).`);
    }

    const candidate = data.candidates?.[0];
    if (!candidate) {
      throw new Error(`[Gemini] Response contained no candidates (model: ${this.model}).`);
    }

    const finish = candidate.finishReason;
    if (finish && REFUSAL_FINISH_REASONS.has(finish)) {
      throw new Error(`[Gemini] Generation stopped for a content reason (finishReason: ${finish}, model: ${this.model}).`);
    }

    const text = (candidate.content?.parts ?? [])
      .map((p) => (typeof p.text === "string" ? p.text : ""))
      .join("")
      .trim();

    if (!text) {
      // MAX_TOKENS with no text at all means the entire budget went to
      // thinking. Naming that is the difference between a 30-second fix
      // (raise headroom) and an afternoon of blaming the prompt.
      if (finish === "MAX_TOKENS") {
        throw new Error(
          `[Gemini] Output limit reached before any text was produced (model: ${this.model}). ` +
            `The whole budget went to reasoning — raise GEMINI_THINKING_HEADROOM_TOKENS or lower GEMINI_THINKING_LEVEL.`
        );
      }
      throw new Error(`[Gemini] Empty response text (finishReason: ${finish ?? "none"}, model: ${this.model}).`);
    }
    return text;
  }

  async generateText(options: GenerateTextOptions): Promise<string> {
    console.log(`[Gemini] Requesting text via model: ${this.model}`);
    const { body, warning } = this.buildBody(options, { json: false });
    if (warning) console.warn(warning);
    const data = await this.request(body);
    return this.extractText(data);
  }

  // The `any` default is dictated by the shared LLMProvider interface, which
  // this task must not change and which Anthropic/OpenAI/Stub also implement.
  // Narrowing it here would only diverge from its siblings — a call made
  // through the interface type still uses the interface's default.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async generateStructuredOutput<T = any>(options: GenerateStructuredOutputOptions): Promise<T> {
    console.log(
      `[Gemini] Requesting structured output (JSON mime${options.jsonSchema ? " + schema" : ""}) via model: ${this.model}`
    );

    // Belt and braces: responseMimeType is the mechanism, the instruction is
    // insurance. Callers that supply no schema rely on the instruction to keep
    // the model from wrapping the object in prose.
    const systemPrompt = `${options.systemPrompt || ""}\n\nCRITICAL: Respond with a single valid JSON object and nothing else. Start your response with '{' immediately — no markdown code fences, no preamble, no commentary after the closing '}'.`;

    const { body, warning } = this.buildBody({ ...options, systemPrompt }, { json: true });
    if (warning) console.warn(warning);
    const data = await this.request(body);
    const raw = this.extractText(data);
    const finish = data.candidates?.[0]?.finishReason;
    return parseJsonStrict<T>(raw, finish, this.model);
  }
}

// ---------------------------------------------------------------------------
// Pure helpers — exported for direct unit testing without a fetch mock.
// ---------------------------------------------------------------------------

/** Obvious non-keys, so a misconfigured environment fails at construction with
 *  a clear message instead of on the first 400 mid-episode. */
export function isPlaceholderKey(key: string): boolean {
  const k = key.trim().toUpperCase();
  return (
    k === "YOUR-GEMINI-API-KEY" ||
    k === "YOUR_GEMINI_API_KEY" ||
    k === "SET_IN_COOLIFY_ONLY" ||
    k === "CHANGE_ME" ||
    k === "PASTE_KEY_HERE" ||
    k === "YOUR_KEY_HERE"
  );
}

/** Defence in depth. The key is sent in a header and never interpolated into a
 *  URL, so it should be impossible for it to appear in a response body — but an
 *  error text is echoed straight into a thrown message, and "should be
 *  impossible" is not a security control. */
export function redactKey(text: string, key: string): string {
  if (!key) return text;
  return text.split(key).join("[REDACTED]");
}

async function sleep(ms: number, reason: string, attempt: number, maxRetries: number): Promise<void> {
  console.warn(`[Gemini] ${reason} — retrying in ${Math.round(ms / 1000)}s (attempt ${attempt + 1}/${maxRetries}).`);
  await new Promise((r) => setTimeout(r, ms));
}

/**
 * Parse a model response as a single JSON object.
 *
 * Ordered from strictest to loosest, and it NEVER returns `{}` or partial data
 * on failure — a silently-empty object propagates as "the model produced an
 * outline with no beats", which is far harder to diagnose than a parse error.
 * The stop reason is included because `MAX_TOKENS` and "the model wrote prose"
 * are different problems with different fixes.
 */
export function parseJsonStrict<T>(raw: string, finishReason: string | undefined, model: string): T {
  let content = raw.trim();

  // 1. Markdown fences, which models emit despite instructions.
  if (content.startsWith("```")) {
    const lines = content.split("\n");
    if (lines[0].startsWith("```")) lines.shift();
    if (lines.length && lines[lines.length - 1].trim().startsWith("```")) lines.pop();
    content = lines.join("\n").trim();
  }

  // 2. The happy path.
  try {
    return JSON.parse(content) as T;
  } catch {
    // fall through
  }

  // 3. Last resort: the outermost braces, which recovers leading/trailing prose.
  const first = content.indexOf("{");
  const last = content.lastIndexOf("}");
  if (first !== -1 && last > first) {
    try {
      return JSON.parse(content.slice(first, last + 1)) as T;
    } catch {
      // fall through to the shared failure below
    }
  }

  // 4. Diagnose. Unbalanced braces plus MAX_TOKENS is truncation, which is a
  //    budget problem, not a prompt problem — say which one it is.
  const opens = (content.match(/\{/g) || []).length;
  const closes = (content.match(/\}/g) || []).length;
  const truncated = finishReason === "MAX_TOKENS" || opens > closes;
  const detail = truncated
    ? `the response was TRUNCATED (finishReason: ${finishReason ?? "unknown"}, ${opens} '{' vs ${closes} '}'). ` +
      `Raise maxTokens or GEMINI_THINKING_HEADROOM_TOKENS.`
    : `no valid JSON object found (finishReason: ${finishReason ?? "unknown"}).`;
  console.error(`[Gemini] Unparseable response (first 500 chars): ${content.slice(0, 500)}`);
  throw new Error(`[Gemini] Failed to parse output as valid JSON from ${model}: ${detail}`);
}

export default GeminiLLMProvider;
