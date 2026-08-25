// The wall-clock ceiling on one script-generation run — the rule that decides
// an episode is never coming, so that a person does not have to.
//
// WHY THIS EXISTS. Nothing bounded script generation, and the arithmetic of the
// layers underneath says it needed to. A single role call is up to
// `maxRetries + 1` = 3 HTTP attempts (openaiCompatible.ts) at up to a 240s
// timeout each (the zai / nvidia / moonshot / google / xai defaults), across
// every rung of that role's chain — and a chain that ran out because it was
// RATE LIMITED gets `LLM_RATE_WINDOW_PASSES` = 2 extra passes over the whole
// thing (routing.ts). An episode calls twenty-one roles. Multiply it out and a
// single saturated or half-dead provider account buys an episode that crawls
// for an hour without ever failing. routing.ts says exactly this in its own
// comment: "if an operator ever sees an episode crawling rather than failing,
// this is the knob that explains it."
//
// Crawling is the worst of the three outcomes. A finished episode is a result.
// A failed one is a result you can retry. An episode that is *technically still
// working* is a spinner nobody can act on, indistinguishable — from the create
// console, from the job table, from the outside — from one about to finish.
// The Production Console times the active stage against this deployment's own
// median, so it can tell a user their episode is late; nothing could tell them
// it was lost.
//
// WHY IT LIVES IN ITS OWN FILE. worker.ts calls assertProductionEnv() and
// constructs BullMQ Workers and a Redis connection at module load, so nothing
// can import it to test it — which is why its sibling tests asserting on worker
// behaviour do it by grepping the source text, and why one of them spent a
// release failing against code that was correct. This rule is arithmetic. It
// gets to be tested as arithmetic.

import { formatTierDuration, tierInfo, type QualityTier } from "../providers/llm/qualityTiers";

/**
 * How many times the tier's own promised upper bound a run may take before it
 * is treated as stuck.
 *
 * DELIBERATELY LOOSE, and it must stay that way. This is not a performance
 * target and must never be tightened into one — its only job is to convert
 * "forever" into "failed". A budget tight enough to kill a merely slow episode
 * would destroy paid work that was about to land, which is a strictly worse
 * failure than the one it is preventing.
 */
export const BUDGET_MULTIPLE = 3;

/**
 * The smallest override this will honour. A budget under a minute cannot
 * distinguish a wedged run from a healthy one, so it would not bound failures —
 * it would manufacture them.
 */
export const MIN_BUDGET_MS = 60_000;

/**
 * The floor no tier's budget may fall below on this deployment, whatever its
 * advertised duration says.
 *
 * MEASURED, from the production worker log of 2026-08-25 — a Premium run that
 * the 12-minute tier-derived budget killed. Its script stage, timed from the
 * [LLMCost] lines:
 *
 *   story-spine 10s · outline 124s · private-agendas 38s ·
 *   cold-open accusation 11s · contradiction 167s · consequence 199s ·
 *   cold-open judge 70s   =  ~10.3 minutes
 *
 * That is the COLD OPEN alone. Not one script movement had started, so the
 * tier-derived 12 minutes was below this pipeline's floor, not merely tight —
 * the ceiling was killing runs that had never had a chance to finish, and the
 * failure it produced ("a stuck AI provider") was wrong about its own cause.
 *
 * The tier numbers are not at fault for being small; they describe per-call
 * provider latency measured against a healthy chain. This deployment's actual
 * chain is Nemotron at 60-200s per call plus Kimi at ~200s, with the free-tier
 * accounts rate-limiting under a concurrent background sweep. Until that is
 * addressed the honest ceiling is measured, not advertised.
 *
 * Still a stuck-detector and not a target: 30 minutes is roughly 3x the
 * observed cold open, so a wedged provider is caught and a slow-but-working
 * episode is not. Revisit it DOWNWARD once the chain is faster — a floor that
 * outlives its evidence is just a longer spinner.
 */
export const MEASURED_FLOOR_MS = 30 * 60_000;

/**
 * Wall-clock budget for one script run on `tier`.
 *
 * Roughly 12 minutes on the paid tiers (their promised 2-4 min) and 36 on free
 * (its promised 8-12). The free tier gets the larger budget for the same reason
 * it carries a speed warning: eight to twelve minutes is what that tier HONESTLY
 * costs, and a ceiling that ignored the tier would cut off exactly the runs the
 * product told the user to expect.
 *
 * SCRIPT_GENERATION_BUDGET_MS overrides it for a deployment that has measured
 * something different. Raise it only if these episodes do genuinely finish given
 * longer — if they do not, a bigger number just buys a longer spinner.
 */
export function scriptGenerationBudgetMs(
  tier: QualityTier,
  env: NodeJS.ProcessEnv = process.env
): number {
  const raw = Number.parseInt(env.SCRIPT_GENERATION_BUDGET_MS ?? "", 10);
  if (Number.isFinite(raw) && raw >= MIN_BUDGET_MS) return raw;
  const [, upperMinutes] = tierInfo(tier).approxMinutes;
  // The explicit override above still wins outright — an operator who has
  // measured their own chain outranks both of these numbers. Absent one, take
  // whichever of the tier's promise and this deployment's measured floor is
  // LARGER, because the tier's promise turned out to be below the floor on the
  // paid tiers and was killing runs mid-cold-open. See MEASURED_FLOOR_MS.
  return Math.max(upperMinutes * BUDGET_MULTIPLE * 60_000, MEASURED_FLOOR_MS);
}

/** Durations for a human reading a job log, not for a dashboard. */
export function fmtMinutes(ms: number): string {
  const mins = ms / 60_000;
  return mins >= 10 ? `${Math.round(mins)} minutes` : `${mins.toFixed(1)} minutes`;
}

/**
 * What the CREATOR is told. Rendered through humanFailure(), which truncates at
 * 220 characters — so this stays short enough to arrive whole, and says the two
 * things a person actually needs: it is not their episode's fault, and pressing
 * the button again is safe.
 */
export function budgetExceededMessage(elapsedMs: number, tier: QualityTier): string {
  return (
    `The writing stage ran for ${fmtMinutes(elapsedMs)} without finishing — far past the ` +
    `${formatTierDuration(tier)} this tier takes — so it was stopped. This is a stuck AI provider, not ` +
    `your episode. Starting it again is safe.`
  );
}

/**
 * What the OPERATOR is told, on the worker's own console: the ceiling that
 * fired, and precisely where to look for the role that stopped answering.
 */
export function budgetExceededOperatorNote(budgetMs: number, tier: QualityTier): string {
  return (
    `[Worker] Script generation exceeded its ${fmtMinutes(budgetMs)} budget (${tierInfo(tier).label} tier, ` +
    `expects ${formatTierDuration(tier)}). Look for the last [LLMRouting] line in this log: the role named there ` +
    `is the one that stopped answering. Raise SCRIPT_GENERATION_BUDGET_MS only if these episodes do genuinely ` +
    `finish given longer.`
  );
}
