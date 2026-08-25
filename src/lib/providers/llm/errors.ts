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
//   BILLING          the ACCOUNT behind the credential has no money. Not a bad
//                    request, not an outage, not a rate limit. Every other model
//                    on that provider bills the same account, so the router must
//                    skip them rather than burn through them.
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
  // ---- billing: the account needs funding, and only a human can do that ----
  | "insufficient_credit"
  // ---- the endpoint refused instantly and said nothing ----
  | "endpoint_rejected_fast"
  // ---- unclassifiable ----
  | "unknown";

/**
 * Below this, a failed request did not run inference — nothing generated a
 * token in the time available, so the endpoint rejected the request outright.
 *
 * 50ms is deliberately generous. The observed case (deepseek-v4-pro, 2026-08-10)
 * failed in 14-27ms; the slowest plausible real completion is orders of
 * magnitude above this, so the threshold does not need to be tight to be safe.
 */
export const IMPLAUSIBLY_FAST_FAILURE_MS = 50;

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
  // Advance, but deliberately NOT in the retry set above. An endpoint that
  // refused in under 50ms will refuse the next request in under 50ms too, so
  // retrying it is guaranteed waste — while the NEXT candidate is exactly what
  // should run. This is the same verdict `unknown` already got from the policy's
  // default branch; the difference is that it is now named, so a model failing
  // this way is visible as broken rather than filed under "unclassifiable".
  "endpoint_rejected_fast",
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

/**
 * The account is out of money.
 *
 * Deliberately its OWN group rather than a member of CONFIGURATION. A
 * configuration failure may advance to another free candidate; a billing failure
 * must not advance to another model on the same provider, because every one of
 * them bills the same account and will fail identically. It is also not
 * TERMINAL: a genuinely different provider, on a different account, is a legitimate
 * fallback. Neither existing group expresses that, which is why this one exists.
 */
const BILLING: ReadonlySet<LlmErrorCategory> = new Set<LlmErrorCategory>(["insufficient_credit"]);

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

export function isBillingCategory(category: LlmErrorCategory): boolean {
  return BILLING.has(category);
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
    process.env.XAI_API_KEY,
    process.env.MOONSHOT_API_KEY,
    process.env.GOOGLE_API_KEY,
    process.env.GEMINI_API_KEY,
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

/**
 * How much of a provider's own message may travel with a classification.
 *
 * Error bodies can echo the request back — system prompts, briefs, whole
 * transcripts. None of that helps an operator and all of it ends up in logs and
 * downloadable artifacts, so the structured message is bounded here.
 */
const MAX_PROVIDER_MESSAGE_CHARS = 300;

export interface ProviderErrorShape {
  /** The provider's own error type, e.g. "invalid_request_error". */
  type: string | null;
  /** The provider's own message: redacted, bounded, never the whole body. */
  message: string | null;
  /** True when the body really was the `{error:{type,message}}` envelope. */
  structured: boolean;
}

/**
 * Read the structured error envelope Anthropic and OpenAI both emit.
 *
 * Total-failure-tolerant by design: any body that is not that envelope comes
 * back `structured: false` with nothing extracted, and callers fall back to the
 * substring rules that have always handled unstructured providers. Nothing here
 * throws, and nothing here returns a field it did not find.
 */
export function parseProviderErrorBody(body: string): ProviderErrorShape {
  const absent: ProviderErrorShape = { type: null, message: null, structured: false };
  const raw = String(body ?? "").trim();
  if (!raw.startsWith("{")) return absent;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return absent;
  }
  if (!parsed || typeof parsed !== "object") return absent;

  // `{"type":"error","error":{"type":"invalid_request_error","message":"…"}}`
  // — the inner node when present, the top level otherwise.
  const outer = parsed as Record<string, unknown>;
  const inner = outer.error;
  const node = (inner && typeof inner === "object" ? inner : outer) as Record<string, unknown>;

  const type = typeof node.type === "string" ? node.type : null;
  const message = typeof node.message === "string" ? node.message : null;
  if (type === null && message === null) return absent;

  return {
    type,
    message: message === null ? null : redactSecrets(message).slice(0, MAX_PROVIDER_MESSAGE_CHARS),
    structured: true,
  };
}

/**
 * Language that means "this account has no money", and nothing else.
 *
 * Every alternative names currency or an unfunded account explicitly. None of
 * them can match a malformed request, an unknown field or a bad model id,
 * because a false positive here sends an operator to go pay a bill that is
 * already paid while the real defect stays unfixed.
 */
const INSUFFICIENT_CREDIT = new RegExp(
  [
    "credit balance is too low",
    "insufficient (credit|credits|funds|balance)",
    "billing (hard )?limit (has been )?reached",
    "(purchase|buy|add) (more )?(credits|funds)",
    "payment (is )?required",
    "account (is )?(not funded|unfunded)",
    // OBSERVED 2026-08-05 against live accounts, both arriving as HTTP 429:
    //   Google  "Your prepayment credits are depleted."
    //   Z.ai    "Insufficient balance or no resource package. Please recharge."
    // The Z.ai text already matched on "insufficient balance"; Google's did not
    // match anything, which is what sent me looking at the status code.
    "(credit|credits|balance) (are|is )?depleted",
    "prepayment credits",
    "please recharge",
  ].join("|"),
  "i"
);

/**
 * Does this response body say the account needs funding?
 *
 * When the provider gave a structured envelope, ONLY its own `message` field is
 * considered. Scanning the whole body would let echoed request content — a
 * script line about a team's payroll, say — decide that someone owes money.
 */
export function looksLikeInsufficientCredit(body: string): boolean {
  const shape = parseProviderErrorBody(body);
  const text = shape.structured ? shape.message ?? "" : String(body ?? "");
  return INSUFFICIENT_CREDIT.test(text);
}

/**
 * A limit measured per unit of TIME, which therefore refills on its own.
 *
 * "Tokens per minute", "requests per second", "rate limit reached" — all clear
 * by waiting. A depleted balance or a spent daily allowance does not, and must
 * keep falling through to `quota_exhausted`.
 *
 * Deliberately narrow: it requires an explicit time unit or the words "rate
 * limit". The bare word "quota" is NOT enough, because that is exactly the
 * token that misclassified Cerebras (`"param":"quota"`).
 */
const REFILLING_RATE_WINDOW = new RegExp(
  [
    // "tokens per minute", "requests per min", "TPM/RPM/TPD limit"
    "per (second|minute|hour)",
    "\\b(tpm|rpm|rps|tps)\\b",
    "\\b(requests|tokens)\\s*/\\s*(second|minute|min|hour)",
    // Generic phrasing that is unambiguously about pacing, not funding.
    "rate[ _-]?limit",
    "too many requests",
    "slow down",
  ].join("|"),
  "i"
);

/**
 * Does this 429 describe a window that refills, rather than an account that
 * needs money or a day's allowance that is gone?
 *
 * Only the provider's own `message` reaches the test when the body is a
 * structured envelope — field names like `param` and `code` are metadata about
 * the error, not the provider's description of it, and letting them vote is how
 * a per-minute limit came to be treated as a spent allowance.
 */
export function looksLikeRefillingRateWindow(body: string): boolean {
  const shape = parseProviderErrorBody(body);
  const text = shape.structured ? shape.message ?? "" : String(body ?? "");
  // Funding language always wins: "monthly credit limit reached" mentions a
  // time unit but is settled with a payment, not with patience.
  if (INSUFFICIENT_CREDIT.test(text)) return false;
  return REFILLING_RATE_WINDOW.test(text);
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
  sentFields: string[] = [],
  elapsedMs?: number
): LlmErrorCategory {
  const b = (body || "").toLowerCase();

  // ---- account funding, checked before anything status-specific ----
  //
  // Anthropic reports an unfunded account as a 400 `invalid_request_error`. The
  // 400 rules below would read that as "the request we sent was malformed" and
  // return `programming_error`, sending an operator to debug code when the only
  // fix is to add credit — and, because programming_error is TERMINAL, doing it
  // with a message that says no other model can help for the wrong reason.
  //
  // A 402 is unambiguous on its own. Any other status must have the provider
  // actually NAME the money, so an ordinary bad request keeps its own category.
  //
  // 429 IS INCLUDED, and that was a correction. It was excluded on the reasoning
  // that a spent allowance is `quota_exhausted` and a rate limit must stay a rate
  // limit — both true, and both irrelevant to what live providers actually send.
  // Smoke-testing real accounts on 2026-08-05 produced:
  //
  //   Google  429  "Your prepayment credits are depleted."
  //   Z.ai    429  "Insufficient balance or no resource package. Please recharge."
  //
  // Neither is a rate limit. Classified as one, the operator is told to wait and
  // retry, and waiting never adds money — the same misleading advice the 400 case
  // was fixed to stop giving. A 429 with no funding language in the provider's
  // OWN message field still falls through to the rate-limit rules untouched.
  if (status === 402) return "insufficient_credit";
  if (
    (status === 400 || status === 403 || status === 429) &&
    looksLikeInsufficientCredit(body)
  ) {
    return "insufficient_credit";
  }

  if (status === 401 || status === 403) return "authentication_failed";

  if (status === 404) {
    // A 404 that talks about the model is an unknown model id. A 404 that does
    // not is us calling the wrong path — our bug, not the model's.
    if (/model/.test(b) || !b.trim()) return "invalid_model";
    return "programming_error";
  }

  // 410 GONE — the model was real and has been RETIRED.
  //
  // Observed live 2026-08-12: NVIDIA returned
  //   410 {"title":"Gone","detail":"The model 'mistralai/mistral-medium-3.5-128b'
  //        has reached its end of life on 2026-08-07T09:00:00Z"}
  // and the taxonomy had no case for it, so it landed as `unknown` — the router
  // read a PERMANENT retirement as a maybe-transient blip and kept the model in
  // the chain. Exactly the deepseek-v4-pro shape with a different cause, and the
  // reason that one went unnoticed for weeks.
  //
  // `invalid_model` is the honest category: the id is no longer served, the
  // remedy is to change the route, and its operator action already says so. It
  // is a CONFIGURATION failure, so routing advances among the free candidates
  // and reports it rather than retrying a model that no longer exists.
  if (status === 410) return "invalid_model";

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
    // A REFILLING WINDOW IS CHECKED FIRST, AND THIS ORDER IS THE WHOLE POINT.
    //
    // Cerebras refuses an oversized call with:
    //
    //   {"message":"Tokens per minute limit exceeded - too many tokens
    //     processed.","type":"too_many_tokens_error","param":"quota",
    //     "code":"token_quota_exceeded"}
    //
    // The old rule tested /quota|credit|balance/ against the WHOLE body, so
    // `"param":"quota"` — a field name, not a sentence — classified a
    // per-minute limit as a spent allowance. `quota_exhausted` is the one 429
    // that is deliberately never retried, so the router abandoned the provider
    // instantly instead of waiting out a window that clears in under a minute.
    //
    // Cost of that on 2026-08-16: Cerebras answered script:outline (3,262
    // tokens out, 2.0s), script:private-agendas and script:story-spine, spending
    // its per-minute budget on the small calls — then refused the big turn-plan.
    // The chain fell through to Groq (schema violation on the largest schema)
    // and Anthropic (unfunded) and killed the episode, roughly 50 seconds after
    // a 60-second wait would have fixed it. Three runs, same shape every time.
    //
    // Only the provider's OWN message field is scanned, for the same reason
    // looksLikeInsufficientCredit does it: field names and echoed request
    // content must not decide what kind of failure this is.
    if (looksLikeRefillingRateWindow(body)) return "rate_limited";

    // A spent allowance genuinely does not refill in seconds — moving on is right.
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

  return unknownOrRejectedFast(body, elapsedMs);
}

/**
 * Last resort: distinguish "we cannot classify this" from "the endpoint refused
 * instantly and told us nothing".
 *
 * Applied ONLY where the answer would otherwise be `unknown`, so it can never
 * override a real classification — a genuine 429 that happens to come back in
 * 20ms is still a rate limit. Two conditions, both required: implausibly fast,
 * and no body to read. A fast failure that DID explain itself is not this case;
 * the right fix there is a new rule above, not this fallback.
 *
 * The distinction earns its place because the two call for opposite responses.
 * `unknown` means "the taxonomy in this file needs a case" — a code fix.
 * `endpoint_rejected_fast`, seen repeatedly on one model, means that model is
 * not serving this account at all — a capability-record fix, and the reason
 * deepseek-v4-pro sat in the chain for weeks costing a guaranteed-losing hop on
 * every failover while its record still read "LIVE VERIFIED".
 */
function unknownOrRejectedFast(body: string, elapsedMs?: number): LlmErrorCategory {
  const noContext = (body || "").trim().length === 0;
  if (typeof elapsedMs === "number" && elapsedMs < IMPLAUSIBLY_FAST_FAILURE_MS && noContext) {
    return "endpoint_rejected_fast";
  }
  return "unknown";
}

/** Map a thrown network/abort error onto a category. */
export function categorizeNetworkFailure(err: unknown, elapsedMs?: number): LlmErrorCategory {
  const msg = String((err as Error)?.message || err || "").toLowerCase();
  const name = String((err as Error)?.name || "");
  if (name === "AbortError" || /aborted|timeout|timed out/.test(msg)) return "timeout";
  if (/econnreset|econnrefused|enotfound|eai_again|socket hang up|network|fetch failed|und_err/.test(msg)) {
    return "network_error";
  }
  if (err instanceof TypeError) return "programming_error";
  // A transport error carries no HTTP body, so the body condition is vacuous
  // here and timing is the only signal available.
  return unknownOrRejectedFast("", elapsedMs);
}

/**
 * What a human must actually DO about a category.
 *
 * Null where there is no single answer. This exists so the operator-facing
 * surfaces (the canary summary, the readiness report) stop making the reader
 * translate a taxonomy name into an action — "programming_error" sent people
 * looking for a bug that was never there.
 */
export function operatorAction(category: LlmErrorCategory): string | null {
  switch (category) {
    case "insufficient_credit":
      return (
        "Fund the provider account. Add credit to the billing plan behind this API key. " +
        "No model change, retry or fallback clears this — the key is valid and the account is empty."
      );
    case "authentication_failed":
      return "The credential was PRESENT and REJECTED. Rotate or correct this provider's API key.";
    case "missing_api_key":
      return "Set this provider's API key.";
    case "invalid_model":
      return "The model id is not served by this provider. Correct the route's _LLM_MODEL.";
    case "quota_exhausted":
      return "A free-tier allowance is spent. Wait for the window to reset or route this role elsewhere.";
    case "endpoint_rejected_fast":
      return (
        `The endpoint refused in under ${IMPLAUSIBLY_FAST_FAILURE_MS}ms with an empty body — no inference ran. ` +
        "Once is noise; repeatedly on the same model means that model is not serving this account, whatever its " +
        "capability record says. Set its availability to `broken-in-production` in capabilities.ts so the default " +
        "chains stop paying a guaranteed-losing attempt on every failover, and re-probe before restoring it."
      );
    default:
      return null;
  }
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

  // TRANSPORT FAILURES, AND WHY THIS DELEGATES RATHER THAN REPEATING ITSELF.
  //
  // This used to end with `if (err instanceof TypeError) return
  // "programming_error"; return "unknown";` and nothing in between. Node throws
  // a failed fetch as a TypeError — `TypeError: fetch failed`, with the real
  // cause hidden on `.cause` — so every transport failure out of the legacy
  // Anthropic and OpenAI adapters landed on that line and was labelled
  // programming_error, which is TERMINAL. The router stops on terminal: no
  // failover, no retry, and an operator told to go debug code.
  //
  // Observed in production 2026-08-25, episode e579f96e. The turn-plan call ran
  // 912 SECONDS across three attempts and returned zero tokens in and zero out,
  // then died with `fetch failed`. The job log rendered it as
  //
  //   Role 'script_debate_architect' STOPPED at 1 candidate(s) ...
  //   programming_error on anthropic/claude-sonnet-5 ... is not a provider
  //   problem — no other model fixes it.
  //
  // Every clause of which was wrong. It WAS a provider problem, another model
  // WOULD have fixed it — the same run had already completed two calls on that
  // exact model and more on Opus and Haiku — and the declared Haiku rung behind
  // it was never tried. A network blip ended a paid episode at role 2 of 7.
  //
  // categorizeNetworkFailure already gets this right and has since it was
  // written: it tests the MESSAGE for the transport signatures first and only
  // falls back to the TypeError check for a genuine one. Both functions
  // classify thrown values and only one of them knew about transport, so the
  // fix is to have this one defer to it rather than grow a second copy of the
  // same regex that can drift from it.
  //
  // Behaviour is unchanged everywhere else: with no elapsedMs, that function's
  // own tail returns "unknown", which is exactly what this line returned.
  return categorizeNetworkFailure(err);
}
