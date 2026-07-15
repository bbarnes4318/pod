// THE shared topic-eligibility contract for every editorial surface (Studio and
// Admin). One rule set, one vocabulary of reasons.
//
// The central rule this encodes:
//
//   HARD GATES (approval + real evidence) block EVERY context.
//   AUTOMATIC THRESHOLDS (talkability / debate score / filters) gate ONLY what
//   the platform picks on its own — they NEVER hide a manually relevant topic
//   and are never disguised as an evidence failure.
//
// A surface may show a topic that automatic selection would skip, labelled
// "below the automatic threshold", and let a producer pick it manually. A topic
// that fails an EVIDENCE gate says so directly.
//
// Authority differences live in `actor`, not in hidden rules: an admin may
// authorize the audited recently-used override; an owner may not.

import { DEFAULT_MIN_DEBATE_SCORE, DEFAULT_MIN_TALKABILITY } from "../episodeLimits";
import type { ScopedTopicUsage, TopicReusePolicy } from "./topicUsageService";
import { scopedRecentUseCount } from "./topicUsageService";

/** Which kind of pick is being evaluated. */
export type SelectionContext = "manual" | "automatic" | "hybrid_pin";

export type EligibilityCode =
  // --- hard gates (block every context) ---
  | "not_found"
  | "pending_approval"
  | "rejected"
  | "archived"
  | "missing_brief"
  | "missing_facts"
  | "missing_sources"
  | "missing_host_arguments"
  | "insufficient_evidence"
  // --- live research state (only when a surface supplies it) ---
  | "research_queued"
  | "research_in_progress"
  | "research_failed"
  // --- automatic-only gates (never block manual) ---
  | "below_automatic_threshold"
  | "filter_mismatch"
  // --- policy / context ---
  | "recently_used"
  | "reuse_policy_blocked"
  | "already_selected"
  | "unauthorized";

export interface EligibilityReason {
  code: EligibilityCode;
  /** Operator-readable explanation. Never a generic "Unavailable". */
  message: string;
  field?: string;
}

export type EligibilityAction =
  | "approve"
  | "research"
  | "regenerate_research"
  | "preview_research"
  | "reuse_override";

export interface TopicEligibilityResult {
  topicId: string;
  /** Topics are never silently hidden; a surface shows them with their reason. */
  visible: boolean;
  manuallySelectable: boolean;
  automaticallySelectable: boolean;
  hybridPinnable: boolean;
  blockingReasons: EligibilityReason[];
  warnings: EligibilityReason[];
  actions: EligibilityAction[];
}

/** WHO is selecting. Authority — not rules — differs between surfaces. */
export type EligibilityActor =
  | { kind: "admin"; adminId: string }
  | { kind: "owner"; ownerId: string };

/** Live research-job state, when a surface can supply it (e.g. from JobLog).
 *  Studio does not supply it today, so those codes simply never fire there. */
export type ResearchState = "queued" | "in_progress" | "failed";

export interface AutomaticPreferences {
  minDebateScore?: number;
  minTalkability?: number;
  verticals?: string[];
  leagueIds?: string[];
  teams?: string[];
  sport?: string;
}

export interface EligibilityContext {
  actor: EligibilityActor;
  policy: TopicReusePolicy;
  /** Selected podcast, when one is chosen — scopes reuse + usage. */
  podcastId?: string;
  /** Scoped usage for this topic set (never platform-wide). */
  usage?: Map<string, ScopedTopicUsage>;
  /** Topics already in the current rundown. */
  selectedTopicIds?: string[];
  /** Preferences that steer AUTOMATIC selection only. */
  automatic?: AutomaticPreferences;
  /** Precomputed talkability total, when the caller already has it. */
  talkability?: number;
  /** Live research state for this topic, when known. */
  researchState?: ResearchState;
  /** Fallback id for a topic that no longer exists. */
  topicId?: string;
}

/** The minimal topic shape the gates read. Prisma rows satisfy it. */
export interface EligibilityTopic {
  id: string;
  title: string;
  status: string;
  sport: string;
  leagueId: string | null;
  summary: string | null;
  debateScore: number;
  evidenceIds: unknown;
  researchBrief: {
    facts: unknown;
    sourceIds: unknown;
    argumentForHostA: string | null;
    argumentForHostB: string | null;
  } | null;
}

/**
 * The HARD gates, in a FIXED order, as ordered reasons.
 *
 * This is the one implementation of "can this topic anchor an episode at all".
 * `episodeService.evaluateTopicEligibility` maps the first reason here onto its
 * coarse category, so the creation path and every picker agree by construction.
 * The order and the messages are load-bearing — do not reorder or reword them
 * without updating the tests that assert creation-path parity.
 */
export function evaluateHardGates(
  topic: EligibilityTopic | null | undefined,
  idForMessage?: string
): EligibilityReason[] {
  if (!topic) {
    return [{ code: "not_found", message: `Topic candidate ${idForMessage ?? "(unknown id)"} not found in database.` }];
  }
  if (topic.status !== "approved") {
    const code: EligibilityCode =
      topic.status === "rejected" ? "rejected" : topic.status === "archived" ? "archived" : "pending_approval";
    return [{ code, message: `Topic candidate '${topic.title}' is not approved (status: ${topic.status}).`, field: "status" }];
  }
  const evidenceIds = Array.isArray(topic.evidenceIds) ? topic.evidenceIds : [];
  if (evidenceIds.length === 0) {
    return [{ code: "insufficient_evidence", message: `Topic candidate '${topic.title}' has empty evidenceIds.`, field: "evidenceIds" }];
  }
  const brief = topic.researchBrief;
  if (!brief) {
    return [{ code: "missing_brief", message: `Topic candidate '${topic.title}' is missing its ResearchBrief.`, field: "researchBrief" }];
  }
  const facts = Array.isArray(brief.facts) ? brief.facts : [];
  if (facts.length === 0) {
    return [{ code: "missing_facts", message: `Topic candidate '${topic.title}' has empty facts in ResearchBrief.`, field: "facts" }];
  }
  const sourceIds = Array.isArray(brief.sourceIds) ? brief.sourceIds : [];
  if (sourceIds.length === 0) {
    return [{ code: "missing_sources", message: `Topic candidate '${topic.title}' has empty sourceIds in ResearchBrief.`, field: "sourceIds" }];
  }
  if (!brief.argumentForHostA?.trim() || !brief.argumentForHostB?.trim()) {
    return [{ code: "missing_host_arguments", message: `Topic candidate '${topic.title}' has empty host arguments in ResearchBrief.`, field: "argumentForHostA" }];
  }
  return [];
}

/** Does the topic match the AUTOMATIC selection preferences? (Never a manual gate.) */
function automaticFilterMismatch(topic: EligibilityTopic, prefs: AutomaticPreferences): EligibilityReason | null {
  if (prefs.sport && topic.sport.toLowerCase() !== prefs.sport.toLowerCase()) {
    return { code: "filter_mismatch", message: `Not in the ${prefs.sport} filter for automatic selection.`, field: "sport" };
  }
  if (prefs.leagueIds?.length && !prefs.leagueIds.includes((topic.leagueId || "").toUpperCase())) {
    return { code: "filter_mismatch", message: `Not in the selected leagues (${prefs.leagueIds.join(", ")}) for automatic selection.`, field: "leagueId" };
  }
  if (prefs.teams?.length) {
    const text = `${topic.title} ${topic.summary || ""}`.toLowerCase();
    const hit = prefs.teams.some((t) => {
      const full = t.toLowerCase();
      const nickname = full.split(" ").slice(-1)[0];
      return text.includes(full) || (nickname.length >= 4 && text.includes(nickname));
    });
    if (!hit) return { code: "filter_mismatch", message: `Doesn't mention a followed team (${prefs.teams.join(", ")}).`, field: "teams" };
  }
  return null;
}

/**
 * Evaluate one topic for selection by one actor, in one podcast/owner context.
 * Returns structured reasons suitable for BOTH server enforcement and UI copy.
 */
export function evaluateTopicSelection(
  topic: EligibilityTopic | null | undefined,
  ctx: EligibilityContext
): TopicEligibilityResult {
  const topicId = topic?.id ?? ctx.topicId ?? "(unknown id)";
  const isAdmin = ctx.actor.kind === "admin";
  const blockingReasons: EligibilityReason[] = [];
  const warnings: EligibilityReason[] = [];
  const actions: EligibilityAction[] = [];

  // ---- 1. HARD GATES — block every context ----
  const hard = evaluateHardGates(topic, ctx.topicId);
  blockingReasons.push(...hard);

  if (!topic) {
    return { topicId, visible: false, manuallySelectable: false, automaticallySelectable: false, hybridPinnable: false, blockingReasons, warnings, actions };
  }

  // ---- 2. Remediation actions (admin-only powers stay admin-only) ----
  if (topic.researchBrief) actions.push("preview_research");
  if (isAdmin) {
    if (topic.status === "pending") actions.push("approve");
    if (!topic.researchBrief) actions.push("research");
    else if (hard.some((r) => r.code === "missing_facts" || r.code === "missing_sources" || r.code === "missing_host_arguments")) {
      actions.push("regenerate_research");
    }
  }

  // ---- 3. Live research state, when the surface supplies it ----
  if (ctx.researchState === "queued") warnings.push({ code: "research_queued", message: "Research is queued for this topic." });
  if (ctx.researchState === "in_progress") warnings.push({ code: "research_in_progress", message: "Research is running for this topic." });
  if (ctx.researchState === "failed") {
    warnings.push({ code: "research_failed", message: "The last research run for this topic failed." });
    if (isAdmin && !actions.includes("regenerate_research")) actions.push("regenerate_research");
  }

  const hardBlocked = blockingReasons.length > 0;

  // ---- 4. AUTOMATIC-ONLY gates — never block manual selection ----
  const prefs = ctx.automatic ?? {};
  const minDebate = prefs.minDebateScore ?? DEFAULT_MIN_DEBATE_SCORE;
  const minTalk = prefs.minTalkability ?? DEFAULT_MIN_TALKABILITY;
  let autoBlocked = false;

  if (topic.debateScore < minDebate) {
    autoBlocked = true;
    warnings.push({
      code: "below_automatic_threshold",
      message: `Debate score ${Math.round(topic.debateScore)} is below the automatic threshold (${minDebate}) — still selectable manually.`,
      field: "debateScore",
    });
  }
  if (ctx.talkability !== undefined && ctx.talkability < minTalk) {
    autoBlocked = true;
    warnings.push({
      code: "below_automatic_threshold",
      message: `Talkability ${Math.round(ctx.talkability)} is below the automatic threshold (${minTalk}) — still selectable manually.`,
      field: "talkability",
    });
  }
  const mismatch = automaticFilterMismatch(topic, prefs);
  if (mismatch) {
    autoBlocked = true;
    warnings.push(mismatch);
  }

  // ---- 5. Reuse policy (scoped to the selected podcast, else the owner) ----
  const usage = ctx.usage?.get(topic.id);
  const recentCount = scopedRecentUseCount(usage, { podcastId: ctx.podcastId });
  const recentlyUsed = recentCount > 0;
  let reuseBlocked = false;

  if (recentlyUsed) {
    const scope = ctx.podcastId ? "this show" : "your account";
    if (ctx.policy.mode === "exclude_podcast" && ctx.podcastId) {
      if (isAdmin) {
        // Admin keeps the topic selectable, but must authorize the audited override.
        warnings.push({
          code: "recently_used",
          message: `Used ${recentCount} time(s) by this show in the last ${ctx.policy.cooldownDays} days — requires a reuse override.`,
        });
        actions.push("reuse_override");
      } else {
        reuseBlocked = true;
        blockingReasons.push({
          code: "reuse_policy_blocked",
          message: "Recently used by this show — pick another or wait for the cooldown.",
        });
      }
      autoBlocked = true; // auto-fill never reuses within the cooldown
    } else if (ctx.policy.mode === "warn") {
      warnings.push({
        code: "recently_used",
        message: `Used ${recentCount} time(s) by ${scope} in the last ${ctx.policy.cooldownDays} days.`,
      });
    } else {
      warnings.push({ code: "recently_used", message: `Used ${recentCount} time(s) by ${scope} recently.` });
    }
  }

  // ---- 6. Already in the current rundown (informational) ----
  if (ctx.selectedTopicIds?.includes(topic.id)) {
    warnings.push({ code: "already_selected", message: "Already in this rundown." });
  }

  const selectable = !hardBlocked && !reuseBlocked;
  return {
    topicId,
    // Never silently hidden — the surface shows the reason instead.
    visible: true,
    manuallySelectable: selectable,
    hybridPinnable: selectable,
    automaticallySelectable: selectable && !autoBlocked,
    blockingReasons,
    warnings,
    actions,
  };
}

/** Convenience: is this topic selectable in a given context? */
export function isSelectableIn(result: TopicEligibilityResult, context: SelectionContext): boolean {
  return context === "automatic"
    ? result.automaticallySelectable
    : context === "hybrid_pin"
      ? result.hybridPinnable
      : result.manuallySelectable;
}
