// Shared base for OpenAI-PROTOCOL-compatible providers (NVIDIA NIM, Z.ai).
//
// "OpenAI-compatible" describes the wire protocol, not the vendor. A call made
// here is recorded under its OWN provider name — never as an "openai" call —
// because the ledger, the readiness map and every cost question depend on
// knowing which service actually ran the request.
//
// What lives here is protocol behavior only:
//
//   - capability-filtered request bodies; MODEL-specific fields come from the
//     subclass's shaping strategy (see nvidiaRequestProfiles.ts), never from a
//     provider-wide guess
//   - structured output requested in the mode the model actually supports:
//     native JSON schema > native JSON object > prompt-enforced + strict parse
//   - the caller's output allowance preserved (a 16,000-token movement request
//     leaves here as 16,000)
//   - reasoning content SEPARATED from the answer and never returned to callers,
//     and only reported as having happened when the response really carried it
//   - one structured-output repair attempt, then the routing layer decides
//   - retries only for genuinely transient categories, with exponential backoff,
//     jitter, Retry-After and a hard AbortController timeout
//   - credentials redacted from every message this class produces

import {
  GenerateStructuredOutputOptions,
  GenerateTextOptions,
  LLMProvider,
  LLMUsage,
} from "./interface";
import { currentLlmAttribution, estimateCostUsd, recordLlmCall } from "./costLedger";
import {
  ModelCapabilities,
  modelCapabilities,
  resolveMaxTokens,
  structuredOutputMode,
} from "./capabilities";
import {
  LlmProviderError,
  categorizeHttpFailure,
  categorizeNetworkFailure,
  describeFailure,
  namedUnsupportedField,
  redactSecrets,
  type LlmErrorCategory,
} from "./errors";
import { StructuredOutputError, buildRepairPrompt, parseStructuredResponse } from "./structured";
import { clearRateWindow, noteRateWindow, rateWindowRemainingMs } from "./rateWindow";

/**
 * The longest rate window this transport will absorb before handing the failure
 * back to the router. See the use site for the arithmetic that set it.
 */
const TRANSPORT_RATE_WAIT_CEILING_MS = 5_000;
import { ShapeContext, ShapeResult } from "./nvidiaRequestProfiles";
import { readRoutingEnv } from "./routingEnv";
import { LLMRole } from "./roles";

export interface OpenAICompatibleConfig {
  provider: string;
  model: string;
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
  maxRetries: number;
  extraHeaders?: Record<string, string>;
  /** Free/trial endpoint — cost is reported as null, never estimated. */
  unpriced: boolean;
}

const JSON_INSTRUCTION =
  "CRITICAL: Respond with a single valid JSON object and nothing else. Start your response with '{' immediately — no markdown code fences, no preamble, no commentary after the closing '}'.";

/** Fields the one-time downgrade is allowed to remove, if a provider names one. */
const DOWNGRADEABLE_FIELDS = [
  "response_format",
  "chat_template_kwargs",
  "reasoning_budget",
  "reasoning_effort",
  "thinking",
  "seed",
];

export abstract class OpenAICompatibleLLMProvider implements LLMProvider {
  readonly name: string;
  protected readonly model: string;
  protected readonly config: OpenAICompatibleConfig;
  protected readonly caps: ModelCapabilities;
  private usage: LLMUsage = {
    inputTokens: 0,
    outputTokens: 0,
    requestCount: 0,
    reasoningTokens: 0,
    cachedInputTokens: 0,
  };
  /** Fields a provider specifically rejected; dropped for this instance's life. */
  private downgradedFields = new Set<string>();

  protected constructor(config: OpenAICompatibleConfig) {
    this.config = config;
    this.name = config.provider;
    this.model = config.model;
    this.caps = modelCapabilities(config.provider, config.model);
  }

  /**
   * Model-specific request fields. Implemented per provider (and, for NVIDIA,
   * per MODEL via a typed profile) so no vendor's reasoning spelling is ever
   * sent to a model that has not documented it.
   */
  protected abstract shapeModelFields(ctx: ShapeContext): ShapeResult;

  getAccumulatedUsage(): LLMUsage {
    return { ...this.usage };
  }

  /** The capability record this instance is operating under. */
  get capabilities(): ModelCapabilities {
    return this.caps;
  }

  protected label(): string {
    return `${this.name}/${this.model}`;
  }

  /** Chat-completions URL beneath the configured base URL. */
  protected endpoint(): string {
    return `${this.config.baseUrl.replace(/\/+$/, "")}/chat/completions`;
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

  /**
   * Messages. The system prompt always goes in the `system` role: NIM returns
   * 500s when the `developer` role is combined with chat_template_kwargs, and
   * this provider sends chat_template_kwargs for several models.
   */
  private buildMessages(options: GenerateTextOptions, systemSuffix?: string): any[] {
    const messages: any[] = [];
    const systemParts = [options.systemPrompt, options.cacheableContext, systemSuffix].filter(Boolean);
    if (systemParts.length > 0) {
      if (this.caps.supportsSystemPrompt) {
        messages.push({ role: "system", content: systemParts.join("\n\n") });
      } else {
        messages.push({
          role: "user",
          content: `${systemParts.join("\n\n")}\n\n---\n\n${options.prompt}`,
        });
        return messages;
      }
    }
    messages.push({ role: "user", content: options.prompt });
    return messages;
  }

  private buildBody(
    options: GenerateStructuredOutputOptions,
    kind: "text" | "structured"
  ): { body: Record<string, any>; shaping: ShapeResult; jsonEnforcedInPrompt: boolean } {
    const mode = kind === "structured" ? structuredOutputMode(this.caps, !!options.jsonSchema) : null;
    // Prompt-enforced JSON is the only mode that needs the instruction, but the
    // instruction is harmless and cheap insurance in native modes too — the
    // Anthropic provider has always belt-and-braced it the same way.
    const needsInstruction = kind === "structured";

    const body: Record<string, any> = {
      model: this.model,
      messages: this.buildMessages(options, needsInstruction ? JSON_INSTRUCTION : undefined),
      stream: false,
    };

    // Output allowance: preserved exactly unless a LIVE-VERIFIED cap is
    // exceeded, which throws rather than silently shrinking the request.
    const maxTokens = resolveMaxTokens(this.caps, options.maxTokens);
    if (maxTokens !== undefined) body.max_tokens = maxTokens;

    if (!this.caps.rejectsSampling && options.temperature !== undefined) {
      body.temperature = options.temperature;
    }
    if (options.seed !== undefined && this.caps.supportsSeed && !this.downgradedFields.has("seed")) {
      body.seed = options.seed;
    }

    // Structured output, in the mode this MODEL supports.
    if (
      kind === "structured" &&
      !this.downgradedFields.has("response_format") &&
      mode !== "prompt-enforced"
    ) {
      if (mode === "native-json-schema") {
        body.response_format = {
          type: "json_schema",
          json_schema: { name: "application_schema", schema: options.jsonSchema, strict: false },
        };
      } else {
        body.response_format = { type: "json_object" };
      }
    }

    // Model-specific fields (reasoning, and anything else a profile adds).
    const attribution = currentLlmAttribution();
    const shaping = this.shapeModelFields({
      wantsReasoning: (options.reasoning ?? "off") === "on",
      role: attribution?.role as LLMRole | undefined,
      maxTokens,
      caps: this.caps,
    });
    for (const [key, value] of Object.entries(shaping.fields)) {
      if (this.downgradedFields.has(key)) continue;
      body[key] = value;
    }

    // Answer headroom for models that bill reasoning against max_tokens. This
    // raises the CEILING only — billed output is whatever the model produces —
    // and it is the difference between a reasoning-on call returning an answer
    // and returning nothing but thoughts.
    if (shaping.maxTokensAdd && body.max_tokens !== undefined) {
      const withHeadroom = body.max_tokens + shaping.maxTokensAdd;
      // If a cap has actually been MEASURED, our own addition is what gets
      // clamped — never the caller's request, which resolveMaxTokens already
      // validated above.
      body.max_tokens =
        this.caps.maximumOutputTokens !== undefined
          ? Math.min(withHeadroom, this.caps.maximumOutputTokens)
          : withHeadroom;
    }

    return { body, shaping, jsonEnforcedInPrompt: mode === "prompt-enforced" };
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
      const spentOnThinking = reasoning && finish === "length";
      throw new LlmProviderError({
        provider: this.name,
        model: this.model,
        category: finish === "length" ? "output_limit" : "empty_response",
        message:
          `[${this.label()}] Empty answer content (finish_reason: ${finish ?? "unknown"}).` +
          (spentOnThinking
            ? " The model spent its entire output allowance on reasoning and never produced an answer — lower the reasoning budget, raise maxTokens, or route this role to a non-reasoning model."
            : ""),
      });
    }

    return { text, reasoning };
  }

  private recordUsage(
    data: any,
    durationMs: number,
    meta: {
      attempts: number;
      retries: number;
      repairs: number;
      reasoningRequested: boolean;
      reasoningReturned: boolean;
    }
  ): void {
    const u = data?.usage;
    if (!u) return;
    const cached = u.prompt_tokens_details?.cached_tokens || 0;
    const reasoningTokens =
      u.completion_tokens_details?.reasoning_tokens || u.reasoning_tokens || 0;
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
      // Requested vs actually returned are different facts and are recorded as
      // such: a role must not be able to claim it reasoned because it asked to.
      reasoningRequested: meta.reasoningRequested,
      reasoningReturned: meta.reasoningReturned,
      estimatedCostUsd: estimateCostUsd(
        this.name,
        { tkIn, tkOut, tkCacheRead: cached },
        this.config.unpriced
      ),
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
      reasoningReturned: false,
      estimatedCostUsd: null,
    });
    console.warn(`[${this.name}] call failed — ${describeFailure(err)}`);
  }

  // ---------------------------------------------------------------- transport

  private backoffMs(
    attempt: number,
    retryAfterHeader: string | null,
    category?: LlmErrorCategory
  ): number {
    const retryAfter = Number(retryAfterHeader);
    if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.min(retryAfter * 1000, 60_000);

    // A RATE WINDOW NEEDS A WAIT SIZED TO THE WINDOW, NOT TO THE ATTEMPT — and
    // that wait no longer lives here.
    //
    // The generic curve starts at ~1s and reaches ~3s on the second attempt, so
    // with maxRetries=2 the whole retry budget was spent inside four seconds,
    // still deep inside the per-minute window that had just refused us. It is
    // now rateWindow.ts that decides, because the window belongs to the ACCOUNT
    // and every other role calling this provider has to honour the same clock.
    // The caller sleeps for `rateWindowRemainingMs`, so a `rate_limited` failure
    // never reaches this function.
    if (category === "rate_limited") {
      return rateWindowRemainingMs(this.name);
    }

    const base = Math.min(1000 * Math.pow(3, attempt), 30_000);
    // Jitter: several worker jobs failing on the same upstream blip must not all
    // come back at the same instant.
    return Math.round(base * (0.7 + Math.random() * 0.6));
  }

  /**
   * One HTTP round trip with retries. Returns the parsed body, or null when a
   * request field was specifically rejected and the caller should rebuild.
   */
  private async request(
    body: Record<string, any>,
    state: { attempts: number; retries: number; downgraded: string | null }
  ): Promise<any> {
    let lastErr: unknown = null;
    const sentFields = Object.keys(body);

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      // WAIT OUT A WINDOW THIS PROCESS ALREADY KNOWS IS CLOSED.
      //
      // A per-minute budget belongs to the account, so a 429 that another ROLE
      // collected seconds ago applies to this request too. Sending it anyway is
      // not an attempt — it is a refusal we have already been told about, and it
      // costs a rung of a chain that is two rungs deep on the free tier.
      const cooling = rateWindowRemainingMs(this.name);
      if (cooling > 0) {
        console.warn(
          `[${this.name}] holding ${Math.round(cooling / 1000)}s before calling ${this.model} — this account ` +
            `refused a request with a per-window limit that has not refilled yet. Waiting is the whole point: ` +
            `sending now would spend a fallback rung on a certain refusal.`
        );
        await sleep(cooling);
      }

      state.attempts++;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
      // Wall time for THIS attempt. A failure that arrives faster than inference
      // could possibly have run is evidence in its own right — see
      // IMPLAUSIBLY_FAST_FAILURE_MS in errors.ts.
      const attemptStartedAt = Date.now();
      try {
        const response = await fetch(this.endpoint(), {
          method: "POST",
          headers: this.headers(),
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        if (response.ok) {
          // A completed call is proof the budget refilled — better evidence than
          // the clock we guessed at, so the remembered window is dropped here
          // rather than left to expire.
          clearRateWindow(this.name);
          return await response.json();
        }

        const errorText = redactSecrets(await response.text().catch(() => ""));
        const category = categorizeHttpFailure(
          response.status,
          errorText,
          sentFields,
          Date.now() - attemptStartedAt
        );

        // NARROW downgrade, and only when the provider NAMES a field we sent.
        // This exists to survive provider drift, not as a normal operating path —
        // the registry already declares what each model supports, so a downgrade
        // firing is a signal that a registry record is wrong. An AMBIGUOUS 400
        // never strips anything.
        if (category === "unsupported_parameter") {
          const named = namedUnsupportedField(errorText, DOWNGRADEABLE_FIELDS.filter((f) => f in body));
          if (named && !this.downgradedFields.has(named)) {
            this.downgradedFields.add(named);
            state.downgraded = named;
            console.warn(
              `[${this.name}] ${this.model} specifically rejected '${named}' (HTTP 400). Dropping it for this ` +
                `process and re-sending ONCE. The capability registry in capabilities.ts should be corrected — ` +
                `provider said: ${errorText.slice(0, 200)}`
            );
            return null;
          }
          console.warn(
            `[${this.name}] ${this.model} returned an unsupported-parameter 400 that names no field we sent. ` +
              `Nothing was stripped — guessing which field to remove would be worse than failing. ` +
              `Body: ${errorText.slice(0, 200)}`
          );
        }

        // Remember the window on the ACCOUNT before deciding what to do about
        // this one request. Whether we retry here or the router moves on, every
        // other role pointed at this provider needs to know it is closed —
        // that knowledge is what stops a chain from being spent on refusals.
        if (category === "rate_limited") {
          const held = noteRateWindow(this.name, response.headers.get("retry-after"));
          console.warn(
            `[${this.name}] rate window recorded for the whole ${this.name} account: no request for ` +
              `${Math.round(held / 1000)}s. Provider said: ${errorText.slice(0, 200)}`
          );
        }

        const err = new LlmProviderError({
          provider: this.name,
          model: this.model,
          category,
          status: response.status,
          message: `[${this.label()}] HTTP ${response.status}: ${errorText.slice(0, 600) || "(empty body)"}`,
        });
        if (!err.retryable || attempt === this.config.maxRetries) throw err;
        const delay = this.backoffMs(attempt, response.headers.get("retry-after"), category);

        // A LONG WINDOW IS THE ROUTER'S PROBLEM, NOT THIS LOOP'S.
        //
        // `rate_limited` is genuinely retryable — waiting does fix it — but this
        // loop is the wrong place to do the waiting when the wait is long. It
        // can only ever retry THIS endpoint, while the router holds a chain of
        // other accounts it could try immediately and, failing that, will wait
        // the window out once and re-run the whole chain.
        //
        // Sitting here for a minute per attempt turned one saturated minute into
        // seven (two rungs x three attempts x sixty seconds) before the router
        // got a say. So: short windows are absorbed here, because a couple of
        // seconds is cheaper than a fallback; anything longer is handed up with
        // the window already recorded on the account.
        if (category === "rate_limited" && delay > TRANSPORT_RATE_WAIT_CEILING_MS) {
          console.warn(
            `[${this.name}] ${this.model} is inside a ${Math.round(delay / 1000)}s rate window — handing back to ` +
              `the router rather than holding this endpoint. The window is recorded, so another account gets ` +
              `tried first and the wait happens once for the whole chain.`
          );
          throw err;
        }

        lastErr = err;
        console.warn(
          `[${this.name}] ${response.status} (${category}) on ${this.model} — retrying in ` +
            `${Math.round(delay / 1000)}s (attempt ${attempt + 1}/${this.config.maxRetries}).`
        );
        state.retries++;
        await sleep(delay);
      } catch (err: any) {
        if (err instanceof LlmProviderError) throw err;
        const category = categorizeNetworkFailure(err, Date.now() - attemptStartedAt);
        const wrapped = new LlmProviderError({
          provider: this.name,
          model: this.model,
          category,
          message:
            category === "timeout" && err?.name === "AbortError"
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

  /** request() but rebuilds and re-sends ONCE after a named-field downgrade. */
  private async requestWithDowngrade(
    build: () => { body: Record<string, any>; shaping: ShapeResult; jsonEnforcedInPrompt: boolean },
    state: { attempts: number; retries: number; downgraded: string | null }
  ): Promise<{ data: any; shaping: ShapeResult }> {
    let built = build();
    let data = await this.request(built.body, state);
    if (data === null) {
      built = build();
      data = await this.request(built.body, state);
      if (data === null) {
        throw new LlmProviderError({
          provider: this.name,
          model: this.model,
          category: "unsupported_parameter",
          message:
            `[${this.label()}] Provider rejected named request fields twice; giving up rather than guessing further. ` +
            `Correct the capability record for this model.`,
        });
      }
    }
    return { data, shaping: built.shaping };
  }

  // ---------------------------------------------------------------- public API

  async generateText(options: GenerateTextOptions): Promise<string> {
    const wantsReasoning = (options.reasoning ?? "off") === "on";
    const state = { attempts: 0, retries: 0, downgraded: null as string | null };
    const startedAt = Date.now();
    console.log(`[${this.name}] Requesting completion via model: ${this.model}`);
    try {
      const { data, shaping } = await this.requestWithDowngrade(
        () => this.buildBody(options as GenerateStructuredOutputOptions, "text"),
        state
      );
      const { text, reasoning } = this.extractContent(data);
      this.logShaping(shaping, reasoning);
      this.recordUsage(data, Date.now() - startedAt, {
        attempts: state.attempts,
        retries: state.retries,
        repairs: 0,
        reasoningRequested: shaping.diagnostics.reasoningRequested,
        reasoningReturned: reasoning !== null,
      });
      // Only the ANSWER is returned. Reasoning is dropped here, at the edge.
      return text;
    } catch (err) {
      this.recordFailure(Date.now() - startedAt, err, {
        attempts: state.attempts,
        retries: state.retries,
        repairs: 0,
        reasoningRequested: wantsReasoning,
      });
      throw err;
    }
  }

  async generateStructuredOutput<T = any>(options: GenerateStructuredOutputOptions): Promise<T> {
    const wantsReasoning = (options.reasoning ?? "off") === "on";
    const repairEnabled =
      (readRoutingEnv("LLM_STRUCTURED_REPAIR_ENABLED") || "true").toLowerCase() !== "false";
    const state = { attempts: 0, retries: 0, downgraded: null as string | null };
    const startedAt = Date.now();
    let repairs = 0;
    const mode = structuredOutputMode(this.caps, !!options.jsonSchema);
    console.log(
      `[${this.name}] Requesting structured output (${mode}) via model: ${this.model}`
    );

    const attemptOnce = async (opts: GenerateStructuredOutputOptions): Promise<T> => {
      const { data, shaping } = await this.requestWithDowngrade(
        () => this.buildBody(opts, "structured"),
        state
      );
      const { text, reasoning } = this.extractContent(data);
      this.logShaping(shaping, reasoning);
      // Reasoning is NOT passed to the parser — that would be the exact path by
      // which private reasoning leaks into structured application data.
      let parsed: T;
      try {
        parsed = parseStructuredResponse<T>(text, {
          jsonSchema: opts.jsonSchema,
          validate: opts.validate,
          label: this.label(),
        });
      } catch (err) {
        if (err instanceof StructuredOutputError) throw err;
        // The caller's validator itself threw — that is our bug, not the model's.
        throw new LlmProviderError({
          provider: this.name,
          model: this.model,
          category: "data_validation_bug",
          message:
            `[${this.label()}] The caller's structured-output validator threw: ${describeFailure(err)}. ` +
            `This is an application defect, not a provider failure — no other model will fix it.`,
          cause: err,
        });
      }
      this.recordUsage(data, Date.now() - startedAt, {
        attempts: state.attempts,
        retries: state.retries,
        repairs,
        reasoningRequested: shaping.diagnostics.reasoningRequested,
        reasoningReturned: reasoning !== null,
      });
      return parsed;
    };

    try {
      return await attemptOnce(options);
    } catch (firstErr) {
      if (!(firstErr instanceof StructuredOutputError) || !repairEnabled) {
        this.recordFailure(Date.now() - startedAt, firstErr, {
          attempts: state.attempts,
          retries: state.retries,
          repairs,
          reasoningRequested: wantsReasoning,
        });
        throw firstErr;
      }

      repairs = 1;
      console.warn(
        `[${this.name}] structured output rejected (${firstErr.kind}) — ONE repair request. ` +
          `Excerpt: ${firstErr.excerpt.slice(0, 200)}`
      );
      try {
        return await attemptOnce({ ...options, prompt: buildRepairPrompt(options.prompt, firstErr) });
      } catch (repairErr) {
        this.recordFailure(Date.now() - startedAt, repairErr, {
          attempts: state.attempts,
          retries: state.retries,
          repairs,
          reasoningRequested: wantsReasoning,
        });
        // A validator bug or a policy refusal during the repair keeps ITS
        // category — those stop the chain, and mislabelling them as a structured
        // failure would send the router hunting through three more models.
        if (repairErr instanceof LlmProviderError && repairErr.category !== "unknown") throw repairErr;
        const detail =
          repairErr instanceof StructuredOutputError ? repairErr.kind : describeFailure(repairErr);
        throw new LlmProviderError({
          provider: this.name,
          model: this.model,
          category: "structured_output_invalid_after_repair",
          message:
            `[${this.label()}] Structured output failed (${firstErr.kind}) and the single repair attempt also failed ` +
            `(${detail}). No partial result was returned.`,
          cause: repairErr,
        });
      }
    }
  }

  /**
   * Log what was actually sent, and what actually came back.
   *
   * Reasoning is reported as having HAPPENED only when the response carried it —
   * asking for reasoning is not evidence that any occurred, and a role map that
   * claims otherwise is how "the outline ran with reasoning" becomes untrue.
   */
  private logShaping(shaping: ShapeResult, reasoning: string | null): void {
    const requested = shaping.diagnostics.reasoningRequested;
    if (requested && !reasoning) {
      console.log(
        `[${this.name}] ${shaping.diagnostics.note} — NOTE: reasoning was requested but the response returned ` +
          `no separate reasoning content, so this call must not be reported as having reasoned.`
      );
    } else if (shaping.diagnostics.note) {
      console.debug(`[${this.name}] ${shaping.diagnostics.note}`);
    }
    if (!reasoning) return;
    if ((readRoutingEnv("LLM_LOG_REASONING") || "").toLowerCase() === "true") {
      console.debug(`[${this.name}] reasoning (${reasoning.length} chars): ${reasoning.slice(0, 2000)}`);
    } else {
      console.log(
        `[${this.name}] model returned separate reasoning content (${reasoning.length} chars, not logged).`
      );
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
      category: "missing_api_key",
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
