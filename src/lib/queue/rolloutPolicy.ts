// Rollout policy for the editorial gate.
//
// THE PROBLEM THIS SOLVES. The gate blocks any script whose recorded verdict is
// not `pass`, and treats a script with NO verdict as unevaluated (blocked in
// production). That is correct for anything written from now on — but every
// script that already exists was written before the gate had authority. Without
// a policy, deploying the gate would strand all of them.
//
// THE POLICY. Grandfathering is:
//   - NARROW      — it applies only to scripts with no verdict at all, never to
//                   a script that WAS measured and came back `review`/`hold`.
//                   A measured-and-failed script has a documented remedy (an
//                   attributable human release); it is not stranded.
//   - DATED       — it applies only to scripts created strictly before an
//                   explicitly configured cutover instant.
//   - EXPLICIT    — the cutover must be configured. Production does not invent
//                   one, so the window cannot quietly widen on every restart.
//   - ATTRIBUTABLE— every grandfathered pass records why it was allowed, the
//                   script's creation time, and the cutover it was compared
//                   against. It is visible in Studio and in the job log.
//
// WHAT IT IS NOT. It is not a global bypass. With the cutover unset, nothing is
// grandfathered — and the production-readiness preflight fails, so the missing
// configuration is caught before deploy rather than discovered at runtime.
//
// The better remedy for a legacy script is to give it a real verdict:
//   npm run gate:reevaluate -- --script <id>
// Grandfathering exists so in-flight work keeps moving while that happens.

export type RolloutDisposition =
  | "enforced"
  | "grandfathered_pre_enforcement"
  | "not_grandfathered_no_cutover"
  | "not_grandfathered_after_cutover"
  | "not_grandfathered_has_verdict";

export interface RolloutDecision {
  /** True when the missing verdict should be tolerated for this script. */
  grandfathered: boolean;
  disposition: RolloutDisposition;
  reason: string;
  /** Recorded so an operator can audit exactly what was compared. */
  scriptCreatedAt: string | null;
  cutoverAt: string | null;
}

export const GATE_ENFORCEMENT_FROM_VAR = "SCRIPT_GATE_ENFORCEMENT_FROM";

/**
 * Parses the configured cutover. Returns null when unset or unparseable — an
 * unparseable value must NOT silently behave like "grandfather everything".
 */
export function resolveGateEnforcementCutover(env: NodeJS.ProcessEnv = process.env): Date | null {
  const raw = (env[GATE_ENFORCEMENT_FROM_VAR] || "").trim();
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

/**
 * Decides whether a script that carries NO editorial verdict may still enter
 * production under the rollout policy.
 *
 * `hasVerdict` must be true whenever the script has any recorded decision, even
 * a failing one — grandfathering never applies to a measured script.
 */
export function evaluateRolloutDisposition(input: {
  hasVerdict: boolean;
  scriptCreatedAt: Date | string | null | undefined;
  env?: NodeJS.ProcessEnv;
}): RolloutDecision {
  const env = input.env ?? process.env;
  const cutover = resolveGateEnforcementCutover(env);
  const createdAt =
    input.scriptCreatedAt instanceof Date
      ? input.scriptCreatedAt
      : input.scriptCreatedAt
        ? new Date(input.scriptCreatedAt)
        : null;
  const createdIso = createdAt && Number.isFinite(createdAt.getTime()) ? createdAt.toISOString() : null;
  const cutoverIso = cutover ? cutover.toISOString() : null;

  if (input.hasVerdict) {
    return {
      grandfathered: false,
      disposition: "not_grandfathered_has_verdict",
      reason:
        "Script carries an editorial verdict, so the rollout policy does not apply. " +
        "A failing verdict is cleared by an attributable human release, not by its age.",
      scriptCreatedAt: createdIso,
      cutoverAt: cutoverIso,
    };
  }

  if (!cutover) {
    return {
      grandfathered: false,
      disposition: "not_grandfathered_no_cutover",
      reason:
        `${GATE_ENFORCEMENT_FROM_VAR} is not configured, so no script is grandfathered. ` +
        `Set it to the deploy instant (ISO 8601) to let pre-existing scripts finish, ` +
        `or re-evaluate this script to give it a real verdict.`,
      scriptCreatedAt: createdIso,
      cutoverAt: null,
    };
  }

  if (!createdIso) {
    return {
      grandfathered: false,
      disposition: "not_grandfathered_no_cutover",
      reason:
        "Script has no usable creation timestamp, so it cannot be shown to predate the " +
        "enforcement cutover. Re-evaluate it to give it a real verdict.",
      scriptCreatedAt: null,
      cutoverAt: cutoverIso,
    };
  }

  if (createdAt!.getTime() < cutover.getTime()) {
    return {
      grandfathered: true,
      disposition: "grandfathered_pre_enforcement",
      reason:
        `Script was created ${createdIso}, before the editorial-gate enforcement cutover ` +
        `${cutoverIso}. Allowed once under the rollout policy WITHOUT a quality verdict. ` +
        `Re-evaluate it to replace this allowance with a real verdict.`,
      scriptCreatedAt: createdIso,
      cutoverAt: cutoverIso,
    };
  }

  return {
    grandfathered: false,
    disposition: "not_grandfathered_after_cutover",
    reason:
      `Script was created ${createdIso}, at or after the enforcement cutover ${cutoverIso}, ` +
      `so it must carry an editorial verdict. A script written after the cutover with no ` +
      `verdict means the generation pipeline did not evaluate it — that is a defect, not a rollout gap.`,
    scriptCreatedAt: createdIso,
    cutoverAt: cutoverIso,
  };
}
