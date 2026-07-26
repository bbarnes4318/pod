// Classified LLM provider failures.
//
// The category matters as much as the message. A 503 is worth retrying; a
// missing API key, an invalid model id, an unsupported request parameter, an
// application-schema error and a safety refusal are NOT — retrying them burns
// the request budget and hides the real defect. A fallback to the next model may
// still happen after a non-transient failure, but the ORIGINAL category stays
// visible in the log and the ledger so nobody debugs "NVIDIA was flaky" when the
// truth was "NVIDIA_API_KEY was never set".

export type LlmErrorCategory =
  | "transient"
  | "missing_credentials"
  | "invalid_authentication"
  | "invalid_model"
  | "unsupported_parameter"
  | "invalid_request"
  | "safety_refusal"
  | "quota_exhausted"
  | "structured_output"
  | "output_limit"
  | "programming_error"
  | "unknown";

/** Categories that are safe to retry against the SAME provider/model. */
const RETRYABLE: ReadonlySet<LlmErrorCategory> = new Set<LlmErrorCategory>(["transient"]);

export function isRetryableCategory(category: LlmErrorCategory): boolean {
  return RETRYABLE.has(category);
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
 * Every credential this process holds. Any of these appearing in a message,
 * a log line or an error body is replaced before the text leaves this module.
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

/**
 * Replace any known credential with [REDACTED], plus anything that looks like a
 * bearer token or a provider key prefix. Applied to every provider error message
 * and every provider log line.
 */
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

/** Map an HTTP status + body onto a category. */
export function categorizeHttpFailure(status: number, body: string): LlmErrorCategory {
  const b = (body || "").toLowerCase();

  if (status === 401 || status === 403) return "invalid_authentication";
  if (status === 404) {
    // A 404 from a chat-completions endpoint is almost always an unknown model id.
    return /model/.test(b) || !b ? "invalid_model" : "invalid_request";
  }
  if (status === 422) return "invalid_request";
  if (status === 400) {
    if (/unsupported|unrecognized|unknown (field|parameter|argument)|not supported|extra inputs/.test(b)) {
      return "unsupported_parameter";
    }
    if (/model/.test(b) && /(not found|does not exist|invalid|unknown)/.test(b)) return "invalid_model";
    if (/content (policy|filter)|safety|refus/.test(b)) return "safety_refusal";
    return "invalid_request";
  }
  if (status === 429) {
    // A hard free-tier quota is not a rate limit that clears in two seconds.
    if (/quota|credit|balance|exceeded your current/.test(b)) return "quota_exhausted";
    return "transient";
  }
  if (status === 408 || status === 409 || status === 425) return "transient";
  if (status >= 500) return "transient";
  return "unknown";
}

/** Map a thrown network/abort error onto a category. */
export function categorizeNetworkFailure(err: unknown): LlmErrorCategory {
  const msg = String((err as Error)?.message || err || "").toLowerCase();
  const name = String((err as Error)?.name || "");
  if (name === "AbortError" || /aborted|timeout|timed out/.test(msg)) return "transient";
  if (/econnreset|econnrefused|enotfound|eai_again|socket hang up|network|fetch failed|und_err/.test(msg)) {
    return "transient";
  }
  if (err instanceof TypeError) return "programming_error";
  return "unknown";
}

/** One-line, credential-free summary for logs and the ledger. */
export function describeFailure(err: unknown): string {
  if (err instanceof LlmProviderError) {
    return redactSecrets(
      `${err.category}${err.status ? ` (HTTP ${err.status})` : ""}: ${err.message}`
    );
  }
  return redactSecrets(String((err as Error)?.message || err));
}
