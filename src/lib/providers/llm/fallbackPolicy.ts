// Fallback policy: given a failure, may the router try the next candidate?
//
// The previous behavior — advance after ANY caught error — is wrong in both
// directions. It hid real defects (a bad application schema produced four
// identical failures across four providers before surfacing) and it quietly
// spent money (a configuration mistake walked straight into the paid legacy
// provider and the episode "succeeded", so the misconfiguration was invisible).
//
// One function decides, and it is the only place the decision is made.

import {
  LlmErrorCategory,
  categoryOf,
  isConfigurationCategory,
  isContinueCategory,
  isTerminalCategory,
} from "./errors";

export type FallbackVerdict = "continue" | "stop";

export interface FallbackCandidateInfo {
  provider: string;
  model?: string;
  /** Calling this costs money (Anthropic / OpenAI). */
  paid: boolean;
  /** Which resolution rung produced it. */
  source: string;
}

export interface FallbackDecision {
  verdict: FallbackVerdict;
  category: LlmErrorCategory;
  /** Operator-readable justification. Always populated. */
  reason: string;
}

export interface FallbackPolicyContext {
  /** Is paid Anthropic/OpenAI fallback permitted at all? */
  paidFallbackAllowed: boolean;
  /**
   * Did the operator set LLM_ALLOW_LEGACY_FALLBACK explicitly, rather than
   * inheriting the default? Crossing into a PAID provider to paper over a
   * CONFIGURATION mistake requires a deliberate choice, not a default.
   */
  paidFallbackExplicit: boolean;
}

/**
 * Decide whether to advance from `current` to `next` after `error`.
 *
 * `next` is undefined when the chain is exhausted; the verdict is then always
 * "stop", but the category and reason still describe why the last candidate
 * failed so the aggregated error stays informative.
 */
export function fallbackDecision(
  error: unknown,
  current: FallbackCandidateInfo,
  next: FallbackCandidateInfo | undefined,
  ctx: FallbackPolicyContext
): FallbackDecision {
  const category = categoryOf(error);
  const here = `${current.provider}/${current.model ?? "(provider-default)"}`;

  if (isTerminalCategory(category)) {
    return {
      verdict: "stop",
      category,
      reason:
        `${category} on ${here} is not a provider problem — no other model fixes it. ` +
        `Stopping so the real defect surfaces instead of being buried under further failures.`,
    };
  }

  if (!next) {
    return {
      verdict: "stop",
      category,
      reason: `${category} on ${here}, and no candidate remains for this role.`,
    };
  }

  const there = `${next.provider}/${next.model ?? "(provider-default)"}`;

  if (isConfigurationCategory(category)) {
    // A misconfigured free candidate should not block a development run, but it
    // must not silently escalate to a paid provider either.
    if (next.paid) {
      if (!ctx.paidFallbackAllowed) {
        return {
          verdict: "stop",
          category,
          reason:
            `${category} on ${here}. The only remaining candidate (${there}) is PAID and paid fallback is ` +
            `disabled, so the configuration failure is reported rather than spent around. ` +
            `Fix the configuration, or set LLM_ALLOW_LEGACY_FALLBACK=true deliberately.`,
        };
      }
      if (!ctx.paidFallbackExplicit) {
        return {
          verdict: "stop",
          category,
          reason:
            `${category} on ${here}. Crossing into the PAID candidate ${there} to work around a ` +
            `configuration failure requires LLM_ALLOW_LEGACY_FALLBACK to be set explicitly — it is ` +
            `currently only the default. The configuration failure is reported instead.`,
        };
      }
      return {
        verdict: "continue",
        category,
        reason:
          `${category} on ${here}; advancing to the PAID candidate ${there} because ` +
          `LLM_ALLOW_LEGACY_FALLBACK=true was set explicitly. The original failure remains in the log.`,
      };
    }
    return {
      verdict: "continue",
      category,
      reason:
        `${category} on ${here}; advancing to the free candidate ${there}. ` +
        `The configuration failure is still reported — it is not resolved by this fallback.`,
    };
  }

  if (isContinueCategory(category)) {
    return {
      verdict: "continue",
      category,
      reason: `${category} on ${here}; ${there} is worth trying.`,
    };
  }

  // Unknown: advance (an unclassified provider failure is more likely transient
  // than a defect in our request) but say plainly that it was unclassified, so a
  // recurring "unknown" is visible instead of comfortable.
  return {
    verdict: "continue",
    category,
    reason:
      `UNCLASSIFIED failure on ${here}; advancing to ${there}. ` +
      `An unclassified category means the error taxonomy in errors.ts needs a case for this response.`,
  };
}

/** Structured audit record for a paid fallback. Logged and ledgered, never silent. */
export interface PaidFallbackAudit {
  role: string;
  failedFreeCandidates: string[];
  failureCategories: string[];
  paidProvider: string;
  paidModel: string;
  reasonPermitted: string;
}

export function formatPaidFallbackAudit(a: PaidFallbackAudit): string {
  return (
    `[LLMRouting] PAID FALLBACK role=${a.role} paid=${a.paidProvider}/${a.paidModel} — ` +
    `free candidates that failed: ${a.failedFreeCandidates.join(", ") || "(none)"}; ` +
    `categories: ${a.failureCategories.join(", ") || "(none)"}; ` +
    `permitted because: ${a.reasonPermitted}. THIS REQUEST INCURS COST.`
  );
}
