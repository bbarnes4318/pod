// Classified LLM provider failures.
//
// The category IS the routing decision. Three groups, and the group determines
// what the router is allowed to do next (see fallbackPolicy.ts):
//
//   RECOVERABLE      the request was fine, this endpoint was not. Another
//                    candidate is worth trying, and some are worth retrying
//                    against the same endpoint first.
//   TERMINAL         the request itself is wrong, or the model refused on
//                    policy grounds. No other provider fixes it, so the chain
//                    STOPS and the real defect surfaces instead of being buried
//                    under four more failures.
//   CONFIGURATION    a key, a model id or a request field is misconfigured.
//                    Progress to another FREE candidate is allowed so a
//                    development run is not blocked, but the original failure
//                    stays visible and paid fallback needs explicit consent.
//
// Retrying a terminal category burns the request budget and hides the defect;
// stopping on a recoverable one throws away a working fallback. Both mistakes
// are expensive, which is why the mapping is explicit and tested.

export type LlmErrorCategory =
  // ---- recoverable: try again here, or move to the next candidate ----
  | "rate_limited"
  | "temporary_unavailable"
  | "network_error"
  | "timeout"
  | "provider_internal_error"
  | "model_temporarily_unavailable"
  | "empty_response"
  | "output_limit"
  | "structured_output_invalid_after_repair"
  | "quota_exhausted"
  // ---- terminal: another model will not fix this ----
  | "invalid_application_schema"
  | "programming_error"
  | "unsupported_role"
  | "safety_refusal"
  | "prompt_policy_violation"
  | "data_validation_bug"
  // ---- configuration: visible, and paid fallback needs consent ----
  | "missing_api_key"
  | "authentication_failed"
  | "invalid_model"
  | "unsupported_parameter"
  // ---- unclassifiable ----
  | "unknown";

/** Categories that are safe to retry against the SAME provider/model. */
const SAME_ENDPOINT_RETRYABLE: ReadonlySet<LlmErrorCategory> = new Set<LlmErrorCategory>([
  "rate_limited",
  "temporary_unavailable",
  "network_error",
  "timeout",
  "provider_internal_error",
  "model_temporarily_unavailable",
]);

/**
 * Categories where moving to the next candidate is the right move.
 *
 * `quota_exhausted` is here but NOT in the retry set: a spent free-tier
 * allowance does not refill in two seconds, so retrying is pure waste while
 * falling through is exactly right.
 */
const CONTINUE_TO_NEXT_CANDIDATE: ReadonlySet<LlmErrorCategory> = new Set<LlmErrorCategory>([
  "rate_limited",
  "temporary_unavailable",
  "network_error",
  "timeout",
  "provider_internal_error",
  "model_temporarily_unavailable",
  "empty_response",
  "output_limit",
  "structured_output_invalid_after_repair",
  "quota_exhausted",
]);

/** Categories that stop the chain: no provider swap can fix them. */
const TERMINAL: ReadonlySet<LlmErrorCategory> = new Set<LlmErrorCategory>([
  "invalid_application_schema",
  "programming_error",
  "unsupported_role",
  "safety_refusal",
  "prompt_policy_violation",
  "data_validation_bug",
]);

/** Misconfiguration: advance among FREE candidates, never hide, consent for paid. */
const CONFIGURATION: ReadonlySet<LlmErrorCategory> = new Set<LlmErrorCategory>([
  "missing_api_key",
  "authentication_failed",
  "invalid_model",
  "unsupported_parameter",
]);

export function isRetryableCategory(category: LlmErrorCategory): boolean {
  return SAME_ENDPOINT_RETRYABLE.has(category);
}

export function isContinueCategory(category: LlmErrorCategory): boolean {
  return CONTINUE_TO_NEXT_CANDIDATE.has(category);
}

export function isTerminalCategory(category: LlmErrorCategory): boolean {
  return TERMINAL.has(category);
}

export function isConfigurationCategory(category: LlmErrorCategory): boolean {
  return CONFIGURATION.has(category);
}

export interface LlmProviderErrorInit {
  provider: string;
  model: string;
  category: LlmErrorCategory;
  message: string;
  status?: number;
  cause?: unknown;
}

export class LlmProviderError extends Error {
  readonly provider: string;
  readonly model: string;
  readonly category: LlmErrorCategory;
  readonly status?: number;
  readonly retryable: boolean;

  constructor(init: LlmProviderErrorInit) {
    super(redactSecrets(init.message));
    this.name = "LlmProviderError";
    this.provider = init.provider;
    this.model = init.model;
    this.category = init.category;
    this.status = init.status;
    this.retryable = isRetryableCategory(init.category);
    if (init.cause !== undefined) (this as { cause?: unknown }).cause = init.cause;
  }
}

/**
 * Every credential this process holds. Any of these appearing in a message, a
 * log line or a provider's own error body is replaced before the text leaves
 * this module.
 *
 * Literal reads only — see routingEnv.ts for why a computed read cannot be
 * trusted in the web bundle.
 */
function knownSecrets(): string[] {
  return [
    process.env.NVIDIA_API_KEY,
    process.env.ZAI_API_KEY,
    process.env.ANTHROPIC_API_KEY,
    process.env.OPENAI_API_KEY,
  ]
    .filter((v): v is string => typeof v === "string" && v.trim().length >= 8)
    .map((v) => v.trim());
}

export function redactSecrets(text: string): string {
  let out = String(text ?? "");
  for (const secret of knownSecrets()) {
    if (!secret) continue;
    out = out.split(secret).join("[REDACTED]");
  }
  // Belt-and-braces for shapes we may never have held in env (a key echoed back
  // inside a provider's own error body, for example).
  out = out.replace(/\b(sk-[A-Za-z0-9_-]{8,}|nvapi-[A-Za-z0-9_-]{8,})\b/g, "[REDACTED]");
  out = out.replace(/(Bearer|Authorization|x-api-key)(["':\s]+)[A-Za-z0-9._-]{8,}/gi, "$1$2[REDACTED]");
  return out;
}

/** Which request field, if any, a provider's 400 body specifically names. */
export function namedUnsupportedField(body: string, sentFields: string[]): string | null {
  const b = (body || "").toLowerCase();
  for (const field of sentFields) {
    if (b.includes(field.toLowerCase())) return field;
  }
  return null;
}

/**
 * Map an HTTP status + body onto a category.
 *
 * `sentFields` are the top-level request fields this call actually sent. A 400
 * only counts as `unsupported_parameter` when the provider NAMES one of them —
 * an ambiguous 400 must not license stripping fields at random, so it is
 * classified as our own bad request instead.
 */
export function categorizeHttpFailure(
  status: number,
  body: string,
  sentFields: string[] = []
): LlmErrorCategory {
  const b = (body || "").toLowerCase();

  if (status === 401 || status === 403) return "authentication_failed";

  if (status === 404) {
    // A 404 that talks about the model is an unknown model id. A 404 that does
    // not is us calling the wrong path — our bug, not the model's.
    if (/model/.test(b) || !b.trim()) return "invalid_model";
    return "programming_error";
  }

  if (status === 400 || status === 422) {
    if (/content (policy|filter)|policy violation|prohibited|moderation/.test(b)) {
      return "prompt_policy_violation";
    }
    if (/model/.test(b) && /(not found|does not exist|unknown|invalid|unsupported)/.test(b)) {
      return "invalid_model";
    }
    // An invalid json_schema is OUR schema being wrong — no other model fixes it.
    if (/schema/.test(b) && sentFields.includes("response_format")) {
      return "invalid_application_schema";
    }
    if (namedUnsupportedField(b, sentFields)) return "unsupported_parameter";
    if (/unsupported|unrecognized|unknown (field|parameter|argument)|extra inputs|not supported/.test(b)) {
      // Says "unsupported" but names nothing we sent — do not guess which field.
      return "unsupported_parameter";
    }
    return "programming_error";
  }

  if (status === 429) {
    // A spent free-tier allowance is not a rate limit that clears in seconds.
    if (/quota|credit|balance|exceeded your current|insufficient/.test(b)) return "quota_exhausted";
    return "rate_limited";
  }

  if (status === 408) return "timeout";
  if (status === 409 || status === 425) return "temporary_unavailable";

  if (status === 503) {
    if (/model|loading|warm|capacity|not ready/.test(b)) return "model_temporarily_unavailable";
    return "temporary_unavailable";
  }
  if (status === 502 || status === 504) return "temporary_unavailable";
  if (status >= 500) return "provider_internal_error";

  return "unknown";
}

/** Map a thrown network/abort error onto a category. */
export function categorizeNetworkFailure(err: unknown): LlmErrorCategory {
  const msg = String((err as Error)?.message || err || "").toLowerCase();
  const name = String((err as Error)?.name || "");
  if (name === "AbortError" || /aborted|timeout|timed out/.test(msg)) return "timeout";
  if (/econnreset|econnrefused|enotfound|eai_again|socket hang up|network|fetch failed|und_err/.test(msg)) {
    return "network_error";
  }
  if (err instanceof TypeError) return "programming_error";
  return "unknown";
}

/** One-line, credential-free summary for logs and the ledger. */
export function describeFailure(err: unknown): string {
  if (err instanceof LlmProviderError) {
    return redactSecrets(`${err.category}${err.status ? ` (HTTP ${err.status})` : ""}: ${err.message}`);
  }
  return redactSecrets(String((err as Error)?.message || err));
}

/**
 * Fields the existing Anthropic/OpenAI adapters can put in a request. Used to
 * classify THEIR plain-Error messages with the same rules as the new providers.
 */
const LEGACY_ADAPTER_FIELDS = [
  "response_format",
  "temperature",
  "max_tokens",
  "max_completion_tokens",
  "seed",
  "thinking",
  "output_config",
  "system",
];

/**
 * The category of any thrown value, for policy decisions and the ledger.
 *
 * The pre-existing Anthropic and OpenAI providers throw plain Errors — they are
 * deliberately left untouched — so their messages are parsed here instead. Without
 * this, every legacy-provider failure classified as "unknown", the router treated
 * it as recoverable, and an invalid application schema would march through the
 * whole chain instead of stopping at the first honest answer.
 */
export function categoryOf(err: unknown): LlmErrorCategory {
  if (err instanceof LlmProviderError) return err.category;

  const msg = String((err as Error)?.message || "");

  // Missing credential, thrown by the legacy constructors.
  if (/Missing or default (ANTHROPIC|OPENAI)_API_KEY/i.test(msg)) return "missing_api_key";
  // Anthropic's own refusal path.
  if (/refused by the model's safety system/i.test(msg)) return "safety_refusal";
  // Empty/unparseable responses from the legacy adapters.
  if (/Received empty response content|No text content in response/i.test(msg)) return "empty_response";
  if (/Failed to parse output as valid JSON/i.test(msg)) return "structured_output_invalid_after_repair";

  // `[Provider] ... failed with status <code>: <body>` — the shape both legacy
  // adapters use.
  const http = msg.match(/status (\d{3})\s*:?\s*([\s\S]*)$/);
  if (http) {
    return categorizeHttpFailure(Number(http[1]), http[2] || "", LEGACY_ADAPTER_FIELDS);
  }

  if (err instanceof TypeError) return "programming_error";
  return "unknown";
}
