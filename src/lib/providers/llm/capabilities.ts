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
  availability: "available" | "capacity-limited" | "unavailable-for-account";

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
  | "not-quality-tested";

export function verificationState(caps: ModelCapabilities): VerificationState {
  if (caps.availability === "unavailable-for-account") return "unavailable-for-account";
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
const PROBE_RUN = "live probe 2026-07-26";

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
    // LIVE VERIFIED, and the cleanest of the six.
    ...nvidiaBase(MODEL_IDS.nvidia.deepseekPro, "deepseek-v4"),
    liveContractVerified: true,
    availability: "available",
    qualityTested: false,
    supportsThinking: true,
    supportsReasoningEffort: true,
    // Observed, so now declared. The request path uses these.
    supportsNativeJsonObject: true,
    supportsNativeJsonSchema: true,
    supportsSeed: true,
    provenance: {
      catalog: CATALOG_NVIDIA,
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
    supportsReasoningBudget: true,
    reasoningBudgetRange: [256, 16384],
    documentedContextWindow: 1_000_000,
    supportsReasoningEffort: true,
    supportsNativeJsonObject: true,
    supportsNativeJsonSchema: true,
    supportsSeed: true,
    provenance: {
      catalog: CATALOG_NVIDIA,
      requestFields:
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
    availability: "available",
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
    ...nvidiaBase(MODEL_IDS.nvidia.mistral, "mistral-medium-3-5"),
    liveContractVerified: true,
    availability: "available",
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
      supportsThinking: false,
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
