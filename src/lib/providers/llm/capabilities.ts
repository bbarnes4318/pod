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

/** The three states readiness must be able to distinguish. */
export type VerificationState =
  | "catalog-verified-live-untested"
  | "live-contract-verified"
  | "catalog-unavailable";

export function verificationState(caps: ModelCapabilities): VerificationState {
  if (caps.liveContractVerified) return "live-contract-verified";
  if (caps.catalogVerified) return "catalog-verified-live-untested";
  return "catalog-unavailable";
}

export function describeVerificationState(state: VerificationState): string {
  switch (state) {
    case "live-contract-verified":
      return "Live contract verified — called successfully from this repository.";
    case "catalog-verified-live-untested":
      return "Catalog verified, live contract untested — the model ID is confirmed, its request parameters are not.";
    case "catalog-unavailable":
      return "Catalog/model unavailable — the ID has not been confirmed against the provider catalog.";
  }
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

// ---------------------------------------------------------------------------

function nvidiaBase(model: string, profile: RequestParameterProfile): ModelCapabilities {
  return {
    provider: "nvidia",
    model,
    catalogVerified: true,
    liveContractVerified: false,
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
    ...nvidiaBase(MODEL_IDS.nvidia.deepseekFlash, "deepseek-v4"),
    supportsThinking: true,
    supportsReasoningEffort: true,
    provenance: {
      catalog: CATALOG_NVIDIA,
      requestFields:
        "Reasoning enabled via chat_template_kwargs.thinking, with reasoning_effort INSIDE chat_template_kwargs, per NVIDIA's documented example. " +
        "The nesting of reasoning_effort is the specific thing the live probe re-checks (it tests both nested and top-level placement). " +
        NVIDIA_STRUCTURED_UNCONFIRMED,
      limits: LIMITS_UNPROBED,
    },
  },
  {
    ...nvidiaBase(MODEL_IDS.nvidia.deepseekPro, "deepseek-v4"),
    supportsThinking: true,
    supportsReasoningEffort: true,
    provenance: {
      catalog: CATALOG_NVIDIA,
      requestFields:
        "Same documented shape as DeepSeek V4 Flash: chat_template_kwargs.thinking + nested reasoning_effort. " +
        NVIDIA_STRUCTURED_UNCONFIRMED,
      limits: LIMITS_UNPROBED,
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
    ...nvidiaBase(MODEL_IDS.nvidia.nemotron, "nemotron-3-ultra"),
    supportsThinking: true,
    supportsReasoningBudget: true,
    reasoningBudgetRange: [256, 16384],
    documentedContextWindow: 1_000_000,
    provenance: {
      catalog: CATALOG_NVIDIA,
      requestFields:
        "Reasoning enabled via chat_template_kwargs.enable_thinking with a TOP-LEVEL reasoning_budget, per NVIDIA's documented example. " +
        "Documented budget range 256-16384. DeepSeek's `thinking` alias is deliberately never sent here. " +
        NVIDIA_STRUCTURED_UNCONFIRMED,
      limits:
        "Context window 1M tokens is DOCUMENTED, not measured, and is recorded in documentedContextWindow only. " +
        LIMITS_UNPROBED,
    },
  },

  // ---------------- GLM-5.2 via NVIDIA ----------------
  // Deliberately conservative: being a reasoning model does not mean it takes
  // DeepSeek's or Nemotron's fields, and the hosted request controls have not
  // been confirmed. Until a probe confirms them, only documented common fields
  // are sent. The role's reasoning INTENT is still recorded in diagnostics, and
  // no run may claim it reasoned unless the response carries reasoning content.
  {
    ...nvidiaBase(MODEL_IDS.nvidia.glm, "glm-5-2"),
    provenance: {
      catalog: CATALOG_NVIDIA,
      requestFields:
        "Hosted reasoning controls NOT confirmed. No thinking/effort/budget field is sent — reusing Nemotron's or DeepSeek's " +
        "fields because all three are reasoning models would be a guess. The role's reasoning intent is recorded in " +
        "diagnostics only, and reasoning is reported as having run only when the response actually returns reasoning content. " +
        NVIDIA_STRUCTURED_UNCONFIRMED,
      limits: LIMITS_UNPROBED,
    },
  },

  // ---------------- Mistral Medium 3.5 ----------------
  // NVIDIA's example uses a TOP-LEVEL reasoning_effort. But this model's job
  // here is dialogue generation, and reasoning stays OFF for it by default:
  // adding hidden reasoning overhead to every 16,000-token movement is a real
  // cost and latency change that no application-specific experiment has
  // justified yet. See profiles.ts / roles.ts (script_movement.reasoning=off).
  {
    ...nvidiaBase(MODEL_IDS.nvidia.mistral, "mistral-medium-3-5"),
    supportsReasoningEffort: true,
    provenance: {
      catalog: CATALOG_NVIDIA,
      requestFields:
        "A TOP-LEVEL reasoning_effort is documented for this model (not nested in chat_template_kwargs). " +
        "It is NOT sent for dialogue: the dialogue roles request reasoning=off, so no reasoning field goes out on the " +
        "16,000-token movement call. " +
        NVIDIA_STRUCTURED_UNCONFIRMED,
      limits: LIMITS_UNPROBED,
    },
  },

  // ---------------- Kimi K2.6 ----------------
  // Current NVIDIA deployment information advertises neither native structured
  // output nor reasoning support, so all three are false and response_format is
  // never sent. A successful prompt-enforced JSON response is NOT evidence that
  // native JSON mode works — only the probe's explicit native-mode test is.
  {
    ...nvidiaBase(MODEL_IDS.nvidia.kimi, "kimi-k2-6"),
    supportsNativeJsonObject: false,
    supportsNativeJsonSchema: false,
    supportsThinking: false,
    supportsPromptEnforcedJson: true,
    provenance: {
      catalog: CATALOG_NVIDIA,
      requestFields:
        "NVIDIA's deployment information advertises neither native structured output nor reasoning support for this model. " +
        "response_format is never sent; JSON is enforced in the prompt, parsed strictly, validated against the full " +
        "application structure, and given one repair attempt before fallback. A successful prompt-enforced JSON response " +
        "does not upgrade supportsNativeJsonObject — only the probe's explicit native-mode test can.",
      limits: LIMITS_UNPROBED,
    },
  },

  // ---------------- Z.ai GLM-4.7 Flash (general-purpose API) ----------------
  {
    provider: "zai",
    model: MODEL_IDS.zai.glmFlash,
    // Not confirmed against Z.ai's catalog as part of this work — unlike the
    // NVIDIA ids, which were. Reported as catalog-unavailable rather than
    // assumed present.
    catalogVerified: false,
    liveContractVerified: false,
    supportsNativeJsonObject: false,
    supportsNativeJsonSchema: false,
    supportsPromptEnforcedJson: true,
    supportsThinking: true,
    supportsReasoningEffort: false,
    supportsReasoningBudget: false,
    supportsSeed: false,
    supportsSystemPrompt: true,
    supportsStreaming: true,
    requestParameterProfile: "zai-glm",
    unpriced: true,
    provenance: {
      catalog:
        "NOT confirmed against Z.ai's published catalog in this work. Treated as catalog-unavailable until probed.",
      requestFields:
        "GLM models take a top-level thinking object ({ type: 'enabled' | 'disabled' }). Documented by Z.ai for GLM but not " +
        "confirmed by a live probe from this repository; a named-field 400 downgrades it once. " +
        "Native response_format support is unconfirmed, so JSON is prompt-enforced and strictly parsed.",
      limits: LIMITS_UNPROBED,
    },
  },

  // ---------------- Anthropic (existing, unchanged behavior) ----------------
  {
    provider: "anthropic",
    model: "claude-opus-5",
    catalogVerified: true,
    liveContractVerified: true,
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
