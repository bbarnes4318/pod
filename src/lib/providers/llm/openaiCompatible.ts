// Shared base for OpenAI-PROTOCOL-compatible providers (NVIDIA NIM, Z.ai).
//
// "OpenAI-compatible" describes the wire protocol, not the vendor. A call made
// here is recorded under its OWN provider name — never as an "openai" call —
// because the ledger, the readiness map and every cost question depend on
// knowing which service actually ran the request.
//
// Subclasses supply only what genuinely differs: base URL, credential variable,
// provider name, default model, request-parameter shaping, reasoning spelling,
// and retry/timeout defaults. Everything below is protocol behavior:
//
//   - capability-filtered request bodies (no invented fields, nothing that the
//     model's registry record says it rejects)
//   - the caller's output allowance preserved (a 16,000-token movement request
//     leaves here as 16,000)
//   - reasoning content SEPARATED from the answer and never returned to callers
//   - structured output parsed strictly, with ONE repair attempt
//   - retries only for genuinely transient failures, with exponential backoff,
//     jitter, Retry-After and a hard AbortController timeout
//   - credentials redacted from every message this class produces

import {
  GenerateStructuredOutputOptions,
  GenerateTextOptions,
  LLMProvider,
  LLMUsage,
} from "./interface";
import { estimateCostUsd, recordLlmCall } from "./costLedger";
import { ModelCapabilities, modelCapabilities, resolveMaxTokens } from "./capabilities";
import {
  LlmProviderError,
  categorizeHttpFailure,
  categorizeNetworkFailure,
  describeFailure,
  redactSecrets,
} from "./errors";
import {
  StructuredOutputError,
  buildRepairPrompt,
  parseStructuredResponse,
} from "./structured";
import { readRoutingEnv } from "./routingEnv";

/** How this provider spells "think" / "don't think" on the request. */
export type ReasoningSpelling = "none" | "chat_template_kwargs" | "thinking_object";

export interface OpenAICompatibleConfig {
  provider: string;
  model: string;
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
  maxRetries: number;
  reasoningSpelling: ReasoningSpelling;
  extraHeaders?: Record<string, string>;
  /** Free/trial endpoint — cost is reported as null, never estimated. */
  unpriced: boolean;
}

const JSON_INSTRUCTION =
  "CRITICAL: Respond with a single valid JSON object and nothing else. Start your response with '{' immediately — no markdown code fences, no preamble, no commentary after the closing '}'.";

export abstract class OpenAICompatibleLLMProvider implements LLMProvider {
  readonly name: string;
  protected readonly model: string;
  protected readonly config: OpenAICompatibleConfig;
  protected readonly caps: ModelCapabilities;
  private usage: LLMUsage = { inputTokens: 0, outputTokens: 0, requestCount: 0, reasoningTokens: 0, cachedInputTokens: 0 };
  /** Set when a 400 proved a registry field wrong; the narrowed shape is reused. */
  private downgradedParams = new Set<string>();

  protected constructor(config: OpenAICompatibleConfig) {
    this.config = config;
    this.name = config.provider;
    this.model = config.model;
    this.caps = modelCapabilities(config.provider, config.model);
  }

  getAccumulatedUsage(): LLMUsage {
    return { ...this.usage };
  }

  /** `provider/model`, for logs and errors. */
  protected label(): string {
    return `${this.name}/${this.model}`;
  }

  /** Chat-completions URL beneath the configured base URL. */
  protected endpoint(): string {
    const base = this.config.baseUrl.replace(/\/+$/, "");
    return `${base}/chat/completions`;
  }

  protected headers(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Bearer ${this.config.apiKey}`,
      ...(this.config.extraHeaders || {}),
    };
  }

  // ---------------------------------------------------------------- request

  private buildMessages(options: GenerateTextOptions, systemSuffix?: string): any[] {
    const messages: any[] = [];
    const systemParts = [options.systemPrompt, options.cacheableContext, systemSuffix].filter(Boolean);
    if (systemParts.length > 0) {
      if (this.caps.supportsSystemPrompt) {
        messages.push({ role: "system", content: systemParts.join("\n\n") });
      } else {
        // No system role: prepend it to the user turn rather than dropping it.
        messages.push({ role: "user", content: `${systemParts.join("\n\n")}\n\n---\n\n${options.prompt}` });
        return messages;
      }
    }
    messages.push({ role: "user", content: options.prompt });
    return messages;
  }

  /**
   * Translate the caller's reasoning posture into this provider's spelling.
   *
   * Only sent when the model's capability record says it has a reasoning mode.
   * The exact field names for the currently-unverified hosted models are
   * DECLARED, not confirmed — if the provider answers 400 "unsupported
   * parameter", the field is dropped for the rest of this instance's life and
   * the request is retried once (recorded as a parameter downgrade, not as a
   * transient retry).
   */
  protected applyReasoning(body: Record<string, any>, wantsReasoning: boolean): void {
    if (!this.caps.supportsThinking) return;
    if (this.downgradedParams.has("reasoning")) return;
    switch (this.config.reasoningSpelling) {
      case "chat_template_kwargs":
        body.chat_template_kwargs = { ...(body.chat_template_kwargs || {}), thinking: wantsReasoning };
        return;
      case "thinking_object":
        body.thinking = { type: wantsReasoning ? "enabled" : "disabled" };
        return;
      case "none":
        return;
    }
  }

  /** Provider/model-specific request shaping. Subclasses may extend. */
  protected shapeBody(body: Record<string, any>): Record<string, any> {
    return body;
  }

  private buildBody(
    options: GenerateStructuredOutputOptions,
    kind: "text" | "structured"
  ): Record<string, any> {
    const body: Record<string, any> = {
      model: this.model,
      messages: this.buildMessages(options, kind === "structured" ? JSON_INSTRUCTION : undefined),
      stream: false,
    };

    // Output allowance: preserved exactly unless a CONFIRMED cap is exceeded,
    // which throws rather than silently shrinking the request.
    const maxTokens = resolveMaxTokens(this.caps, options.maxTokens);
    if (maxTokens !== undefined) body.max_tokens = maxTokens;

    // Sampling: only for models that accept it.
    if (!this.caps.rejectsSampling && options.temperature !== undefined) {
      body.temperature = options.temperature;
    }

    if (kind === "structured" && !this.downgradedParams.has("response_format")) {
      if (this.caps.supportsStructuredOutput && options.jsonSchema) {
        body.response_format = {
          type: "json_schema",
          json_schema: { name: "application_schema", schema: options.jsonSchema, strict: false },
        };
      } else if (this.caps.supportsJsonObjectMode) {
        body.response_format = { type: "json_object" };
      }
    }

    const wantsReasoning = (options.reasoning ?? "off") === "on";
    this.applyReasoning(body, wantsReasoning);

    return this.shapeBody(body);
  }

  // ---------------------------------------------------------------- response

  /**
   * Split the answer from the reasoning. Reasoning is returned separately and
   * DISCARDED by both public entry points — it must never reach dialogue, show
   * notes, structured output or TTS.
   */
  protected extractContent(data: any): { text: string; reasoning: string | null } {
    const choice = data?.choices?.[0];
    const message = choice?.message ?? {};
    const finish = choice?.finish_reason;

    const reasoning =
      typeof message.reasoning_content === "string" && message.reasoning_content.length > 0
        ? message.reasoning_content
        : typeof message.reasoning === "string" && message.reasoning.length > 0
        ? message.reasoning
        : null;

    let text = typeof message.content === "string" ? message.content : "";
    // Some OpenAI-compatible servers return content as an array of parts.
    if (!text && Array.isArray(message.content)) {
      text = message.content
        .filter((p: any) => p?.type === "text" || typeof p?.text === "string")
        .map((p: any) => p.text || "")
        .join("");
    }

    if (message.refusal) {
      throw new LlmProviderError({
        provider: this.name,
        model: this.model,
        category: "safety_refusal",
        message: `[${this.label()}] Request was refused by the model: ${String(message.refusal).slice(0, 300)}`,
      });
    }

    if (!text.trim()) {
      // A reasoning-only response with an empty answer is a real failure mode on
      // reasoning models that ran out of budget before writing the answer.
      const hint =
        reasoning && finish === "length"
          ? " The model spent its entire output allowance on reasoning and never produced an answer — raise maxTokens or route this role to a non-reasoning model."
          : "";
      throw new LlmProviderError({
        provider: this.name,
        model: this.model,
        category: finish === "length" ? "output_limit" : "transient",
        message: `[${this.label()}] Empty response content (finish_reason: ${finish ?? "unknown"}).${hint}`,
      });
    }

    return { text, reasoning };
  }

  private recordUsage(
    data: any,
    durationMs: number,
    meta: { attempts: number; retries: number; repairs: number; reasoningRequested: boolean }
  ): void {
    const u = data?.usage;
    if (!u) return;
    const cached = u.prompt_tokens_details?.cached_tokens || 0;
    const reasoningTokens =
      u.completion_tokens_details?.reasoning_tokens ||
      u.reasoning_tokens ||
      0;
    const tkIn = Math.max(0, (u.prompt_tokens || 0) - cached);
    const tkOut = u.completion_tokens || 0;

    this.usage.inputTokens += u.prompt_tokens || 0;
    this.usage.outputTokens += tkOut;
    this.usage.requestCount += 1;
    this.usage.reasoningTokens = (this.usage.reasoningTokens || 0) + reasoningTokens;
    this.usage.cachedInputTokens = (this.usage.cachedInputTokens || 0) + cached;

    recordLlmCall({
      provider: this.name,
      model: this.model,
      tkIn,
      tkOut,
      tkCacheRead: cached,
      tkReasoning: reasoningTokens,
      durationMs,
      attempts: meta.attempts,
      retries: meta.retries,
      repairs: meta.repairs,
      ok: true,
      reasoningRequested: meta.reasoningRequested,
      estimatedCostUsd: estimateCostUsd(this.name, tkIn, tkOut, this.config.unpriced),
    });
  }

  private recordFailure(
    durationMs: number,
    err: unknown,
    meta: { attempts: number; retries: number; repairs: number; reasoningRequested: boolean }
  ): void {
    recordLlmCall({
      provider: this.name,
      model: this.model,
      tkIn: 0,
      tkOut: 0,
      durationMs,
      attempts: meta.attempts,
      retries: meta.retries,
      repairs: meta.repairs,
      ok: false,
      failure: err instanceof LlmProviderError ? err.category : "unknown",
      reasoningRequested: meta.reasoningRequested,
      // No tokens were billed for a failed call we can account for; a real
      // charge on a failed request is not something the provider reports.
      estimatedCostUsd: null,
    });
    console.warn(`[${this.name}] call failed — ${describeFailure(err)}`);
  }

  // ---------------------------------------------------------------- transport

  private backoffMs(attempt: number, retryAfterHeader: string | null): number {
    const retryAfter = Number(retryAfterHeader);
    if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.min(retryAfter * 1000, 60_000);
    const base = Math.min(1000 * Math.pow(3, attempt), 30_000);
    // Jitter: several worker jobs failing on the same upstream blip must not
    // all come back at the same instant.
    return Math.round(base * (0.7 + Math.random() * 0.6));
  }

  /**
   * One HTTP round trip with retries. Returns the parsed JSON body.
   *
   * `state` accumulates attempt/retry counts for the ledger, and carries the
   * parameter-downgrade signal back to the caller so the body can be rebuilt.
   */
  private async request(
    body: Record<string, any>,
    state: { attempts: number; retries: number; downgraded: string | null }
  ): Promise<any> {
    let lastErr: unknown = null;

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      state.attempts++;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
      try {
        const response = await fetch(this.endpoint(), {
          method: "POST",
          headers: this.headers(),
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        if (response.ok) {
          return await response.json();
        }

        const errorText = redactSecrets(await response.text().catch(() => ""));
        const category = categorizeHttpFailure(response.status, errorText);

        // An unsupported-parameter 400 is a REGISTRY defect, not a flaky
        // upstream. Narrow the request once and let the caller re-send; the
        // original category stays in the log so the cause is visible.
        if (category === "unsupported_parameter") {
          const field = this.unsupportedField(errorText, body);
          if (field && !this.downgradedParams.has(field)) {
            this.downgradedParams.add(field);
            state.downgraded = field;
            console.warn(
              `[${this.name}] ${this.model} rejected '${field}' (HTTP 400). Dropping it for this process and re-sending. ` +
                `Update the capability registry in src/lib/providers/llm/capabilities.ts. Provider said: ${errorText.slice(0, 200)}`
            );
            return null; // caller rebuilds the body and calls request() again
          }
        }

        const err = new LlmProviderError({
          provider: this.name,
          model: this.model,
          category,
          status: response.status,
          message: `[${this.label()}] HTTP ${response.status}: ${errorText.slice(0, 600) || "(empty body)"}`,
        });
        if (!err.retryable || attempt === this.config.maxRetries) throw err;
        lastErr = err;
        const delay = this.backoffMs(attempt, response.headers.get("retry-after"));
        console.warn(
          `[${this.name}] ${response.status} on ${this.model} — retrying in ${Math.round(delay / 1000)}s ` +
            `(attempt ${attempt + 1}/${this.config.maxRetries}).`
        );
        state.retries++;
        await sleep(delay);
      } catch (err: any) {
        if (err instanceof LlmProviderError) throw err;
        const category = categorizeNetworkFailure(err);
        const wrapped = new LlmProviderError({
          provider: this.name,
          model: this.model,
          category,
          message:
            category === "transient" && err?.name === "AbortError"
              ? `[${this.label()}] Request timed out after ${this.config.timeoutMs}ms.`
              : `[${this.label()}] ${describeFailure(err)}`,
          cause: err,
        });
        if (!wrapped.retryable || attempt === this.config.maxRetries) throw wrapped;
        lastErr = wrapped;
        state.retries++;
        await sleep(this.backoffMs(attempt, null));
      } finally {
        clearTimeout(timer);
      }
    }

    throw lastErr instanceof LlmProviderError
      ? lastErr
      : new LlmProviderError({
          provider: this.name,
          model: this.model,
          category: "unknown",
          message: `[${this.label()}] Request failed after ${this.config.maxRetries + 1} attempt(s).`,
        });
  }

  /** Which request field a 400 body is complaining about, if it names one. */
  private unsupportedField(errorText: string, body: Record<string, any>): string | null {
    const t = errorText.toLowerCase();
    for (const field of ["response_format", "chat_template_kwargs", "thinking", "reasoning", "seed", "max_tokens"]) {
      if (field in body && t.includes(field)) {
        return field === "chat_template_kwargs" || field === "thinking" ? "reasoning" : field;
      }
    }
    // A generic unsupported-parameter complaint while reasoning is in play is
    // most often the reasoning field, which is the one we declared unverified.
    if (body.chat_template_kwargs || body.thinking) return "reasoning";
    if (body.response_format) return "response_format";
    return null;
  }

  /** request() but transparently re-sends once after a parameter downgrade. */
  private async requestWithDowngrade(
    build: () => Record<string, any>,
    state: { attempts: number; retries: number; downgraded: string | null }
  ): Promise<any> {
    let data = await this.request(build(), state);
    if (data === null) {
      // A field was dropped from the registry-derived body; rebuild and re-send.
      data = await this.request(build(), state);
      if (data === null) {
        throw new LlmProviderError({
          provider: this.name,
          model: this.model,
          category: "unsupported_parameter",
          message: `[${this.label()}] Provider rejected request parameters twice; giving up rather than guessing further.`,
        });
      }
    }
    return data;
  }

  // ---------------------------------------------------------------- public API

  async generateText(options: GenerateTextOptions): Promise<string> {
    const reasoningRequested = (options.reasoning ?? "off") === "on";
    const state = { attempts: 0, retries: 0, downgraded: null as string | null };
    const startedAt = Date.now();
    console.log(`[${this.name}] Requesting completion via model: ${this.model}`);
    try {
      const data = await this.requestWithDowngrade(() => this.buildBody(options, "text"), state);
      const { text, reasoning } = this.extractContent(data);
      this.recordUsage(data, Date.now() - startedAt, {
        attempts: state.attempts,
        retries: state.retries,
        repairs: 0,
        reasoningRequested,
      });
      this.logReasoningPresence(reasoning);
      // Only the ANSWER is returned. Reasoning is dropped here, at the edge.
      return text;
    } catch (err) {
      this.recordFailure(Date.now() - startedAt, err, {
        attempts: state.attempts,
        retries: state.retries,
        repairs: 0,
        reasoningRequested,
      });
      throw err;
    }
  }

  async generateStructuredOutput<T = any>(options: GenerateStructuredOutputOptions): Promise<T> {
    const reasoningRequested = (options.reasoning ?? "off") === "on";
    const repairEnabled = (readRoutingEnv("LLM_STRUCTURED_REPAIR_ENABLED") || "true").toLowerCase() !== "false";
    const state = { attempts: 0, retries: 0, downgraded: null as string | null };
    const startedAt = Date.now();
    let repairs = 0;
    console.log(`[${this.name}] Requesting structured output (JSON forced) via model: ${this.model}`);

    const attemptOnce = async (opts: GenerateStructuredOutputOptions): Promise<T> => {
      const data = await this.requestWithDowngrade(() => this.buildBody(opts, "structured"), state);
      const { text, reasoning } = this.extractContent(data);
      this.logReasoningPresence(reasoning);
      // Reasoning is NOT passed to the parser — parsing it would be the exact
      // path by which private reasoning leaks into structured application data.
      const parsed = parseStructuredResponse<T>(text, {
        jsonSchema: opts.jsonSchema,
        validate: opts.validate,
        label: this.label(),
      });
      this.recordUsage(data, Date.now() - startedAt, {
        attempts: state.attempts,
        retries: state.retries,
        repairs,
        reasoningRequested,
      });
      return parsed;
    };

    try {
      return await attemptOnce(options);
    } catch (firstErr) {
      const repairable = firstErr instanceof StructuredOutputError && repairEnabled;
      if (!repairable) {
        this.recordFailure(Date.now() - startedAt, firstErr, {
          attempts: state.attempts,
          retries: state.retries,
          repairs,
          reasoningRequested,
        });
        throw firstErr;
      }

      repairs = 1;
      console.warn(
        `[${this.name}] structured output rejected (${firstErr.kind}) — ONE repair request. ` +
          `Excerpt: ${firstErr.excerpt.slice(0, 200)}`
      );
      try {
        return await attemptOnce({
          ...options,
          prompt: buildRepairPrompt(options.prompt, firstErr),
        });
      } catch (repairErr) {
        this.recordFailure(Date.now() - startedAt, repairErr, {
          attempts: state.attempts,
          retries: state.retries,
          repairs,
          reasoningRequested,
        });
        // Surface BOTH: the routing layer decides to fall back knowing the
        // repair was attempted and what the original defect was.
        const detail = repairErr instanceof StructuredOutputError ? repairErr.kind : describeFailure(repairErr);
        throw new LlmProviderError({
          provider: this.name,
          model: this.model,
          category: "structured_output",
          message:
            `[${this.label()}] Structured output failed (${firstErr.kind}) and the single repair attempt also failed ` +
            `(${detail}). No partial result was returned.`,
          cause: repairErr,
        });
      }
    }
  }

  /**
   * Record only THAT reasoning happened. The text itself is never logged unless
   * an operator deliberately turns it on for a debugging session.
   */
  private logReasoningPresence(reasoning: string | null): void {
    if (!reasoning) return;
    const logIt = (readRoutingEnv("LLM_LOG_REASONING") || "").toLowerCase() === "true";
    if (logIt) {
      console.debug(`[${this.name}] reasoning (${reasoning.length} chars): ${reasoning.slice(0, 2000)}`);
    } else {
      console.log(`[${this.name}] model returned separate reasoning content (${reasoning.length} chars, not logged).`);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Read a required credential, with a readiness-grade message when it is absent. */
export function requireApiKey(
  provider: string,
  envVar: string,
  humanName: string,
  setupHint: string
): string {
  const raw = readRoutingEnv(envVar);
  const value = (raw || "").trim();
  const placeholder =
    !value ||
    /^(your|set|paste|change)[-_ ]/i.test(value) ||
    value.toUpperCase() === "SET_IN_SECRET_MANAGER" ||
    value.toUpperCase() === "SET_IN_COOLIFY_ONLY";
  if (placeholder) {
    throw new LlmProviderError({
      provider,
      model: "(unresolved)",
      category: "missing_credentials",
      message:
        `[${provider}] ${envVar} is ${value ? "still a placeholder" : "not set"}. ` +
        `${humanName} cannot be used until it is configured. ${setupHint}`,
    });
  }
  return value;
}

export function numberFromEnv(envVar: string, fallback: number): number {
  const n = Number(readRoutingEnv(envVar));
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
