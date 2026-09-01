// Typed model capability registry.
//
// TWO INDEPENDENT KINDS OF VERIFICATION, because one flag conflated two very
// different claims and made both useless:
//
//   catalogVerified       the model ID and its documented availability were
//                         confirmed from the official provider catalog. Says
//                         nothing about which request fields it accepts.
//   liveContractVerified  this repository successfully called the model with
//                         the current key and the current request adapter, and
//                         the probe recorded which fields it accepted.
//
// A model can be catalog-verified and still have entirely unverified request
// parameters — which is the state of every NVIDIA model here. That is exactly
// why the two flags exist.
//
// RULES THIS FILE ENFORCES
//
//   1. Output limits are enforceable ONLY when live-verified. A number copied
//      off a model card lives in `documentedMaximumOutputTokens`, which is
//      informational and can never shrink a caller's request. `maximumOutputTokens`
//      is set only by a probe.
//   2. Structured-output support is three separate questions, not one, and each
//      is answered per model (see supportsNativeJsonObject / NativeJsonSchema /
//      PromptEnforcedJson). Prompt-enforced JSON plus the strict parser is the
//      default for anything unconfirmed — it is the path the Anthropic provider
//      has always used successfully, so it is safe as well as honest.
//   3. Reasoning controls are per MODEL, not per provider: DeepSeek, Nemotron
//      and Mistral each take a different field. See nvidiaRequestProfiles.ts.
//   4. `provenance` records where each claim came from, so nobody has to guess
//      later which numbers were measured and which were read.
//
// Updating a record from a probe is a HUMAN action: `npm run probe:llm-contract`
// prints the recommended diff; it never edits this file.

export type RequestParameterProfile =
  // NVIDIA NIM, per model — the field names genuinely differ.
  | "deepseek-v4"
  | "nemotron-3-ultra"
  | "glm-5-2"
  | "mistral-medium-3-5"
  | "kimi-k2-6"
  | "generic-nim"
  // Other providers.
  | "zai-glm"
  | "anthropic-messages"
  | "openai-chat"
  | "openai-reasoning"
  | "xai-grok"
  | "moonshot-kimi"
  | "google-gemini"
  | "stub";

export interface ModelCapabilities {
  provider: string;
  model: string;

  /** Model ID + documented availability confirmed from the official catalog. */
  catalogVerified: boolean;
  /** Successfully called from this repo with the current key and adapter. */
  liveContractVerified: boolean;

  /**
   * Can the DEFAULT profile chains use this model right now?
   *
   *   available              reachable; routable by default.
   *   capacity-limited       the endpoint exists but would not serve us (503
   *                          ResourceExhausted). Not a capability fault.
   *   unavailable-for-account the id does not resolve for the key in use (404).
   *
   * Anything other than `available` is FILTERED OUT of every profile chain, so a
   * production-chain run does not burn a slow attempt failing its way down to a
   * usable model. Integration support is untouched: an explicit role override
   * still reaches the model, which is how it gets retested. It returns to the
   * default profiles only when a live contract probe passes.
   */
  availability:
    | "available"
    | "capacity-limited"
    | "unavailable-for-account"
    | "broken-in-production"
    /** The provider has END-OF-LIFED it. Permanent — no probe will bring it back. */
    | "retired";

  /**
   * Has a role-quality experiment produced evidence for this model in this
   * application? Live contract acceptance is NOT quality evidence — a model that
   * returns HTTP 200 can still write dialogue nobody wants to hear.
   */
  qualityTested: boolean;

  /** ENFORCEABLE limits. Set only by a live probe — never from a model card. */
  contextWindow?: number;
  maximumOutputTokens?: number;
  /** Informational only. Never used to shrink a caller's request. */
  documentedContextWindow?: number;
  documentedMaximumOutputTokens?: number;

  /** response_format: { type: "json_object" }. */
  supportsNativeJsonObject: boolean;
  /** response_format: { type: "json_schema", ... }. */
  supportsNativeJsonSchema: boolean;
  /** Reliably returns JSON when the prompt demands it (with strict parsing). */
  supportsPromptEnforcedJson: boolean;

  /** Has a thinking/reasoning mode that can be switched on. */
  supportsThinking: boolean;
  /** Takes a qualitative effort level (e.g. reasoning_effort: "high"). */
  supportsReasoningEffort: boolean;
  /** Takes a quantitative thinking-token budget (e.g. reasoning_budget: 8192). */
  supportsReasoningBudget: boolean;
  /** Inclusive [min, max] for the budget, when documented. */
  reasoningBudgetRange?: [number, number];

  supportsSeed: boolean;
  supportsSystemPrompt: boolean;
  supportsStreaming: boolean;

  requestParameterProfile: RequestParameterProfile;

  /** Sampling params are rejected outright (Anthropic frontier models). */
  rejectsSampling?: boolean;
  /** Free/unpriced endpoint — cost must be reported as null, never estimated. */
  unpriced: boolean;

  /** Where each claim above came from. Read this before trusting a field. */
  provenance: {
    catalog: string;
    requestFields: string;
    limits: string;
  };
}

/**
 * The states readiness must distinguish. Deliberately five, not three: "the
 * endpoint answered" and "this model is any good at its job" are different
 * questions, and so are "the catalog lists it" and "this account can reach it".
 */
export type VerificationState =
  | "catalog-available"
  | "live-contract-passed"
  | "live-contract-failed"
  | "unavailable-for-account"
  | "not-quality-tested"
  | "broken-in-production"
  | "retired";

export function verificationState(caps: ModelCapabilities): VerificationState {
  // Checked FIRST because it is the only permanent one. A retired model is not
  // coming back, so it must never be reported as something a probe could clear.
  if (caps.availability === "retired") return "retired";
  if (caps.availability === "unavailable-for-account") return "unavailable-for-account";
  // Kept SEPARATE from live-contract-failed on purpose. Both are non-routable,
  // but they are different claims and the operator acts on them differently: a
  // capacity failure is the provider saying "not now" and clears itself, while
  // this one is "the probe and production disagree", which needs a human. They
  // were merged once and the chain-filter told operators a 503 had happened
  // when no 503 ever did.
  if (caps.availability === "broken-in-production") return "broken-in-production";
  if (caps.availability === "capacity-limited") return "live-contract-failed";
  if (caps.liveContractVerified) {
    // The endpoint works. Whether the MODEL works for its role is a separate
    // claim, and until an experiment says so, this is the honest state.
    return caps.qualityTested ? "live-contract-passed" : "not-quality-tested";
  }
  if (caps.catalogVerified) return "catalog-available";
  return "unavailable-for-account";
}

export function describeVerificationState(state: VerificationState): string {
  switch (state) {
    case "catalog-available":
      return "Catalog available — the ID is confirmed in the provider catalog, but no live request has been made from this repository.";
    case "live-contract-passed":
      return "Live contract passed AND role-quality tested — called successfully, and an experiment has produced quality evidence.";
    case "not-quality-tested":
      return "Live contract passed, NOT yet quality-tested — the endpoint and its request fields work; nothing has measured whether the model is good at this role.";
    case "live-contract-failed":
      return "Live contract FAILED — the endpoint exists but would not serve this account (capacity). Removed from the default profile chains until a probe passes.";
    case "unavailable-for-account":
      return "Unavailable for the current account — the ID does not resolve for the key in use. Removed from the default profile chains; reachable only via an explicit role override.";
    case "broken-in-production":
      return "BROKEN IN PRODUCTION — a contract probe passed, but real pipeline traffic failed on every attempt. The probe result is retained and is not the current truth. Removed from the default profile chains; reachable only via an explicit role override, which is how it gets retested.";
    case "retired":
      return "RETIRED by the provider — the model reached end of life and returns 410 Gone. This is PERMANENT: unlike every other non-routable state, no probe and no credential change will restore it. Removed from every chain; the record is kept so the id is recognised rather than looking like a typo.";
  }
}

/** Short label for tables. */
export function shortVerificationLabel(state: VerificationState): string {
  switch (state) {
    case "catalog-available":
      return "catalog-only";
    case "live-contract-passed":
      return "live+quality";
    case "not-quality-tested":
      return "live, untested";
    case "live-contract-failed":
      return "LIVE FAILED";
    case "unavailable-for-account":
      return "UNAVAILABLE";
    case "broken-in-production":
      return "PROD BROKEN";
    case "retired":
      return "RETIRED";
  }
}

/** May the default profile chains route to this model? */
export function isRoutableByDefault(caps: ModelCapabilities): boolean {
  return caps.availability === "available";
}

/**
 * Canonical model ids used by the routing profiles. Every one is env-overridable
 * so a catalog rename is a one-variable fix rather than a code change.
 */
export const MODEL_IDS = {
  nvidia: {
    deepseekFlash: "deepseek-ai/deepseek-v4-flash",
    deepseekPro: "deepseek-ai/deepseek-v4-pro",
    glm: "z-ai/glm-5.2",
    nemotron: "nvidia/nemotron-3-ultra-550b-a55b",
    mistral: "mistralai/mistral-medium-3.5-128b",
    kimi: "moonshotai/kimi-k2.6",
  },
  zai: {
    glmFlash: "glm-4.7-flash",
  },
  // Added for the role bake-off. Every id below is a DEFAULT, overridable by
  // XAI_MODEL / MOONSHOT_MODEL / GOOGLE_MODEL. The Google id in particular has
  // not been confirmed against a live account — see google.ts.
  xai: {
    grok43: "grok-4.3",
    grok45: "grok-4.5",
  },
  moonshot: {
    kimiK3: "kimi-k3",
    kimiK26: "kimi-k2.6",
  },
  // CONFIRMED against the live catalog on 2026-08-05. There is no bare
  // `gemini-3.1-pro` — the Pro line is preview-suffixed, which is exactly the
  // kind of guess that would have failed on the first paid call.
  //
  // BEING IN THE CATALOG IS NOT BEING REACHABLE. On the free tier every Gemini
  // PRO route answers 429 RESOURCE_EXHAUSTED with `limit: 0` — a hard zero
  // rather than exhausted quota, so it never clears with time and no retry
  // helps. `geminiPro` is kept because a funded account can use it, but it is
  // no longer what an unconfigured install falls back to; see google.ts.
  google: {
    geminiPro: "gemini-3.1-pro-preview",
    geminiFlash: "gemini-3.6-flash",
    // The one id confirmed end-to-end through a real GoogleLLMProvider
    // completion — not merely a /models listing — on 2026-08-31.
    geminiFlashLite: "gemini-3.1-flash-lite-preview",
  },
} as const;

// ---------------------------------------------------------------------------
// Provenance strings, written once so every record cites the same sources.
// ---------------------------------------------------------------------------

const CATALOG_NVIDIA = "Confirmed present in NVIDIA's official model catalog (build.nvidia.com).";
const LIMITS_UNPROBED =
  "No enforceable limit recorded. Any documented figure here is informational; run `npm run probe:llm-contract` to establish a live-verified limit. An unknown limit never shrinks a caller's request.";

const NVIDIA_STRUCTURED_UNCONFIRMED =
  "Native response_format support is NOT confirmed for this model on the hosted endpoint, so it is declared false and the request omits response_format entirely. JSON is enforced through the prompt and validated by the strict parser (the same mechanism the Anthropic provider has always used). A probe may upgrade this.";

/**
 * The live contract probe run whose observations set the `liveContractVerified`
 * records below. Named so a future reader knows which run to re-do rather than
 * trusting a stale flag.
 *
 * `npm run probe:llm-contract`, 2026-07-26, integrate.api.nvidia.com/v1 and
 * api.z.ai/api/paas/v4. Full observations in artifacts/*-contract-report.json.
 *
 * IMPORTANT on how to read a 200: NVIDIA NIM validates request parameters
 * STRICTLY — it hard-400s `reasoning_budget` on DeepSeek/GLM and top-level
 * `thinking` on Nemotron — so an accepted parameter there is real evidence.
 * Z.ai does NOT appear to validate: it returned 200 for `chat_template_kwargs`,
 * a field that only exists in NVIDIA's NIM transport and that Z.ai has no reason
 * to implement. On a lenient endpoint a 200 cannot distinguish "honored" from
 * "silently ignored", so Z.ai's flags were NOT upgraded from acceptance alone.
 */
/**
 * The probe date, as DATA rather than as prose inside a sentence.
 *
 * `npm run routing:staleness` reads this to answer "how old is the evidence
 * these routing assignments rest on?". Before it was extractable, the only
 * record of the date was the paragraph above and a filename nobody re-checked —
 * so the assignments could age indefinitely without anything saying so.
 * Re-running the probe means updating this constant in the same commit.
 */
export const LLM_CONTRACT_PROBE_DATE = "2026-07-26";

const PROBE_RUN = `live probe ${LLM_CONTRACT_PROBE_DATE}`;

// ---------------------------------------------------------------------------

function nvidiaBase(model: string, profile: RequestParameterProfile): ModelCapabilities {
  return {
    provider: "nvidia",
    model,
    catalogVerified: true,
    liveContractVerified: false,
    availability: "available",
    qualityTested: false,
    supportsNativeJsonObject: false,
    supportsNativeJsonSchema: false,
    supportsPromptEnforcedJson: true,
    supportsThinking: false,
    supportsReasoningEffort: false,
    supportsReasoningBudget: false,
    supportsSeed: false,
    supportsSystemPrompt: true,
    supportsStreaming: true,
    requestParameterProfile: profile,
    unpriced: true,
    provenance: {
      catalog: CATALOG_NVIDIA,
      requestFields: NVIDIA_STRUCTURED_UNCONFIRMED,
      limits: LIMITS_UNPROBED,
    },
  };
}

const REGISTRY: ModelCapabilities[] = [
  // ---------------- DeepSeek V4 (flash + pro) ----------------
  // NVIDIA's own example enables reasoning through the chat template and puts
  // the effort level INSIDE it:
  //   extra_body={"chat_template_kwargs":{"thinking":true,"reasoning_effort":"high"}}
  // The previous registry declared Flash incapable of thinking. That was wrong:
  // both Flash and Pro are reasoning models and take the same shape.
  {
    // NOT live-verified: every probe in the 2026-07-26 run got
    // `503 ResourceExhausted: Worker local total request limit reached (48/48)`
    // on the very first plain request. That is free-tier CAPACITY, not a
    // capability answer, so no request-field flag was changed from it — the
    // documented shape stands and the model stays catalog-verified.
    //
    // Operationally significant: this model is the primary for topic
    // generation, topic classification, show notes and the continuity report,
    // so those roles should expect to fall through to their next candidate
    // under load.
    ...nvidiaBase(MODEL_IDS.nvidia.deepseekFlash, "deepseek-v4"),
    // FILTERED OUT of the default profile chains: every probe request got a 503.
    // Reachable through an explicit role override for retesting, and it returns
    // to the defaults when a live contract probe passes.
    availability: "capacity-limited",
    supportsThinking: true,
    supportsReasoningEffort: true,
    provenance: {
      catalog: CATALOG_NVIDIA,
      requestFields:
        "Reasoning enabled via chat_template_kwargs.thinking, with reasoning_effort INSIDE chat_template_kwargs, per NVIDIA's " +
        "documented example. UNVERIFIED: the " + PROBE_RUN + " could not reach this model (503 ResourceExhausted, worker limit " +
        "48/48) so nothing was observed. Its sibling deepseek-v4-pro — same profile — verified cleanly, which is suggestive but " +
        "not proof. " + NVIDIA_STRUCTURED_UNCONFIRMED,
      limits: LIMITS_UNPROBED,
    },
  },
  {
    // LIVE VERIFIED BY PROBE, AND BROKEN IN PRODUCTION.
    //
    // The probe below is accurate and is left intact: this model answered a
    // contract probe cleanly. Production disagrees, and production wins.
    //
    // Observed on the worker 2026-08-10, every occurrence in the log, no
    // exceptions: `FAILED=unknown` in 14-27ms, which is far too fast to be
    // inference — the request is being rejected outright. Zero successful
    // completions. Because the failure lands as UNCLASSIFIED, the router cannot
    // tell "this model is broken" from "try again", so it stayed in the chain
    // and taxed every failover with an extra hop:
    //
    //   [LLMRouting] role=research_brief UNCLASSIFIED failure on
    //     nvidia/deepseek-ai/deepseek-v4-pro; advancing to zai/glm-4.7-flash.
    //     An unclassified category means the error taxonomy in errors.ts needs
    //     a case for this response.
    //
    // Marked `broken-in-production`, which is non-routable and filters it out of
    // the default chains, reversible the moment a live contract probe passes
    // again. It stays reachable through an explicit role override for retesting.
    //
    // It was first marked `capacity-limited` — borrowed from its sibling
    // deepseek-v4-flash, which really was 503-throttled. That was the wrong
    // label and it lied downstream: the chain filter renders capacity-limited as
    // "the endpoint would not serve this account (503 capacity)", and no 503 was
    // ever observed here. A 14-27ms rejection is not congestion. The distinct
    // state exists so the filter can say what actually happened.
    //
    // A capability record that says "verified" because a probe once passed is
    // the same shape as every other stale guarantee in this codebase: it
    // describes a moment, not the present.
    ...nvidiaBase(MODEL_IDS.nvidia.deepseekPro, "deepseek-v4"),
    liveContractVerified: true,
    availability: "broken-in-production",
    qualityTested: false,
    supportsThinking: true,
    supportsReasoningEffort: true,
    // Observed, so now declared. The request path uses these.
    supportsNativeJsonObject: true,
    supportsNativeJsonSchema: true,
    supportsSeed: true,
    provenance: {
      catalog:
        CATALOG_NVIDIA +
        " PRODUCTION OBSERVATION 2026-08-10 (worker log, take-machine-worker): every call to this model failed " +
        "`FAILED=unknown` in 14-27ms with zero successful completions across the whole log. 14-27ms is a rejection, not " +
        "inference — nothing generated a token. The router classified it UNCLASSIFIED, so it was retried as if transient " +
        "and taxed every failover with a guaranteed-losing hop. availability is `broken-in-production` on the strength of " +
        "that observation, NOT of the contract probe below, which passed and is retained as an accurate record of " +
        "2026-07-26 and of nothing since. Clear it by re-running `npm run probe:llm-contract -- --model " +
        "deepseek-ai/deepseek-v4-pro` and seeing it pass against live traffic.",
      requestFields:
        PROBE_RUN + ": chat_template_kwargs.thinking accepted; reasoning_effort accepted BOTH nested and top-level (we send the " +
        "documented nested form); `reasoning_budget` REJECTED (400 Unsupported parameter) — that is Nemotron's field, and the " +
        "per-model split is confirmed correct. response_format json_object AND json_schema both accepted and honored (returned " +
        '{"ok":true}). seed accepted. Reasoning comes back SEPARATELY in message.reasoning_content (message keys: ' +
        "content, role, reasoning_content) and the answer text was clean — the reasoning/answer split works as designed.",
      limits:
        "max_tokens 16000 was ACCEPTED (a one-sentence answer was requested; only the allowance was tested). That is not a " +
        "measured ceiling, so maximumOutputTokens stays undefined and no caller request is ever shrunk. " + LIMITS_UNPROBED,
    },
  },

  // ---------------- Nemotron 3 Ultra ----------------
  // NVIDIA's example uses a DIFFERENT thinking key and a TOP-LEVEL budget:
  //   extra_body={"chat_template_kwargs":{"enable_thinking":true},"reasoning_budget":16384}
  // `thinking: true` is NOT sent to Nemotron — it is DeepSeek's alias, and
  // nothing proves Nemotron accepts it. Note also that other Nemotron variants
  // use different controls again (self-hosted NIM docs show max_thinking_tokens
  // and env-var switches for Nano/Super), which is why this record is keyed to
  // this exact model rather than to "nemotron".
  {
    // LIVE VERIFIED. The probe also settled the thing this record exists to get
    // right: top-level `thinking` is REJECTED here (400) while
    // chat_template_kwargs.enable_thinking and reasoning_budget are accepted.
    // Sending DeepSeek's alias to Nemotron would have been a hard failure.
    ...nvidiaBase(MODEL_IDS.nvidia.nemotron, "nemotron-3-ultra"),
    liveContractVerified: true,
    availability: "available",
    qualityTested: false,
    supportsThinking: true,
    // WAS true FROM A PROBE THAT IS NO LONGER TRUE. The hosted runner changed
    // under us; every structured Nemotron call in production now logs:
    //
    //   400 "ValueError: thinking_token_budget is not yet supported by the V2
    //   model runner. Run vLLM with VLLM_USE_V2_MODEL_RUNNER=0 to use
    //   thinking_token_budget."
    //
    // The adapter already recovers — it drops the field and re-sends once —
    // and that recovery is precisely what hid this. Nemotron is the PRIMARY for
    // research_brief, script_outline, script_story_editor,
    // script_debate_architect, script_verification, fact_check and
    // quality_judge, so a silent extra round trip on every one of those calls
    // was being paid on every stage of every episode, against a provider that
    // was simultaneously 503-ing and hitting 240s timeouts. The log line said
    // "The capability registry in capabilities.ts should be corrected" on every
    // occurrence. This is that correction.
    //
    // reasoningBudgetRange is dropped with it: a range for a field that is not
    // sent is a claim about a contract we no longer have. supportsThinking
    // stays true — chat_template_kwargs.enable_thinking is still accepted and
    // is what actually turns reasoning on; only the quantitative budget went.
    supportsReasoningBudget: false,
    documentedContextWindow: 1_000_000,
    supportsReasoningEffort: true,
    // BOTH JSON FLAGS FORCED FALSE — 2026-08-12, PRODUCTION OUTAGE.
    //
    // NVIDIA changed structured-output validation for this model provider-side.
    // Every structured call now returns:
    //
    //   400 ValidationError: 1 validation error for StructuredOutputsParams
    //   Value error, You must use one kind of structured outputs constraint but
    //   none are specified: {'json': None, 'regex': None, 'choice': None,
    //   'grammar': None, 'json_object': None, ...}
    //
    // 24 occurrences on the live worker inside one hour. Nemotron fronts 13
    // roles including script_story_editor — the FIRST role in the seven-role
    // pipeline — and the failure classifies as `programming_error`, which is
    // TERMINAL, so the chain never advanced to GLM-5.2 or Z.ai. Every episode
    // died on its first call.
    //
    // NOT caused by the deploy that was live when it appeared: this flag is
    // byte-identical on 1f1f843 and 929ee3f, and the same code path succeeded
    // six hours earlier. Reverting would have failed identically.
    //
    // Both flags, not just the object one: structuredOutputMode() checks
    // supportsNativeJsonSchema FIRST, so leaving it true would keep every
    // schema-bearing call on the broken path.
    //
    // Prompt-enforced JSON is the fallback, and it is not a downgrade to
    // something unproven — it is the path zai/glm-4.7-flash and xai/grok-4.3
    // already run on successfully every day. Restore these to true only when a
    // structured-output probe passes again; `npm run probe:llm-structured` is
    // the thing that would have caught this before production did.
    supportsNativeJsonObject: false,
    supportsNativeJsonSchema: false,
    supportsSeed: true,
    provenance: {
      catalog: CATALOG_NVIDIA,
      requestFields:
        "STRUCTURED OUTPUT BROKEN PROVIDER-SIDE 2026-08-12: response_format json_object AND json_schema both now return " +
        "400 `StructuredOutputsParams ... none are specified`. Model-specific — z-ai/glm-5.2 on the SAME native-json-object " +
        "mode still works, so this is not an account or transport problem. Native JSON flags forced false; the model is " +
        "otherwise healthy and still serves prompt-enforced JSON. Everything below describes the 2026-07-26 probe and was " +
        "accurate then. " +
        PROBE_RUN + ": chat_template_kwargs.enable_thinking accepted (true and false); top-level `thinking` REJECTED with " +
        "400 `Unsupported parameter(s): thinking` — DeepSeek's alias is genuinely wrong for this model and is never sent. " +
        "Top-level reasoning_budget accepted. reasoning_effort accepted, though we drive depth with the budget (its documented " +
        "control) rather than both. response_format json_object AND json_schema accepted and honored. seed accepted. " +
        "STILL UNVERIFIED: whether reasoning returns separately — that probe hit a 503, so nothing was observed and no claim " +
        "is made either way.",
      limits:
        "max_tokens 16000 accepted. Context window 1M tokens is DOCUMENTED, not measured, and lives in " +
        "documentedContextWindow only. " + LIMITS_UNPROBED,
    },
  },

  // ---------------- GLM-5.2 via NVIDIA ----------------
  // Deliberately conservative: being a reasoning model does not mean it takes
  // DeepSeek's or Nemotron's fields, and the hosted request controls have not
  // been confirmed. Until a probe confirms them, only documented common fields
  // are sent. The role's reasoning INTENT is still recorded in diagnostics, and
  // no run may claim it reasoned unless the response carries reasoning content.
  {
    // LIVE VERIFIED, and this record changed the most. The pre-probe version sent
    // NO reasoning field because the hosted controls were unconfirmed. The probe
    // confirmed them: chat_template_kwargs.thinking is accepted AND the response
    // came back with message.reasoning_content, so reasoning genuinely runs. The
    // shaping function now sends it — see nvidiaRequestProfiles.ts.
    ...nvidiaBase(MODEL_IDS.nvidia.glm, "glm-5-2"),
    liveContractVerified: true,
    // RETIRED BY THE PROVIDER, 2026-08-21. Not a capability fault and not a
    // probe this repository can ever pass again — NVIDIA end-of-lifed the id:
    //
    //   HTTP 410 {"title":"Gone","detail":"The model 'z-ai/glm-5.2' has reached
    //   its end of life on 2026-08-21T09:00:00Z and is no longer available."}
    //
    // Observed continuously in the production worker log on 2026-08-24. This
    // record said `available` for those three days, and the cost of that is
    // larger than one dead rung: glm-5.2 was the SECOND candidate for nine
    // roles (topic_generation, research_brief, script_outline,
    // script_story_editor, script_debate_architect, script_verification,
    // quality_judge, fact_check) and the PRIMARY for cold_open_judge. So every
    // time a primary failed — and NVIDIA's Nemotron was 503-ing and timing out
    // all day — the router spent its next hop on a certain 410 before reaching
    // a rung that could answer. `retired` makes isRoutableByDefault false, so
    // the chains drop it and each of those roles fails over one hop sooner.
    //
    // Permanent: do not restore this to `available` without a NEW model id.
    availability: "retired",
    qualityTested: false,
    supportsThinking: true,
    supportsReasoningEffort: true,
    supportsNativeJsonObject: true,
    supportsNativeJsonSchema: true,
    supportsSeed: true,
    provenance: {
      catalog: CATALOG_NVIDIA,
      requestFields:
        PROBE_RUN + ": chat_template_kwargs.thinking accepted (true and false) and the response returned " +
        "message.reasoning_content — reasoning is real, not just an accepted field. reasoning_effort accepted nested and " +
        "top-level. `reasoning_budget` REJECTED (400 Unsupported parameter), so this is NOT Nemotron's contract despite both " +
        "being reasoning models — exactly the guess the per-model split refused to make. response_format json_object AND " +
        "json_schema accepted and honored. seed accepted.",
      limits: "max_tokens 16000 accepted. " + LIMITS_UNPROBED,
    },
  },

  // ---------------- Mistral Medium 3.5 ----------------
  // NVIDIA's example uses a TOP-LEVEL reasoning_effort. But this model's job
  // here is dialogue generation, and reasoning stays OFF for it by default:
  // adding hidden reasoning overhead to every 16,000-token movement is a real
  // cost and latency change that no application-specific experiment has
  // justified yet. See profiles.ts / roles.ts (script_movement.reasoning=off).
  {
    // LIVE VERIFIED — and it vindicated the per-model split loudly. This model
    // REJECTS chat_template_kwargs outright ("chat_template is not supported for
    // Mistral tokenizers"), so the original provider-wide
    // reasoningSpelling: "chat_template_kwargs" would have 400'd every single
    // Mistral call. Only the top-level form works.
    //
    // LATENCY WARNING, and it matters for the role it holds: the probe measured
    // 30-88s for ONE-SENTENCE answers (66s, 88s, 55s, 58s, 34s, 77s, 66s, 30s,
    // 82s). This model is the current script_movement primary, where the real
    // call is a 16,000-token movement, three per episode. See the promotion note
    // in profiles.ts — this is unresolved and is the strongest argument against
    // keeping it as the dialogue primary.
    // RETIRED BY THE PROVIDER — 2026-08-07. Everything above this line describes
    // a model that no longer exists; it is kept because a record that recognises
    // the id is more useful than one that makes it look like a typo.
    //
    // Observed live on a real render, 2026-08-12:
    //   HTTP 410 {"type":"about:blank","title":"Gone","status":410,
    //    "detail":"The model 'mistralai/mistral-medium-3.5-128b' has reached its
    //     end of life on 2026-08-07T09:00:00Z and is no longer available."}
    //
    // It was still the host_b_writer PRIMARY and the secondary for four more
    // roles, so every affected call had been paying a guaranteed-losing hop for
    // four days. It went unnoticed because 410 had no case in the error taxonomy
    // and classified as `unknown` — the router read a permanent retirement as a
    // maybe-transient blip. Both halves are fixed: 410 is now `invalid_model`
    // (errors.ts) and this record is `retired`, which the chain filter strips.
    //
    // `retired` rather than `broken-in-production` because the two call for
    // opposite responses: broken-in-production says "re-probe and it may come
    // back", and this one never will.
    ...nvidiaBase(MODEL_IDS.nvidia.mistral, "mistral-medium-3-5"),
    liveContractVerified: true,
    availability: "retired",
    qualityTested: false,
    supportsReasoningEffort: true,
    supportsNativeJsonObject: true,
    supportsNativeJsonSchema: true,
    supportsSeed: true,
    provenance: {
      catalog: CATALOG_NVIDIA,
      requestFields:
        PROBE_RUN + ": EVERY chat_template_kwargs variant REJECTED with 400 `chat_template is not supported for Mistral " +
        "tokenizers` — so nested reasoning_effort and reasoning_budget are impossible here, and a provider-wide " +
        "chat_template_kwargs spelling would have broken every call. TOP-LEVEL reasoning_effort accepted. A top-level " +
        "`thinking` object was also accepted, but the response carried NO reasoning content and message.reasoning was empty, " +
        "so supportsThinking stays FALSE: an accepted-but-inert field is not a thinking mode. response_format json_object AND " +
        "json_schema accepted and honored. seed accepted. Note the response shape differs from its siblings (extra " +
        "stop_reason/token_ids keys, prompt_tokens_details: null) — the usage parser tolerates both.",
      limits:
        "max_tokens 16000 accepted (in 82s for a one-sentence answer). " + LIMITS_UNPROBED,
    },
  },

  // ---------------- Kimi K2.6 ----------------
  // Current NVIDIA deployment information advertises neither native structured
  // output nor reasoning support, so all three are false and response_format is
  // never sent. A successful prompt-enforced JSON response is NOT evidence that
  // native JSON mode works — only the probe's explicit native-mode test is.
  {
    // NOT AVAILABLE to this account. The probe got
    //   404 Not Found — "Function '23d4f03a-…': Not found for account '…'"
    // on the plain request, so catalogVerified is FALSE: whatever the catalog
    // listing says, this endpoint does not resolve for the key in use. Request-
    // field flags are unchanged (an unreachable probe answers nothing).
    //
    // This is a routing problem, not a footnote: Kimi is the SECONDARY for
    // script_movement, script_rewrite and episode_metadata, and the default
    // SCRIPT_CHALLENGER_MODEL. With Mistral slow and Kimi 404, the dialogue role
    // has exactly one usable free candidate (Z.ai). Check model access on the
    // NVIDIA account, or point NVIDIA_MODEL_KIMI at an id this account can reach.
    ...nvidiaBase(MODEL_IDS.nvidia.kimi, "kimi-k2-6"),
    catalogVerified: false,
    // FILTERED OUT of the default profile chains: 404 for this account. Still
    // fully integrated — an explicit SCRIPT_MOVEMENT_LLM_PROVIDER=nvidia with
    // SCRIPT_MOVEMENT_LLM_MODEL=moonshotai/kimi-k2.6 still reaches it, which is
    // how it gets retested once account access is sorted.
    availability: "unavailable-for-account",
    supportsNativeJsonObject: false,
    supportsNativeJsonSchema: false,
    supportsThinking: false,
    supportsPromptEnforcedJson: true,
    provenance: {
      catalog:
        PROBE_RUN + ": 404 `Not found for account` — the id does not resolve for the NVIDIA key in use, so this model is " +
        "reported as catalog-unavailable rather than assumed present. Re-check entitlement or override NVIDIA_MODEL_KIMI.",
      requestFields:
        "UNVERIFIED — the model was unreachable, so nothing was observed. NVIDIA's deployment information advertises neither " +
        "native structured output nor reasoning support, which is why both stay false and response_format is never sent. " +
        "JSON would be enforced in the prompt, parsed strictly, validated against the full application structure, and given " +
        "one repair attempt before fallback. A successful prompt-enforced response never upgrades supportsNativeJsonObject — " +
        "only the probe's explicit native-mode test can.",
      limits: LIMITS_UNPROBED,
    },
  },

  // ---------------- Z.ai GLM-4.7 Flash (general-purpose API) ----------------
  {
    provider: "zai",
    model: MODEL_IDS.zai.glmFlash,
    // The model answered a real request, so it exists and the id is right.
    catalogVerified: true,
    liveContractVerified: true,
    availability: "available",
    qualityTested: false,
    // DELIBERATELY NOT UPGRADED, against the probe's own recommendation.
    //
    // Z.ai returned 200 for EVERY parameter tried, including
    // `chat_template_kwargs` — a field that exists only in NVIDIA's NIM
    // transport and that Z.ai has no reason to implement. That is the signature
    // of an endpoint which ignores unknown parameters rather than validating
    // them, and on such an endpoint a 200 cannot distinguish "honored" from
    // "silently dropped". Upgrading these flags from acceptance alone would put
    // a guess in the registry wearing a live-verified badge, which is the exact
    // failure this split was built to prevent.
    //
    // The probe now runs a leniency control (an invented parameter name) so a
    // future run can tell the two cases apart. Until that comes back strict,
    // these stay false and the prompt-enforced path — which is OBSERVED to work
    // here — keeps doing the job.
    supportsNativeJsonObject: false,
    supportsNativeJsonSchema: false,
    supportsPromptEnforcedJson: true,
    // Confirmed by OUTPUT, not by acceptance: the response carried
    // message.reasoning_content, so thinking genuinely runs on this model.
    supportsThinking: true,
    supportsReasoningEffort: false,
    supportsReasoningBudget: false,
    supportsSeed: false,
    supportsSystemPrompt: true,
    supportsStreaming: true,
    requestParameterProfile: "zai-glm",
    unpriced: true,
    provenance: {
      catalog: PROBE_RUN + ": answered a live request at https://api.z.ai/api/paas/v4 — the id and the general-purpose endpoint are confirmed.",
      requestFields:
        PROBE_RUN + ": every parameter tried returned 200, INCLUDING chat_template_kwargs (an NVIDIA-only field). This endpoint " +
        "appears not to validate unknown parameters, so acceptance proves nothing and json/seed/effort/budget flags were NOT " +
        "upgraded. What IS proven from output: message.reasoning_content is returned, so reasoning runs; and prompt-enforced " +
        'JSON works (returned {"sport":"football","ok":true}). The top-level thinking object is sent as documented.',
      limits:
        "IMPORTANT, OBSERVED: this model REASONS BY DEFAULT and will spend the whole allowance doing it. On the plain probe " +
        "(max_tokens 128) it returned finish_reason=length with completion_tokens 128 of which reasoning_tokens 128, and " +
        "content EMPTY. So a small max_tokens yields no answer at all — our provider reports that as `output_limit` with the " +
        "'spent its entire allowance on reasoning' message rather than as an empty success, and the zai profile sends " +
        "thinking={type:'disabled'} explicitly for roles that do not want it. Give this model room, or turn thinking off. " +
        "max_tokens 16000 accepted (254 completion tokens for a one-sentence answer). " + LIMITS_UNPROBED,
    },
  },

  // ---------------- xAI Grok (direct) ----------------
  //
  // Added because Mistral's retirement left the dialogue family with no reachable
  // second model: after filtering, host A and host B both resolved to Z.ai GLM
  // and one model would have written both characters.
  //
  // WHAT THE EVIDENCE ACTUALLY IS, and it is deliberately narrow. `npm run
  // smoke:llm-providers -- xai` on 2026-08-12 returned a real completion in
  // 2212ms. That proves the id resolves, the credential works, the account is
  // funded, and generateText works. It proves NOTHING about structured output or
  // about writing quality, so the JSON flags below stay false and qualityTested
  // stays false. Structured calls go through the prompt-enforced path, which is
  // the safe default rather than a claim.
  {
    provider: "xai",
    model: MODEL_IDS.xai.grok43,
    catalogVerified: true,
    liveContractVerified: true,
    availability: "available",
    qualityTested: false,
    supportsNativeJsonObject: false,
    supportsNativeJsonSchema: false,
    supportsPromptEnforcedJson: true,
    // The smoke response carried reasoning tokens (reasoning=127), so thinking
    // genuinely runs. Confirmed by OUTPUT, not by an accepted parameter.
    supportsThinking: true,
    supportsReasoningEffort: false,
    supportsReasoningBudget: false,
    supportsSeed: false,
    supportsSystemPrompt: true,
    supportsStreaming: true,
    requestParameterProfile: "openai-chat",
    unpriced: true,
    provenance: {
      catalog:
        "SMOKE VERIFIED 2026-08-12: `npm run smoke:llm-providers -- xai` returned a real completion " +
        "(2212ms) from api.x.ai. The id, the credential and the account funding are all confirmed live.",
      requestFields:
        "NOT probed. Only the default openai-chat shape has been exercised, and only for generateText. " +
        "response_format, seed and reasoning controls are UNTESTED here — the flags above say so rather " +
        "than inheriting a sibling's contract. Run `npm run probe:llm-contract -- --model grok-4.3` to upgrade them.",
      limits:
        "No measured ceiling. The smoke call used max_tokens 64. " + LIMITS_UNPROBED,
    },
  },

  // ---------------- Moonshot Kimi K3 (direct) ----------------
  //
  // The same story as Grok, and it also repairs a long-standing gap: Kimi was
  // always the INTENT for host B in frontier_development, and was unreachable
  // only because it was routed through NVIDIA, where it 404s for this account.
  // Direct through Moonshot it works.
  {
    provider: "moonshot",
    model: MODEL_IDS.moonshot.kimiK3,
    catalogVerified: true,
    liveContractVerified: true,
    availability: "available",
    qualityTested: false,
    supportsNativeJsonObject: false,
    supportsNativeJsonSchema: false,
    supportsPromptEnforcedJson: true,
    supportsThinking: true,
    supportsReasoningEffort: false,
    supportsReasoningBudget: false,
    supportsSeed: false,
    supportsSystemPrompt: true,
    supportsStreaming: true,
    requestParameterProfile: "openai-chat",
    unpriced: true,
    provenance: {
      catalog:
        "SMOKE VERIFIED 2026-08-12: `npm run smoke:llm-providers -- moonshot` returned a real completion " +
        "(5257ms) from platform.moonshot.ai, with separate reasoning content in the response.",
      requestFields:
        "NOT probed beyond generateText. NOTE — the 2026-08-05 smoke run recorded that kimi-k3 rejected every " +
        "temperature except 1 with a 400; that did NOT reproduce on 2026-08-12, where the same harness sent " +
        "temperature 0 and the call succeeded. Recorded as an observation, not as a guarantee: if a 400 naming " +
        "temperature reappears, this is the note to read first. The adapter already adds answer headroom because " +
        "this model reasons by default and bills it against max_tokens (see moonshot.ts).",
      limits: "No measured ceiling. The smoke call used max_tokens 64. " + LIMITS_UNPROBED,
    },
  },

  // ---------------- Anthropic (existing, unchanged behavior) ----------------
  {
    provider: "anthropic",
    model: "claude-opus-5",
    catalogVerified: true,
    liveContractVerified: true,
    availability: "available",
    qualityTested: false,
    supportsNativeJsonObject: false,
    supportsNativeJsonSchema: false,
    supportsPromptEnforcedJson: true,
    supportsThinking: true,
    supportsReasoningEffort: true,
    supportsReasoningBudget: false,
    supportsSeed: false,
    supportsSystemPrompt: true,
    supportsStreaming: true,
    requestParameterProfile: "anthropic-messages",
    rejectsSampling: true,
    unpriced: false,
    provenance: {
      catalog: "In production use in this repository today.",
      requestFields:
        "Adaptive thinking + output_config effort; rejects sampling params. Exercised by the live pipeline.",
      limits: "No cap enforced here; the provider's own max_tokens handling and thinking headroom apply.",
    },
  },
  {
    provider: "anthropic",
    model: "claude-sonnet-5",
    catalogVerified: true,
    liveContractVerified: true,
    availability: "available",
    qualityTested: false,
    supportsNativeJsonObject: false,
    supportsNativeJsonSchema: false,
    supportsPromptEnforcedJson: true,
    supportsThinking: true,
    supportsReasoningEffort: true,
    supportsReasoningBudget: false,
    supportsSeed: false,
    supportsSystemPrompt: true,
    supportsStreaming: true,
    requestParameterProfile: "anthropic-messages",
    rejectsSampling: true,
    unpriced: false,
    provenance: {
      catalog: "In production use in this repository today (global + verify model).",
      requestFields: "Same as claude-opus-5. Exercised by the live pipeline.",
      limits: "No cap enforced here.",
    },
  },
  {
    provider: "anthropic",
    model: "claude-haiku-4-5",
    catalogVerified: true,
    liveContractVerified: true,
    availability: "available",
    qualityTested: false,
    supportsNativeJsonObject: false,
    supportsNativeJsonSchema: false,
    supportsPromptEnforcedJson: true,
    supportsThinking: true,
    supportsReasoningEffort: true,
    supportsReasoningBudget: false,
    supportsSeed: false,
    supportsSystemPrompt: true,
    supportsStreaming: true,
    requestParameterProfile: "anthropic-messages",
    rejectsSampling: true,
    unpriced: false,
    provenance: {
      // REGISTERED BECAUSE IT IS NOW LOAD-BEARING. Haiku has been routable in
      // this repo for a while (the balanced profile's default rung, and every
      // `PAID FALLBACK ... claude-haiku-4-5` line in a production log), but it
      // had no registry entry, so modelCapabilities() answered from the
      // unregistered-model default. That default is fine until a profile
      // depends on the answer, and premiumChain now does.
      catalog:
        "Ran 14 of the 22 calls in the scoped generate:script ledger for episode ade82ba1 " +
        "(docs/verification/tiering-option-a.md), and serves the balanced profile's default rung.",
      requestFields:
        "Same anthropic-messages contract as opus-5 and sonnet-5; rejects sampling params. " +
        "NOT independently probed — the evidence is pipeline traffic, not a contract probe run against " +
        "this model specifically.",
      limits:
        "PROMPT-CACHE MINIMUM IS 4,096 TOKENS, against 1,024 on sonnet-5 and 512 on opus-5. Four of the " +
        "script stages write 3.2-3.5K-token cache blocks, which is BELOW that minimum, so those blocks " +
        "silently do not cache and bill as plain input. The costs in tiering-option-a.md already assume " +
        "no caching on them; a future estimate that assumes caching will be wrong by that margin.",
    },
  },

  // ---------------- OpenAI (existing, unchanged behavior) ----------------
  {
    provider: "openai",
    model: "gpt-4o-mini",
    catalogVerified: true,
    liveContractVerified: false,
    availability: "available",
    qualityTested: false,
    supportsNativeJsonObject: true,
    supportsNativeJsonSchema: true,
    supportsPromptEnforcedJson: true,
    supportsThinking: false,
    supportsReasoningEffort: false,
    supportsReasoningBudget: false,
    supportsSeed: true,
    supportsSystemPrompt: true,
    supportsStreaming: true,
    requestParameterProfile: "openai-chat",
    unpriced: false,
    provenance: {
      catalog: "Long-standing OpenAI chat model; the provider's historical default here.",
      requestFields: "OpenAI's documented chat-completions contract, unchanged by this work.",
      limits: "No cap enforced here.",
    },
  },

  // ---------------- Stub ----------------
  {
    provider: "stub",
    model: "stub",
    catalogVerified: true,
    liveContractVerified: true,
    availability: "available",
    qualityTested: false,
    supportsNativeJsonObject: false,
    supportsNativeJsonSchema: false,
    supportsPromptEnforcedJson: false,
    supportsThinking: false,
    supportsReasoningEffort: false,
    supportsReasoningBudget: false,
    supportsSeed: false,
    supportsSystemPrompt: true,
    supportsStreaming: false,
    requestParameterProfile: "stub",
    unpriced: true,
    provenance: {
      catalog: "In-repo stub. Refuses real generation by design.",
      requestFields: "None — it makes no request.",
      limits: "Not applicable.",
    },
  },
];

const byKey = new Map<string, ModelCapabilities>(
  REGISTRY.map((r) => [`${r.provider}/${r.model}`.toLowerCase(), r])
);

/**
 * Capabilities for a provider/model pair.
 *
 * An UNKNOWN pair does not throw — an operator who legitimately points a role at
 * another model must still be able to run it. Unknown means "assume nothing,
 * claim nothing, and shrink nothing": catalog-unavailable, no native JSON, no
 * reasoning fields, no enforceable limits.
 */
/** True when this exact provider/model has a real record, not a synthesized one. */
export function isRegisteredModel(provider: string, model: string): boolean {
  return byKey.has(`${provider}/${model}`.toLowerCase());
}

export function modelCapabilities(provider: string, model: string): ModelCapabilities {
  const hit = byKey.get(`${provider}/${model}`.toLowerCase());
  if (hit) return hit;

  const p = provider.toLowerCase();
  const unknownProvenance = {
    catalog: `'${provider}/${model}' is not in the registry, so its catalog presence is unconfirmed.`,
    requestFields:
      "No provider-specific fields are sent for an unregistered model. JSON is prompt-enforced and strictly parsed.",
    limits: LIMITS_UNPROBED,
  };

  if (p === "nvidia") {
    return {
      ...nvidiaBase(model, "generic-nim"),
      catalogVerified: false,
      provenance: unknownProvenance,
    };
  }
  if (p === "zai") {
    return {
      provider: "zai",
      model,
      catalogVerified: false,
      liveContractVerified: false,
      availability: "available",
      qualityTested: false,
      supportsNativeJsonObject: false,
      supportsNativeJsonSchema: false,
      supportsPromptEnforcedJson: true,
      // TRUE ON PURPOSE for an UNREGISTERED model, which is the opposite of the
      // conservative default everywhere else here — and the conservative default
      // is what breaks GLM.
      //
      // shapeZaiRequest only sends `thinking: {type:"disabled"}` when this flag
      // is set. GLM REASONS BY DEFAULT and bills it against max_tokens, so a
      // model that never receives the disable spends its whole allowance
      // thinking and returns empty content. Declaring false does not mean "we
      // send nothing safe"; it means "we send nothing, and the model does
      // whatever it likes".
      //
      // OBSERVED 2026-08-06: glm-5.2, newly funded and absent from this
      // registry, failed a live smoke call with finish_reason=length and no
      // answer — while the REGISTERED glm-4.7-flash, which carries
      // supportsThinking: true, worked. The whole GLM family behaves this way,
      // so the family default should match the registered member.
      //
      // Sending the field is also the safe direction: this endpoint ignores
      // parameters it does not recognise (see the leniency note on the
      // registered entry), so a wrong guess here costs nothing, whereas the
      // omission costs the entire response.
      supportsThinking: true,
      supportsReasoningEffort: false,
      supportsReasoningBudget: false,
      supportsSeed: false,
      supportsSystemPrompt: true,
      supportsStreaming: true,
      requestParameterProfile: "zai-glm",
      unpriced: true,
      provenance: unknownProvenance,
    };
  }
  // xAI, Moonshot and Google all reach this application through the OpenAI chat
  // protocol on the shared base class. NOTHING about their native JSON or
  // reasoning support has been observed on a live account here, so every
  // capability is declared false and JSON stays prompt-enforced — the same
  // conservative posture every other unregistered model gets. Declaring a
  // capability we have not watched work is how a pipeline starts failing in a
  // way nobody can attribute. `npm run probe:llm-contract` is what upgrades it.
  if (p === "xai" || p === "moonshot" || p === "google") {
    return {
      provider: p,
      model,
      catalogVerified: false,
      liveContractVerified: false,
      availability: "available",
      qualityTested: false,
      supportsNativeJsonObject: false,
      supportsNativeJsonSchema: false,
      supportsPromptEnforcedJson: true,
      supportsThinking: false,
      supportsReasoningEffort: false,
      supportsReasoningBudget: false,
      supportsSeed: false,
      supportsSystemPrompt: true,
      supportsStreaming: true,
      requestParameterProfile:
        p === "xai" ? "xai-grok" : p === "moonshot" ? "moonshot-kimi" : "google-gemini",
      // OBSERVED 2026-08-05: kimi-k3 rejects any temperature but 1 outright —
      //   HTTP 400 "invalid temperature: only 1 is allowed for this model"
      // Same contract Anthropic's frontier models have, so it uses the same flag
      // and the shared base omits the field rather than sending a value that
      // fails every call. Scoped to what was actually observed: other Kimi
      // checkpoints accept sampling and are not assumed to behave alike.
      rejectsSampling: p === "moonshot" && /^kimi-k3/i.test(model),
      unpriced: true,
      provenance: unknownProvenance,
    };
  }
  if (p === "anthropic") {
    // Mirrors AnthropicLLMProvider's own substring rules so the registry and the
    // provider cannot disagree about a model neither has an entry for.
    const m = model.toLowerCase();
    const frontier =
      m.includes("opus-4-7") || m.includes("opus-4-8") || m.includes("opus-5") ||
      m.includes("sonnet-5") || m.includes("fable") || m.includes("mythos");
    return {
      provider: "anthropic",
      model,
      catalogVerified: false,
      liveContractVerified: false,
      availability: "available",
      qualityTested: false,
      supportsNativeJsonObject: false,
      supportsNativeJsonSchema: false,
      supportsPromptEnforcedJson: true,
      supportsThinking: frontier,
      supportsReasoningEffort: frontier,
      supportsReasoningBudget: false,
      supportsSeed: false,
      supportsSystemPrompt: true,
      supportsStreaming: true,
      requestParameterProfile: "anthropic-messages",
      rejectsSampling: frontier,
      unpriced: false,
      provenance: unknownProvenance,
    };
  }
  if (p === "openai") {
    const m = model.toLowerCase();
    const reasoning = m.startsWith("o1") || m.startsWith("o3") || m === "gpt-5.5";
    return {
      provider: "openai",
      model,
      catalogVerified: false,
      liveContractVerified: false,
      availability: "available",
      qualityTested: false,
      supportsNativeJsonObject: true,
      supportsNativeJsonSchema: true,
      supportsPromptEnforcedJson: true,
      supportsThinking: reasoning,
      supportsReasoningEffort: false,
      supportsReasoningBudget: false,
      supportsSeed: true,
      supportsSystemPrompt: true,
      supportsStreaming: true,
      requestParameterProfile: reasoning ? "openai-reasoning" : "openai-chat",
      unpriced: false,
      provenance: unknownProvenance,
    };
  }
  return {
    provider,
    model,
    catalogVerified: false,
    liveContractVerified: false,
    availability: "available",
    qualityTested: false,
    supportsNativeJsonObject: false,
    supportsNativeJsonSchema: false,
    supportsPromptEnforcedJson: false,
    supportsThinking: false,
    supportsReasoningEffort: false,
    supportsReasoningBudget: false,
    supportsSeed: false,
    supportsSystemPrompt: true,
    supportsStreaming: false,
    requestParameterProfile: "stub",
    unpriced: true,
    provenance: unknownProvenance,
  };
}

export function allRegisteredModels(): ModelCapabilities[] {
  return [...REGISTRY];
}

/** Every model the routing profiles can select, for the contract probe. */
export function probeTargets(provider: "nvidia" | "zai"): ModelCapabilities[] {
  return REGISTRY.filter((r) => r.provider === provider);
}

/**
 * How structured output should be requested for this model.
 *
 *   native-json-schema  response_format: { type: "json_schema", ... }
 *   native-json-object  response_format: { type: "json_object" }
 *   prompt-enforced     no response_format at all; the prompt demands JSON and
 *                       the strict parser + one repair attempt do the rest
 *
 * Defaulting an unconfirmed model to prompt-enforced is deliberate. It avoids
 * provoking a 400 per process just to discover something the documentation
 * already implies, and it is the mechanism the Anthropic provider has always
 * used, so it is proven in this application rather than merely permissible.
 */
export type StructuredOutputMode = "native-json-schema" | "native-json-object" | "prompt-enforced";

export function structuredOutputMode(
  caps: ModelCapabilities,
  hasSchema: boolean
): StructuredOutputMode {
  if (caps.supportsNativeJsonSchema && hasSchema) return "native-json-schema";
  if (caps.supportsNativeJsonObject) return "native-json-object";
  return "prompt-enforced";
}

/**
 * Resolve the output allowance actually sent to the provider.
 *
 * - No ENFORCEABLE limit (the normal case until a probe runs): the caller's
 *   request passes through UNCHANGED. A 16,000-token movement stays 16,000.
 * - A live-verified limit that the request exceeds: THROW. Silently halving a
 *   script movement produces a truncated episode that looks like a model bug.
 *
 * `documentedMaximumOutputTokens` is never consulted here. A model card is not
 * a measurement.
 */
export function resolveMaxTokens(
  caps: ModelCapabilities,
  requested: number | undefined
): number | undefined {
  if (requested === undefined) return undefined;
  const cap = caps.maximumOutputTokens;
  if (cap === undefined) return requested;
  if (requested > cap) {
    throw new UnsupportedOutputLimitError(caps, requested, cap);
  }
  return requested;
}

export class UnsupportedOutputLimitError extends Error {
  readonly kind = "unsupported_output_limit";
  constructor(caps: ModelCapabilities, requested: number, cap: number) {
    super(
      `[${caps.provider}] ${caps.model} has a live-verified maximum output of ${cap} tokens but ${requested} were requested. ` +
        `The request was NOT silently shrunk — route this role to a model with a larger output allowance, or lower the caller's limit deliberately.`
    );
    this.name = "UnsupportedOutputLimitError";
  }
}
