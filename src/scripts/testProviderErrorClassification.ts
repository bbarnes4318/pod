// Regression proof that a provider failure is named for what it actually IS.
//
// THE FAILURE THIS FIXES. The live canary on SHA 43e4154e reported:
//
//   alertClass: provider_failure
//   anthropic/claude-sonnet-5 [role_override] failed (programming_error):
//     [Anthropic] API request failed with status 400:
//     {"type":"error","error":{"type":"invalid_request_error",
//      "message":"Your credit balance is too low to access the Anthropic API..."}}
//
// Anthropic reports an unfunded account as a 400 `invalid_request_error`, and a
// 400 that names no request field we sent was classified as OUR bad request.
// Two things were wrong with that. The operator was told to go find a bug that
// did not exist, and `programming_error` is TERMINAL — the right behaviour
// (stop, do not spend the rest of the chain) reached for the wrong reason, so
// the next person to widen the fallback rules would have removed it.
//
// The five cases below are the whole point: five different provider responses
// must produce five different answers, because they need five different actions.
//
//   insufficient credit  → billing_failure       fund the account
//   malformed request    → programming_error     fix the code
//   auth rejected        → credential_failure    rotate the key
//   rate limited         → rate_limited          wait / route elsewhere
//   provider outage      → provider_failure      check provider status
//
// Everything here runs offline against pure functions. No network, no key.

import assert from "node:assert/strict";
import {
  LlmProviderError,
  categorizeHttpFailure,
  categorizeNetworkFailure,
  categoryOf,
  isBillingCategory,
  isContinueCategory,
  isRetryableCategory,
  isTerminalCategory,
  looksLikeInsufficientCredit,
  operatorAction,
  parseProviderErrorBody,
} from "../lib/providers/llm/errors";
import { fallbackDecision, type FallbackCandidateInfo } from "../lib/providers/llm/fallbackPolicy";
import { classifyProviderError, operatorGuidance, providerLabelFor } from "./runLiveProviderCanary";
import { SceneGenerationError } from "../lib/providers/tts/sceneTypes";

let failed = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  FAIL ${name}\n       ${(err as Error).message}`);
  }
}

// ---------------------------------------------------------------- the fixtures
//
// Real response bodies, verbatim in shape. The Anthropic one is the body the
// canary actually received.

const BODY_INSUFFICIENT_CREDIT = JSON.stringify({
  type: "error",
  error: {
    type: "invalid_request_error",
    message:
      "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.",
  },
});

const BODY_MALFORMED_REQUEST = JSON.stringify({
  type: "error",
  error: {
    type: "invalid_request_error",
    message: "messages: at least one message is required",
  },
});

const BODY_BAD_TOOL_SCHEMA = JSON.stringify({
  type: "error",
  error: {
    type: "invalid_request_error",
    message: "tools.0.custom.input_schema: JSON schema is invalid — 'properties' must be an object",
  },
});

const BODY_AUTH_REJECTED = JSON.stringify({
  type: "error",
  error: { type: "authentication_error", message: "invalid x-api-key" },
});

const BODY_RATE_LIMITED = JSON.stringify({
  type: "error",
  error: { type: "rate_limit_error", message: "Number of request tokens has exceeded your per-minute rate limit." },
});

const BODY_OUTAGE = JSON.stringify({
  type: "error",
  error: { type: "api_error", message: "Internal server error" },
});

/** The message shape the legacy Anthropic adapter throws. */
function adapterError(status: number, body: string): Error {
  return new Error(`[Anthropic] API request failed with status ${status}: ${body}`);
}

/** The shape the routing layer throws once a chain has stopped. */
function routedError(category: string, body: string): LlmProviderError {
  return new LlmProviderError({
    provider: "routing",
    model: "quality_judge",
    category: "unknown",
    message:
      `[LLMRouting] Role 'quality_judge' STOPPED at 1 candidate(s) under profile 'custom'.\n` +
      `  - anthropic/claude-sonnet-5 [role_override] failed (${category}): ` +
      `[Anthropic] API request failed with status 400: ${body}`,
  });
}

console.log("\nProvider error classification: five responses, five answers\n");

// =============================================================================
console.log("  -- 1. insufficient credit -> billing_failure --");

check("the exact Anthropic credit-balance 400 is insufficient_credit, NOT programming_error", () => {
  const category = categorizeHttpFailure(400, BODY_INSUFFICIENT_CREDIT, ["system", "max_tokens", "temperature"]);
  assert.equal(category, "insufficient_credit", "the historical misclassification must be gone");
  assert.notEqual(category, "programming_error");
});

check("the legacy adapter's thrown Error classifies the same way", () => {
  // This is the path the real canary took: a plain Error from anthropic.ts,
  // parsed by categoryOf().
  assert.equal(categoryOf(adapterError(400, BODY_INSUFFICIENT_CREDIT)), "insufficient_credit");
});

check("it is NOT retryable and NOT terminal", () => {
  assert.equal(isRetryableCategory("insufficient_credit"), false, "retrying an empty account is pure waste");
  assert.equal(isContinueCategory("insufficient_credit"), false, "it must not march to the next candidate blindly");
  assert.equal(isTerminalCategory("insufficient_credit"), false, "a DIFFERENT provider's account is a real fallback");
  assert.equal(isBillingCategory("insufficient_credit"), true);
  assert.equal(new LlmProviderError({ provider: "anthropic", model: "m", category: "insufficient_credit", message: "x" }).retryable, false);
});

check("a 402 Payment Required is insufficient_credit on its own", () => {
  assert.equal(categorizeHttpFailure(402, "", []), "insufficient_credit");
  assert.equal(categorizeHttpFailure(402, "anything at all", []), "insufficient_credit");
});

check("a 403 that names the money is billing, not a credential problem", () => {
  const body = JSON.stringify({ error: { type: "permission_error", message: "Insufficient credits on this account." } });
  assert.equal(categorizeHttpFailure(403, body, []), "insufficient_credit");
});

// These two bodies are VERBATIM from live accounts on 2026-08-05, captured by a
// real smoke call. Both are billing failures delivered as HTTP 429, which the
// first version of this classifier deliberately excluded — so it would have told
// an operator to wait out a "rate limit" that no amount of waiting fixes.
check("Google's 429 'prepayment credits are depleted' is billing, not a rate limit", () => {
  const body = JSON.stringify({
    error: { code: 429, message: "Your prepayment credits are depleted. Please go to AI Studio to manage your project." },
  });
  assert.equal(categorizeHttpFailure(429, body, []), "insufficient_credit");
});

check("Z.ai's 429 'Insufficient balance ... Please recharge' is billing, not a rate limit", () => {
  const body = JSON.stringify({ error: { code: "1113", message: "Insufficient balance or no resource package. Please recharge." } });
  assert.equal(categorizeHttpFailure(429, body, []), "insufficient_credit");
});

check("a 429 with NO funding language is still an ordinary rate limit", () => {
  const body = JSON.stringify({ error: { message: "Rate limit exceeded. Please slow down." } });
  const category = categorizeHttpFailure(429, body, []);
  assert.notEqual(category, "insufficient_credit", "widening 429 must not swallow real rate limits");
  assert.equal(isRetryableCategory(category), true, "a real rate limit is still worth retrying");
});

check("the operator is told to fund the account", () => {
  const action = operatorAction("insufficient_credit");
  assert.ok(action, "insufficient_credit must carry an operator action");
  assert.match(action!, /fund the provider account/i);
  assert.match(action!, /no model change, retry or fallback/i);
});

// =============================================================================
console.log("\n  -- 2. NOT every 400 is a billing failure --");

check("a genuinely malformed request stays programming_error", () => {
  assert.equal(
    categorizeHttpFailure(400, BODY_MALFORMED_REQUEST, ["system", "max_tokens"]),
    "programming_error",
    "a bad request must still say the code is wrong"
  );
  assert.equal(categoryOf(adapterError(400, BODY_MALFORMED_REQUEST)), "programming_error");
});

check("an empty / unparseable 400 body stays programming_error", () => {
  assert.equal(categorizeHttpFailure(400, "", []), "programming_error");
  assert.equal(categorizeHttpFailure(400, "<html>502 Bad Gateway</html>", []), "programming_error");
  assert.equal(categorizeHttpFailure(400, "not json at all", []), "programming_error");
});

check("a bad application schema is still invalid_application_schema", () => {
  assert.equal(
    categorizeHttpFailure(400, BODY_BAD_TOOL_SCHEMA, ["response_format"]),
    "invalid_application_schema",
    "OUR schema being wrong must not be mistaken for a bill"
  );
});

check("a named unsupported parameter is still unsupported_parameter", () => {
  const body = JSON.stringify({ error: { type: "invalid_request_error", message: "temperature: unsupported value" } });
  assert.equal(categorizeHttpFailure(400, body, ["temperature", "max_tokens"]), "unsupported_parameter");
});

check("ECHOED request content cannot manufacture a billing failure", () => {
  // The provider's structured envelope is authoritative. A brief that happens to
  // discuss a team's finances, echoed back inside a 400, must not be read as
  // "this account has no money".
  const body = JSON.stringify({
    type: "error",
    error: {
      type: "invalid_request_error",
      message: "messages.1.content: field required",
      request_echo: "The owner said the club's credit balance is too low to sign anyone this winter.",
    },
  });
  assert.equal(looksLikeInsufficientCredit(body), false, "only the provider's own message field may decide this");
  assert.equal(categorizeHttpFailure(400, body, []), "programming_error");
});

check("the structured parser extracts type + message and nothing else", () => {
  const shape = parseProviderErrorBody(BODY_INSUFFICIENT_CREDIT);
  assert.equal(shape.structured, true);
  assert.equal(shape.type, "invalid_request_error");
  assert.match(String(shape.message), /credit balance is too low/);
  // Bounded: an error body that echoes a whole script must not travel into logs.
  const huge = JSON.stringify({ error: { type: "invalid_request_error", message: "x".repeat(5000) } });
  assert.ok(String(parseProviderErrorBody(huge).message).length <= 300, "the message must be bounded");
});

check("a non-envelope body reports structured:false rather than guessing", () => {
  for (const body of ["", "plain text", "[1,2,3]", "{not json", "{}"]) {
    const shape = parseProviderErrorBody(body);
    assert.equal(shape.structured, false, `"${body}" must not claim to be structured`);
    assert.equal(shape.type, null);
    assert.equal(shape.message, null);
  }
});

// =============================================================================
console.log("\n  -- 3. authentication rejection -> credential_failure --");

check("a 401 is authentication_failed, and the canary calls it credential_failure", () => {
  assert.equal(categorizeHttpFailure(401, BODY_AUTH_REJECTED, []), "authentication_failed");
  assert.equal(categoryOf(adapterError(401, BODY_AUTH_REJECTED)), "authentication_failed");
  const err = new LlmProviderError({ provider: "anthropic", model: "claude-sonnet-5", category: "authentication_failed", message: "401" });
  assert.equal(classifyProviderError(err), "credential_failure");
});

check("a plain 403 with no money language is still a credential problem", () => {
  assert.equal(categorizeHttpFailure(403, BODY_AUTH_REJECTED, []), "authentication_failed");
});

check("a rejected key is NOT reported as a billing failure", () => {
  const err = new LlmProviderError({ provider: "anthropic", model: "m", category: "authentication_failed", message: "401" });
  assert.notEqual(classifyProviderError(err), "billing_failure", "rotating a key and paying a bill are different jobs");
});

// =============================================================================
console.log("\n  -- 4. rate limit -> rate_limited (unchanged) --");

check("a 429 rate limit is rate_limited", () => {
  assert.equal(categorizeHttpFailure(429, BODY_RATE_LIMITED, []), "rate_limited");
  assert.equal(isRetryableCategory("rate_limited"), true, "a rate limit clears on its own");
});

check("a 429 quota exhaustion is still quota_exhausted, not billing", () => {
  // Deliberately unchanged by this fix: a spent free-tier allowance is a
  // different thing from an unfunded paid account, and it already had a
  // category that routes correctly.
  const body = JSON.stringify({ error: { type: "rate_limit_error", message: "You exceeded your current quota." } });
  assert.equal(categorizeHttpFailure(429, body, []), "quota_exhausted");
});

check("a rate limit is not classified as a billing failure", () => {
  const err = new LlmProviderError({ provider: "anthropic", model: "m", category: "rate_limited", message: "429" });
  assert.equal(classifyProviderError(err), "provider_failure", "a rate limit is the provider's side, not ours");
});

// =============================================================================
console.log("\n  -- 5. provider outage -> provider_failure --");

check("5xx maps to recoverable provider-side categories", () => {
  assert.equal(categorizeHttpFailure(500, BODY_OUTAGE, []), "provider_internal_error");
  assert.equal(categorizeHttpFailure(502, "", []), "temporary_unavailable");
  assert.equal(categorizeHttpFailure(503, "capacity", []), "model_temporarily_unavailable");
  assert.equal(categorizeHttpFailure(504, "", []), "temporary_unavailable");
});

check("the canary calls an outage provider_failure", () => {
  const err = new LlmProviderError({ provider: "anthropic", model: "m", category: "provider_internal_error", message: "500" });
  assert.equal(classifyProviderError(err), "provider_failure");
  assert.equal(classifyProviderError(new Error("socket hang up")), "provider_failure");
});

// =============================================================================
console.log("\n  -- 5b. an instant, silent rejection is not an unclassifiable one --");
//
// deepseek-v4-pro, worker log 2026-08-10: every call failed in 14-27ms with an
// empty body and zero successful completions. 14-27ms cannot contain inference,
// so the endpoint was refusing outright — but the taxonomy had no case for it,
// so it landed as `unknown` and read as "our error table needs a new rule" when
// the truth was "this model is not serving this account". It stayed in the
// default chains for weeks, taxing every failover with a guaranteed-losing hop.

check("a sub-50ms failure with an empty body is named, not filed under unknown", () => {
  assert.equal(categorizeHttpFailure(0, "", [], 14), "endpoint_rejected_fast");
  assert.equal(categorizeHttpFailure(418, "", [], 27), "endpoint_rejected_fast");
  assert.equal(categorizeNetworkFailure(new Error("boom"), 27), "endpoint_rejected_fast");
});

check("it does not weaken the existing ambiguous-400 rule", () => {
  // A 400 with an empty body was ALREADY classified — as programming_error, on
  // the deliberate reasoning that an ambiguous 400 is our own bad request and
  // must be terminal rather than something to shrug at. Timing does not get to
  // overturn that: the fast-rejection rule only ever applies where the answer
  // would otherwise have been `unknown`.
  assert.equal(categorizeHttpFailure(400, "", [], 5), "programming_error");
  assert.equal(isTerminalCategory("programming_error"), true);
});

check("it is NOT retried against the same endpoint", () => {
  // The whole point: an endpoint that refused in 20ms will refuse again in 20ms.
  assert.equal(isRetryableCategory("endpoint_rejected_fast"), false, "retrying an instant rejection is pure waste");
  assert.equal(
    new LlmProviderError({ provider: "nvidia", model: "m", category: "endpoint_rejected_fast", message: "x" }).retryable,
    false
  );
});

check("it DOES advance to the next candidate", () => {
  // Not terminal: another model is exactly what should run. This preserves the
  // verdict `unknown` already got from the fallback policy's default branch —
  // the change is that the reason now names the failure instead of shrugging.
  assert.equal(isContinueCategory("endpoint_rejected_fast"), true);
  assert.equal(isTerminalCategory("endpoint_rejected_fast"), false, "one bad endpoint must not stop the chain");
});

check("it never overrides a classification that was actually made", () => {
  // Timing is a LAST resort. A real 429 that happens to return in 10ms is still
  // a rate limit, and a 401 is still an auth failure.
  assert.equal(categorizeHttpFailure(429, BODY_RATE_LIMITED, [], 5), "rate_limited");
  assert.equal(categorizeHttpFailure(401, BODY_AUTH_REJECTED, [], 5), "authentication_failed");
  assert.equal(categorizeHttpFailure(500, BODY_OUTAGE, [], 5), "provider_internal_error");
});

check("a fast failure that explained itself is not this case", () => {
  // Both conditions are required. A body means the provider told us something,
  // and the right response is a new rule above — not this fallback.
  assert.equal(categorizeHttpFailure(418, "teapot", [], 5), "unknown");
});

check("a slow unclassifiable failure stays unknown", () => {
  // Guards against the threshold swallowing the genuine unknown case.
  assert.equal(categorizeHttpFailure(418, "", [], 5000), "unknown");
  assert.equal(categorizeHttpFailure(418, "", []), "unknown", "no timing supplied = no timing claim");
  assert.equal(categorizeNetworkFailure(new Error("boom")), "unknown");
});

check("the operator is told what to DO about it", () => {
  const action = operatorAction("endpoint_rejected_fast");
  assert.ok(action, "a category with a known remedy must not return null");
  assert.match(action!, /broken-in-production/, "the remedy is a capability-record change, and must say so");
});

// =============================================================================
console.log("\n  -- 5c. a RETIRED model is not a transient failure --");
//
// Observed live 2026-08-12 on a real render: NVIDIA returned 410 Gone for
// mistral-medium-3.5, retired 2026-08-07. The taxonomy had no 410 case, so it
// classified as `unknown` and the router treated a permanent retirement as a
// maybe-transient blip — the same shape as deepseek-v4-pro, different cause.

const BODY_MODEL_RETIRED = JSON.stringify({
  type: "about:blank",
  title: "Gone",
  status: 410,
  detail:
    "The model 'mistralai/mistral-medium-3.5-128b' has reached its end of life on 2026-08-07T09:00:00Z and is no longer available.",
});

check("410 Gone is an invalid model, not unknown", () => {
  assert.equal(categorizeHttpFailure(410, BODY_MODEL_RETIRED, []), "invalid_model");
  // Body-independent: a bare 410 is still a retired endpoint.
  assert.equal(categorizeHttpFailure(410, "", []), "invalid_model");
});

check("a retired model is never retried against the same endpoint", () => {
  // Retrying an end-of-life model is guaranteed waste — it will not come back.
  assert.equal(isRetryableCategory("invalid_model"), false);
});

check("a retired model does not stop the chain", () => {
  // It is a configuration failure, not a terminal one: another model is exactly
  // what should run, and the misconfiguration is still reported.
  assert.equal(isTerminalCategory("invalid_model"), false);
});

check("the operator is told to change the route", () => {
  const action = operatorAction("invalid_model");
  assert.ok(action, "invalid_model must carry an operator action");
  assert.match(action!, /model id is not served/i);
});

// =============================================================================
console.log("\n  -- the fallback chain does not burn the same account --");

const anthropicOpus: FallbackCandidateInfo = { provider: "anthropic", model: "claude-opus-5", paid: true, source: "role_override" };
const anthropicSonnet: FallbackCandidateInfo = { provider: "anthropic", model: "claude-sonnet-5", paid: true, source: "profile" };
const nvidia: FallbackCandidateInfo = { provider: "nvidia", model: "some-free-model", paid: false, source: "profile" };
const allowExplicit = { paidFallbackAllowed: true, paidFallbackExplicit: true };

const creditErr = new LlmProviderError({
  provider: "anthropic",
  model: "claude-opus-5",
  category: "insufficient_credit",
  message: "credit balance is too low",
});

check("a billing failure SKIPS the next model on the same provider", () => {
  const d = fallbackDecision(creditErr, anthropicOpus, anthropicSonnet, allowExplicit);
  assert.equal(d.verdict, "skip_provider", "another Anthropic model bills the same empty account");
  assert.notEqual(d.verdict, "continue", "marching through the chain is exactly what must not happen");
  assert.equal(d.category, "insufficient_credit");
  assert.match(d.reason, /same account/i);
  assert.match(d.reason, /fund the account/i);
});

check("even with paid fallback EXPLICITLY allowed, it will not burn the same account", () => {
  // The strongest form of the bug: an operator who set LLM_ALLOW_LEGACY_FALLBACK
  // deliberately must still not get four failed calls against an empty account.
  const d = fallbackDecision(creditErr, anthropicOpus, anthropicSonnet, allowExplicit);
  assert.notEqual(d.verdict, "continue");
});

check("a DIFFERENT provider is still a legitimate fallback", () => {
  const d = fallbackDecision(creditErr, anthropicOpus, nvidia, allowExplicit);
  assert.equal(d.verdict, "skip_provider", "skip_provider skips the shared account, then the router carries on");
});

check("with nothing left, it stops and says why", () => {
  const d = fallbackDecision(creditErr, anthropicOpus, undefined, allowExplicit);
  assert.equal(d.verdict, "stop");
  assert.equal(d.category, "insufficient_credit");
  assert.match(d.reason, /no funds/i);
});

check("a billing failure is never described as UNCLASSIFIED", () => {
  // Before the billing group existed, insufficient_credit would have fallen
  // through to the catch-all branch and told the reader the taxonomy was broken.
  const d = fallbackDecision(creditErr, anthropicOpus, nvidia, allowExplicit);
  assert.doesNotMatch(d.reason, /UNCLASSIFIED/);
});

// =============================================================================
console.log("\n  -- operator-facing reporting --");

check("the canary reports the routed chain error as billing_failure", () => {
  // The real canary error: the chain wrapper's own category is "unknown" and
  // only the aggregated message names insufficient_credit.
  const err = routedError("insufficient_credit", BODY_INSUFFICIENT_CREDIT);
  assert.equal(classifyProviderError(err), "billing_failure");
  assert.notEqual(classifyProviderError(err), "provider_failure", "this is what the failing run said");
});

check("the operator sees 'Anthropic account requires credit', not 'programming error'", () => {
  const err = routedError("insufficient_credit", BODY_INSUFFICIENT_CREDIT);
  const guidance = operatorGuidance(classifyProviderError(err), err);
  assert.ok(guidance, "a billing failure must carry guidance");
  assert.match(guidance!, /Anthropic account requires credit/i);
  assert.match(guidance!, /add funds/i);
  assert.doesNotMatch(guidance!, /programming/i);
});

check("the provider is named from the error, not hardcoded", () => {
  assert.equal(providerLabelFor(routedError("insufficient_credit", BODY_INSUFFICIENT_CREDIT)), "Anthropic");
  assert.equal(providerLabelFor(new SceneGenerationError("insufficient_credit", "fish 402")), "Fish Audio");
  assert.equal(providerLabelFor(new Error("nothing recognizable")), "The provider");
  assert.match(String(operatorGuidance("billing_failure", new SceneGenerationError("insufficient_credit", "fish 402"))), /Fish Audio account requires credit/i);
});

check("a scene render that runs out of credit is billing, not configuration", () => {
  assert.equal(classifyProviderError(new SceneGenerationError("insufficient_credit", "402")), "billing_failure");
  assert.equal(classifyProviderError(new SceneGenerationError("authentication", "401")), "credential_failure");
  assert.equal(classifyProviderError(new SceneGenerationError("invalid_voice", "no such voice")), "configuration_failure");
  assert.equal(classifyProviderError(new SceneGenerationError("provider_unavailable", "503")), "provider_failure");
});

check("guidance never leaks a credential", () => {
  const secret = "sk-ant-not-a-real-key-000000000000";
  const err = new LlmProviderError({
    provider: "anthropic",
    model: "claude-sonnet-5",
    category: "insufficient_credit",
    message: `failed with x-api-key: ${secret}`,
  });
  const guidance = String(operatorGuidance("billing_failure", err));
  assert.ok(!guidance.includes(secret), "the operator instruction must not carry a key");
});

if (failed) {
  console.error(`\n${failed} check(s) FAILED.\n`);
  process.exit(1);
}
console.log("\nAll provider error classification checks passed.\n");
