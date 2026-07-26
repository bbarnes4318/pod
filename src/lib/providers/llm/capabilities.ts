// Typed model capability registry.
//
// Not every OpenAI-COMPATIBLE provider accepts the same fields, and not every
// model behind one provider accepts the same fields as its siblings. Before a
// request goes out, the caller's intent is filtered through the record for the
// exact provider/model pair: unsupported parameters are removed, thinking is
// translated into that model's spelling, and the caller's output allowance is
// preserved.
//
// HONESTY RULE — `verified`:
//   verified: true  = these fields were confirmed against the provider's own
//                     documentation or against a live probe from this repo.
//   verified: false = DECLARED from the routing specification and not yet
//                     confirmed. An unverified record must never be used to
//                     shrink a caller's request: `maximumOutputTokens` is left
//                     undefined ("unknown"), and an unknown limit passes the
//                     caller's value through untouched. Only a CONFIRMED limit
//                     may reject an over-large request.
//
//   Run `npm run test:nvidia-provider -- --live` / `--live` on the Z.ai probe
//   with credentials present to confirm a record, then flip `verified` and fill
//   in the real numbers. The readiness role map reports unverified models so an
//   operator can see exactly which claims are still declarations.

export interface ModelCapabilities {
  provider: string;
  model: string;
  contextWindow?: number;
  /** Hard output cap. UNDEFINED means unknown — never used to shrink a request. */
  maximumOutputTokens?: number;
  /** Accepts response_format: { type: "json_schema", ... }. */
  supportsStructuredOutput: boolean;
  /** Accepts response_format: { type: "json_object" }. */
  supportsJsonObjectMode: boolean;
  supportsThinking: boolean;
  supportsReasoningEffort: boolean;
  supportsSeed: boolean;
  supportsSystemPrompt: boolean;
  supportsStreaming: boolean;
  /** Which request-shaping code path applies. */
  requestParameterProfile:
    | "nvidia-chat"
    | "nvidia-reasoning-chat"
    | "zai-chat"
    | "anthropic-messages"
    | "openai-chat"
    | "openai-reasoning"
    | "stub";
  /** Sampling params are rejected outright by this model (Anthropic frontier). */
  rejectsSampling?: boolean;
  verified: boolean;
  /** Free/unpriced endpoint — cost must be reported as null, never estimated. */
  unpriced: boolean;
  note?: string;
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

const UNVERIFIED_NVIDIA_NOTE =
  "Model id and parameter support declared from the routing spec; not yet confirmed against the live NVIDIA catalog. Override with the matching NVIDIA_MODEL_* variable if the catalog id differs.";

function nvidiaRecord(model: string, reasoning: boolean): ModelCapabilities {
  return {
    provider: "nvidia",
    model,
    // contextWindow / maximumOutputTokens deliberately UNKNOWN until probed —
    // an unknown limit never shrinks a caller's 16,000-token movement request.
    supportsStructuredOutput: false,
    supportsJsonObjectMode: true,
    supportsThinking: reasoning,
    supportsReasoningEffort: false,
    supportsSeed: true,
    supportsSystemPrompt: true,
    supportsStreaming: true,
    requestParameterProfile: reasoning ? "nvidia-reasoning-chat" : "nvidia-chat",
    verified: false,
    unpriced: true,
    note: UNVERIFIED_NVIDIA_NOTE,
  };
}

const REGISTRY: ModelCapabilities[] = [
  // ---------------- NVIDIA NIM (hosted, free for development) ----------------
  nvidiaRecord(MODEL_IDS.nvidia.deepseekFlash, false),
  nvidiaRecord(MODEL_IDS.nvidia.deepseekPro, true),
  nvidiaRecord(MODEL_IDS.nvidia.glm, true),
  nvidiaRecord(MODEL_IDS.nvidia.nemotron, true),
  nvidiaRecord(MODEL_IDS.nvidia.mistral, false),
  nvidiaRecord(MODEL_IDS.nvidia.kimi, false),

  // ---------------- Z.ai (general-purpose API) ----------------
  {
    provider: "zai",
    model: MODEL_IDS.zai.glmFlash,
    supportsStructuredOutput: false,
    supportsJsonObjectMode: true,
    supportsThinking: true,
    supportsReasoningEffort: false,
    supportsSeed: false,
    supportsSystemPrompt: true,
    supportsStreaming: true,
    requestParameterProfile: "zai-chat",
    verified: false,
    unpriced: true,
    note:
      "Declared from the routing spec. Z.ai's free tier is quota-limited; a 429 here is a quota signal, not a capability problem.",
  },

  // ---------------- Anthropic (existing, unchanged behavior) ----------------
  {
    provider: "anthropic",
    model: "claude-opus-5",
    supportsStructuredOutput: false,
    supportsJsonObjectMode: false,
    supportsThinking: true,
    supportsReasoningEffort: true,
    supportsSeed: false,
    supportsSystemPrompt: true,
    supportsStreaming: true,
    requestParameterProfile: "anthropic-messages",
    rejectsSampling: true,
    verified: true,
    unpriced: false,
    note: "Current script writer. Adaptive thinking + effort; rejects sampling params.",
  },
  {
    provider: "anthropic",
    model: "claude-sonnet-5",
    supportsStructuredOutput: false,
    supportsJsonObjectMode: false,
    supportsThinking: true,
    supportsReasoningEffort: true,
    supportsSeed: false,
    supportsSystemPrompt: true,
    supportsStreaming: true,
    requestParameterProfile: "anthropic-messages",
    rejectsSampling: true,
    verified: true,
    unpriced: false,
    note: "Current global + verify model.",
  },

  // ---------------- OpenAI (existing, unchanged behavior) ----------------
  {
    provider: "openai",
    model: "gpt-4o-mini",
    supportsStructuredOutput: true,
    supportsJsonObjectMode: true,
    supportsThinking: false,
    supportsReasoningEffort: false,
    supportsSeed: true,
    supportsSystemPrompt: true,
    supportsStreaming: true,
    requestParameterProfile: "openai-chat",
    verified: true,
    unpriced: false,
  },

  // ---------------- Stub ----------------
  {
    provider: "stub",
    model: "stub",
    supportsStructuredOutput: false,
    supportsJsonObjectMode: false,
    supportsThinking: false,
    supportsReasoningEffort: false,
    supportsSeed: false,
    supportsSystemPrompt: true,
    supportsStreaming: false,
    requestParameterProfile: "stub",
    verified: true,
    unpriced: true,
  },
];

const byKey = new Map<string, ModelCapabilities>(
  REGISTRY.map((r) => [`${r.provider}/${r.model}`.toLowerCase(), r])
);

/**
 * Capabilities for a provider/model pair. An UNKNOWN pair does not throw — it
 * gets a conservative unverified record for its provider family, because a
 * model the operator legitimately pointed at with an env override must still
 * run. "Unknown" means "assume nothing and shrink nothing".
 */
export function modelCapabilities(provider: string, model: string): ModelCapabilities {
  const hit = byKey.get(`${provider}/${model}`.toLowerCase());
  if (hit) return hit;

  const p = provider.toLowerCase();
  if (p === "nvidia") return nvidiaRecord(model, false);
  if (p === "zai") {
    return {
      provider: "zai",
      model,
      supportsStructuredOutput: false,
      supportsJsonObjectMode: true,
      supportsThinking: false,
      supportsReasoningEffort: false,
      supportsSeed: false,
      supportsSystemPrompt: true,
      supportsStreaming: true,
      requestParameterProfile: "zai-chat",
      verified: false,
      unpriced: true,
      note: "Not in the registry — capabilities assumed conservatively.",
    };
  }
  if (p === "anthropic") {
    // Mirrors AnthropicLLMProvider's own substring rules so the registry and
    // the provider cannot disagree about a model neither has an entry for.
    const m = model.toLowerCase();
    const frontier =
      m.includes("opus-4-7") || m.includes("opus-4-8") || m.includes("opus-5") ||
      m.includes("sonnet-5") || m.includes("fable") || m.includes("mythos");
    return {
      provider: "anthropic",
      model,
      supportsStructuredOutput: false,
      supportsJsonObjectMode: false,
      supportsThinking: frontier,
      supportsReasoningEffort: frontier,
      supportsSeed: false,
      supportsSystemPrompt: true,
      supportsStreaming: true,
      requestParameterProfile: "anthropic-messages",
      rejectsSampling: frontier,
      verified: false,
      unpriced: false,
    };
  }
  if (p === "openai") {
    const m = model.toLowerCase();
    const reasoning = m.startsWith("o1") || m.startsWith("o3") || m === "gpt-5.5";
    return {
      provider: "openai",
      model,
      supportsStructuredOutput: true,
      supportsJsonObjectMode: true,
      supportsThinking: reasoning,
      supportsReasoningEffort: false,
      supportsSeed: true,
      supportsSystemPrompt: true,
      supportsStreaming: true,
      requestParameterProfile: reasoning ? "openai-reasoning" : "openai-chat",
      verified: false,
      unpriced: false,
    };
  }
  return {
    provider,
    model,
    supportsStructuredOutput: false,
    supportsJsonObjectMode: false,
    supportsThinking: false,
    supportsReasoningEffort: false,
    supportsSeed: false,
    supportsSystemPrompt: true,
    supportsStreaming: false,
    requestParameterProfile: "stub",
    verified: false,
    unpriced: true,
  };
}

export function allRegisteredModels(): ModelCapabilities[] {
  return [...REGISTRY];
}

/**
 * Resolve the output allowance actually sent to the provider.
 *
 * - Unknown (unverified) limit: the caller's request passes through UNCHANGED.
 *   A 16,000-token movement request stays 16,000.
 * - Confirmed limit that the request exceeds: THROW. Silently halving a script
 *   movement produces a truncated episode that looks like a model failure.
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
      `[${caps.provider}] ${caps.model} has a confirmed maximum output of ${cap} tokens but ${requested} were requested. ` +
        `The request was NOT silently shrunk — route this role to a model with a larger output allowance, or lower the caller's limit deliberately.`
    );
    this.name = "UnsupportedOutputLimitError";
  }
}
