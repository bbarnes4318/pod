// Model-specific request shaping for NVIDIA NIM.
//
// A single provider-wide `reasoningSpelling` was wrong: NVIDIA's hosted models
// do not share one reasoning contract. From NVIDIA's own documented examples:
//
//   DeepSeek V4 (flash/pro)   extra_body={"chat_template_kwargs":
//                               {"thinking": true, "reasoning_effort": "high"}}
//   Nemotron 3 Ultra          extra_body={"chat_template_kwargs":
//                               {"enable_thinking": true}, "reasoning_budget": 16384}
//   Mistral Medium 3.5        extra_body={"reasoning_effort": "high"}   (TOP LEVEL)
//   Kimi K2.6                 no advertised reasoning or structured-output support
//   GLM-5.2 via NVIDIA        hosted controls NOT confirmed
//
// Sending DeepSeek's `thinking` alias to Nemotron, or Nemotron's top-level
// `reasoning_budget` to DeepSeek, is a guess. So each model gets its own
// shaping function, selected by a typed profile — not by string matching
// scattered through the provider.
//
// One more documented NIM quirk this respects: the `developer` role combined
// with chat_template_kwargs produces 500s, so the system prompt is always sent
// as the `system` role (see OpenAICompatibleLLMProvider.buildMessages).

import { LLMRole } from "./roles";
import { ModelCapabilities, RequestParameterProfile } from "./capabilities";
import { readRoutingEnv } from "./routingEnv";

export type NvidiaRequestProfile =
  | "deepseek-v4"
  | "nemotron-3-ultra"
  | "glm-5-2"
  | "mistral-medium-3-5"
  | "kimi-k2-6"
  | "generic-nim";

export interface ShapeContext {
  /** Does the CALLER want reasoning for this request? */
  wantsReasoning: boolean;
  /** The role being served, when the call was routed by role. */
  role?: LLMRole;
  /** The caller's output allowance, if any — used to protect answer headroom. */
  maxTokens?: number;
  caps: ModelCapabilities;
}

export interface ShapeResult {
  /** Fields to merge into the request body. */
  fields: Record<string, unknown>;
  /**
   * Extra output allowance to add for a model whose REASONING is billed against
   * max_tokens. Raises the ceiling only; actual output is whatever the model
   * produces. Without it, enabling reasoning on such a model silently converts a
   * working call into an empty answer — which the Z.ai probe demonstrated by
   * spending all 128 tokens on reasoning and returning nothing.
   *
   * Same mechanism the Anthropic provider has used for adaptive thinking since
   * before this feature (LLM_THINKING_HEADROOM_TOKENS).
   */
  maxTokensAdd?: number;
  /**
   * What this shaping actually did, for diagnostics. A run may only CLAIM it
   * reasoned when `reasoningRequested` is true AND the response comes back with
   * reasoning content — see the provider's reasoning bookkeeping.
   */
  diagnostics: {
    reasoningRequested: boolean;
    /** Human description of the fields sent, or why none were. */
    note: string;
  };
}

const NO_FIELDS = (note: string): ShapeResult => ({
  fields: {},
  diagnostics: { reasoningRequested: false, note },
});

/** Qualitative effort level for a role that asked for reasoning. */
function effortFor(role: LLMRole | undefined): "low" | "medium" | "high" {
  const override = (readRoutingEnv("NVIDIA_REASONING_EFFORT") || "").trim().toLowerCase();
  if (override === "low" || override === "medium" || override === "high") return override;
  switch (role) {
    // Grading and consolidation benefit most from depth.
    case "script_verification":
    case "fact_check":
    case "research_brief":
    case "evidence_extraction":
    case "quality_judge":
      return "high";
    case "topic_ranking":
    case "script_outline":
      return "medium";
    default:
      return "medium";
  }
}

/**
 * Nemotron's thinking-token budget for a role.
 *
 * Configurable per role family, with the documented 256-16384 range clamped, and
 * one hard safety rule: the budget may never eat the whole allowance. Thinking
 * tokens count against the output budget on models like this, so an unbounded
 * budget on a 1,200-token continuity call is how you get a response that is all
 * reasoning and no answer. At most half the caller's allowance goes to thinking.
 */
export function nemotronBudget(ctx: ShapeContext): { budget: number; note: string } {
  const [min, max] = ctx.caps.reasoningBudgetRange ?? [256, 16384];

  const roleVar =
    ctx.role === "research_brief" || ctx.role === "evidence_extraction"
      ? "NVIDIA_NEMOTRON_REASONING_BUDGET_RESEARCH"
      : ctx.role === "script_verification" || ctx.role === "fact_check"
      ? "NVIDIA_NEMOTRON_REASONING_BUDGET_VERIFY"
      : ctx.role === "quality_judge"
      ? "NVIDIA_NEMOTRON_REASONING_BUDGET_JUDGE"
      : null;

  const configured = roleVar ? Number(readRoutingEnv(roleVar)) : NaN;
  const fallback = Number(readRoutingEnv("NVIDIA_NEMOTRON_REASONING_BUDGET"));
  // 4096 is a deliberately modest default. The documented ceiling is 16384, but
  // the hosted endpoint's real behavior has not been probed from this repo, and a
  // default that starves the answer is worse than a default that thinks less.
  const requested = Number.isFinite(configured) && configured > 0
    ? configured
    : Number.isFinite(fallback) && fallback > 0
    ? fallback
    : 4096;

  let budget = Math.round(Math.min(Math.max(requested, min), max));
  const notes: string[] = [];
  if (roleVar && Number.isFinite(configured) && configured > 0) notes.push(`from ${roleVar}`);
  else if (Number.isFinite(fallback) && fallback > 0) notes.push("from NVIDIA_NEMOTRON_REASONING_BUDGET");
  else notes.push("default 4096");

  if (ctx.maxTokens !== undefined) {
    const headroomCap = Math.floor(ctx.maxTokens / 2);
    if (budget > headroomCap) {
      budget = Math.max(min, headroomCap);
      notes.push(`capped to half of maxTokens (${ctx.maxTokens}) so the answer keeps headroom`);
    }
  }
  return { budget, note: notes.join("; ") };
}

// ---------------------------------------------------------------- strategies

function shapeDeepSeekV4(ctx: ShapeContext): ShapeResult {
  if (!ctx.wantsReasoning) {
    // Explicitly OFF, not merely omitted: topic classification must be
    // deterministic and cheap, and an omitted flag leaves the model's default in
    // charge of that.
    return {
      fields: { chat_template_kwargs: { thinking: false } },
      diagnostics: {
        reasoningRequested: false,
        note: "deepseek-v4: chat_template_kwargs.thinking=false (reasoning explicitly disabled).",
      },
    };
  }
  const effort = effortFor(ctx.role);
  return {
    fields: { chat_template_kwargs: { thinking: true, reasoning_effort: effort } },
    diagnostics: {
      reasoningRequested: true,
      note:
        `deepseek-v4: chat_template_kwargs.thinking=true with NESTED reasoning_effort='${effort}', ` +
        `per NVIDIA's documented example. The nesting is live-unverified from this repo; the contract probe ` +
        `tests nested and top-level placement separately.`,
    },
  };
}

function shapeNemotron3Ultra(ctx: ShapeContext): ShapeResult {
  if (!ctx.wantsReasoning) {
    return {
      fields: { chat_template_kwargs: { enable_thinking: false } },
      diagnostics: {
        reasoningRequested: false,
        note: "nemotron-3-ultra: chat_template_kwargs.enable_thinking=false (reasoning explicitly disabled).",
      },
    };
  }
  const { budget, note } = nemotronBudget(ctx);
  return {
    // enable_thinking (NOT `thinking` — that is DeepSeek's alias and nothing
    // proves Nemotron accepts it) plus a TOP-LEVEL reasoning_budget.
    fields: { chat_template_kwargs: { enable_thinking: true }, reasoning_budget: budget },
    diagnostics: {
      reasoningRequested: true,
      note: `nemotron-3-ultra: chat_template_kwargs.enable_thinking=true, top-level reasoning_budget=${budget} (${note}).`,
    },
  };
}

function shapeMistralMedium35(ctx: ShapeContext): ShapeResult {
  if (!ctx.wantsReasoning) {
    // The default for this model in this application. Its production job is
    // dialogue, and no application-specific experiment has yet shown that
    // reasoning improves the conversation — so no reasoning overhead is added to
    // a 16,000-token movement call.
    return NO_FIELDS(
      "mistral-medium-3-5: no reasoning field sent. Reasoning is off for dialogue by default — adding it to every " +
        "16,000-token movement is a real cost and latency change that needs experimental justification first."
    );
  }
  const effort = effortFor(ctx.role);
  return {
    // TOP-LEVEL, not nested in chat_template_kwargs.
    fields: { reasoning_effort: effort },
    diagnostics: {
      reasoningRequested: true,
      note: `mistral-medium-3-5: TOP-LEVEL reasoning_effort='${effort}' per NVIDIA's documented example for this model.`,
    },
  };
}

function shapeKimiK26(): ShapeResult {
  return NO_FIELDS(
    "kimi-k2-6: no reasoning field and no response_format. NVIDIA's deployment information advertises neither, so " +
      "nothing is sent; JSON is enforced in the prompt and validated by the strict parser."
  );
}

function shapeGlm52(ctx: ShapeContext): ShapeResult {
  // The live probe (2026-07-26) settled what documentation could not:
  // chat_template_kwargs.thinking is accepted AND the response comes back with
  // message.reasoning_content — reasoning genuinely runs. So this model now gets
  // a real reasoning control instead of the empty shape it had while unconfirmed.
  //
  // `reasoning_budget` is NOT sent: the probe rejected it with a 400 here, even
  // though Nemotron accepts it. Both are reasoning models; they are not the same
  // contract, which is the whole reason these are separate functions.
  if (!ctx.wantsReasoning) {
    return {
      fields: { chat_template_kwargs: { thinking: false } },
      diagnostics: {
        reasoningRequested: false,
        note: "glm-5-2: chat_template_kwargs.thinking=false (reasoning explicitly disabled).",
      },
    };
  }
  const effort = effortFor(ctx.role);
  return {
    fields: { chat_template_kwargs: { thinking: true, reasoning_effort: effort } },
    diagnostics: {
      reasoningRequested: true,
      note:
        `glm-5-2: chat_template_kwargs.thinking=true with nested reasoning_effort='${effort}' — both live-verified as ` +
        `accepted, and reasoning_content was observed in the response. reasoning_budget is deliberately omitted (this model ` +
        `400s on it, unlike Nemotron).`,
    },
  };
}

function shapeGenericNim(ctx: ShapeContext): ShapeResult {
  return NO_FIELDS(
    `generic-nim: '${ctx.caps.model}' has no per-model profile, so only documented common fields are sent ` +
      `(no reasoning field, no response_format). Add a profile once its contract is probed.`
  );
}

const STRATEGIES: Record<NvidiaRequestProfile, (ctx: ShapeContext) => ShapeResult> = {
  "deepseek-v4": shapeDeepSeekV4,
  "nemotron-3-ultra": shapeNemotron3Ultra,
  "mistral-medium-3-5": shapeMistralMedium35,
  "kimi-k2-6": shapeKimiK26,
  "glm-5-2": shapeGlm52,
  "generic-nim": shapeGenericNim,
};

const NVIDIA_PROFILES: ReadonlySet<string> = new Set<RequestParameterProfile>([
  "deepseek-v4",
  "nemotron-3-ultra",
  "glm-5-2",
  "mistral-medium-3-5",
  "kimi-k2-6",
  "generic-nim",
]);

export function isNvidiaProfile(p: RequestParameterProfile): p is NvidiaRequestProfile {
  return NVIDIA_PROFILES.has(p);
}

/** Shape one NVIDIA request according to its model's profile. */
export function shapeNvidiaRequest(ctx: ShapeContext): ShapeResult {
  const profile = ctx.caps.requestParameterProfile;
  const strategy = isNvidiaProfile(profile) ? STRATEGIES[profile] : STRATEGIES["generic-nim"];
  return strategy(ctx);
}

/**
 * Z.ai GLM shaping. Kept separate: a different vendor, a different contract.
 *
 * THE FINDING THAT SHAPES THIS FUNCTION: the live probe showed GLM-4.7 Flash
 * REASONS BY DEFAULT and will spend the entire output allowance doing it. On a
 * 128-token request it returned finish_reason=length, completion_tokens=128, all
 * 128 of them reasoning_tokens, and EMPTY content. So:
 *
 *   reasoning OFF  send the disable control explicitly — leaving it unset means
 *                  the model's default (reasoning ON) wins, which is how a
 *                  cheap classification call turns into an empty answer.
 *   reasoning ON   add answer headroom, because the thinking is billed against
 *                  the same budget as the answer.
 *
 * And a claim this function is careful NOT to make: Z.ai accepted an invented
 * parameter during the probe, so it does not validate unknown fields. The
 * disable control being ACCEPTED is therefore not evidence that it was honored.
 * Only the returned output can show that — the provider checks for empty content
 * and reports output_limit rather than treating it as success.
 */
export function shapeZaiRequest(ctx: ShapeContext): ShapeResult {
  if (!ctx.caps.supportsThinking) {
    return NO_FIELDS("zai-glm: thinking not declared for this model, so no reasoning field is sent.");
  }

  if (!ctx.wantsReasoning) {
    return {
      fields: { thinking: { type: "disabled" } },
      diagnostics: {
        reasoningRequested: false,
        note:
          "zai-glm: top-level thinking={type:'disabled'}, sent EXPLICITLY because this model reasons by default and would " +
          "otherwise consume the whole allowance and return nothing. NOT CONFIRMED HONORED: this endpoint accepts unknown " +
          "fields, so acceptance proves nothing — the check that matters is whether content came back, which the provider " +
          "enforces.",
      },
    };
  }

  // Reasoning wanted: reserve room for the answer. Half the caller's allowance,
  // floored so a small request still has somewhere to put an answer.
  const configured = Number(readRoutingEnv("ZAI_REASONING_HEADROOM_TOKENS"));
  const headroom = Number.isFinite(configured) && configured > 0 ? Math.round(configured) : 2048;
  return {
    fields: { thinking: { type: "enabled" } },
    maxTokensAdd: headroom,
    diagnostics: {
      reasoningRequested: true,
      note:
        `zai-glm: top-level thinking={type:'enabled'} with +${headroom} tokens of answer headroom, because this model bills ` +
        `reasoning against max_tokens and was observed spending an entire small allowance on it. A reasoning-only response ` +
        `is still reported as output_limit rather than as an empty success.`,
    },
  };
}
