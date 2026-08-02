import type { CombinedQualityReport, JudgeAxis } from "./scriptQualityJudge";
import type { InvariantReport } from "./productionInvariants";

export type ScriptEditorialGateMode = "off" | "observe" | "hold";
export type ScriptEditorialDecision = "pass" | "review" | "hold";

export const CRITICAL_EDITORIAL_AXES: JudgeAxis[] = [
  "hostDistinctness",
  "characterConsistency",
  "conversationalCausality",
  "spokenNaturalness",
  "argumentProgression",
  "emotionalProgression",
  "closingPayoff",
  "singleModelSmell",
  // Added after episode e7867729: the judge scored these acceptably while the
  // transcript restated the same proposition in every segment and leaned on the
  // same handful of evidence figures. They are critical, not decorative.
  "repetition",
  "evidenceGrounding",
  "mechanicalAlternation",
];

/**
 * How the script was actually produced. `path` is observed, never inferred from
 * environment variables — an episode that fell back to single-shot generation
 * must not be able to claim that private agendas or a cold-open tournament ran.
 */
export interface ScriptPipelineProvenance {
  path?: "outline_driven" | "single_shot_fallback" | string;
  fallbackReason?: string | null;
  stages?: Array<{ name: string; status: "ok" | "failed" | "skipped"; detail?: string }>;
  privateAgendaCount?: number;
  coldOpenTournamentRan?: boolean;
  characterWriterPassesRan?: number;
  judgeRan?: boolean;
}

/**
 * A recorded, attributable human decision to release a script that the gate did
 * not pass on its own. This replaces the old SCRIPT_EDITORIAL_HOLD_OVERRIDE env
 * flag: a hold must be cleared by a person against the specific reasons they
 * read, not by a process-wide boolean nobody can audit after the fact.
 */
export interface HumanReleaseRecord {
  approvedBy: string;
  approvedAt: string;
  /** The decision the approver actually saw. A later, worse verdict re-blocks. */
  approvedDecision: ScriptEditorialDecision;
  /** The reason strings the approver acknowledged. */
  acknowledgedReasons: string[];
  note?: string;
}

export interface ScriptEditorialGateResult {
  mode: ScriptEditorialGateMode;
  decision: ScriptEditorialDecision;
  /** True when this verdict must not advance to TTS without a human. */
  downstreamBlocked: boolean;
  reasons: string[];
  /** Axes that failed on their own merit and cannot be averaged away. */
  failedCriticalAxes: string[];
  provenance?: ScriptPipelineProvenance;
  thresholds: {
    deterministicReview: number;
    deterministicHold: number;
    judgeReview: number;
    judgeHold: number;
    criticalAxisReview: number;
    criticalAxisHold: number;
  };
  evaluatedAt: string;
}

export interface GateEvaluationExtras {
  /** Deterministic listener-facing invariants (cold open, alternation, …). */
  invariants?: InvariantReport | null;
  /** Observed pipeline provenance. */
  provenance?: ScriptPipelineProvenance | null;
}

function isProduction(env: NodeJS.ProcessEnv): boolean {
  return env.NODE_ENV === "production";
}

function numberFromEnv(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
  min: number,
  max: number
): number {
  const parsed = Number(env[key]);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

export function resolveScriptEditorialGateMode(
  env: NodeJS.ProcessEnv = process.env
): ScriptEditorialGateMode {
  const raw = (env.SCRIPT_EDITORIAL_GATE_MODE || "").trim().toLowerCase();
  if (raw === "off" || raw === "observe" || raw === "hold") return raw;
  return env.NODE_ENV === "production" ? "hold" : "observe";
}

export function evaluateScriptEditorialGate(
  report: CombinedQualityReport,
  env: NodeJS.ProcessEnv = process.env,
  extras: GateEvaluationExtras = {}
): ScriptEditorialGateResult {
  const mode = resolveScriptEditorialGateMode(env);
  const failedCriticalAxes: string[] = [];
  const thresholds = {
    deterministicReview: numberFromEnv(env, "SCRIPT_EDITORIAL_DETERMINISTIC_REVIEW", 72, 0, 100),
    deterministicHold: numberFromEnv(env, "SCRIPT_EDITORIAL_DETERMINISTIC_HOLD", 50, 0, 100),
    judgeReview: numberFromEnv(env, "SCRIPT_EDITORIAL_JUDGE_REVIEW", 78, 0, 100),
    judgeHold: numberFromEnv(env, "SCRIPT_EDITORIAL_JUDGE_HOLD", 60, 0, 100),
    criticalAxisReview: numberFromEnv(env, "SCRIPT_EDITORIAL_AXIS_REVIEW", 7, 0, 10),
    criticalAxisHold: numberFromEnv(env, "SCRIPT_EDITORIAL_AXIS_HOLD", 4.5, 0, 10),
  };

  const reviewReasons: string[] = [];
  const holdReasons: string[] = [];
  const deterministic = report.deterministic.total;

  if (deterministic < thresholds.deterministicHold) {
    holdReasons.push(
      `Deterministic script quality ${deterministic}/100 is below the ${thresholds.deterministicHold} hold floor.`
    );
  } else if (deterministic < thresholds.deterministicReview) {
    reviewReasons.push(
      `Deterministic script quality ${deterministic}/100 is below the ${thresholds.deterministicReview} editorial target.`
    );
  }

  if (!report.judge) {
    // In production a missing independent judge is a HOLD, not a note. The old
    // behaviour downgraded a judge outage to "review", and because "review" did
    // not block anything, an outage silently disabled the entire gate.
    const msg = `Independent quality judge did not produce a verdict${report.judgeError ? `: ${report.judgeError}` : "."}`;
    if (isProduction(env)) {
      holdReasons.push(`${msg} A script cannot be released without an independent judgement.`);
      failedCriticalAxes.push("independentJudge");
    } else {
      reviewReasons.push(msg);
    }
  } else {
    if (report.judge.bothHostsSoundLikeOneModel) {
      holdReasons.push("Independent judge says both hosts sound like one underlying model wearing two labels.");
    }
    if (report.judge.overall < thresholds.judgeHold) {
      holdReasons.push(
        `Independent judge score ${report.judge.overall}/100 is below the ${thresholds.judgeHold} hold floor.`
      );
    } else if (report.judge.overall < thresholds.judgeReview) {
      reviewReasons.push(
        `Independent judge score ${report.judge.overall}/100 is below the ${thresholds.judgeReview} editorial target.`
      );
    }

    for (const axis of CRITICAL_EDITORIAL_AXES) {
      const score = report.judge.axes[axis];
      if (score < thresholds.criticalAxisHold) {
        failedCriticalAxes.push(axis);
        holdReasons.push(
          `${axis} scored ${score.toFixed(1)}/10, below the ${thresholds.criticalAxisHold.toFixed(1)} hold floor.`
        );
      } else if (score < thresholds.criticalAxisReview) {
        reviewReasons.push(
          `${axis} scored ${score.toFixed(1)}/10, below the ${thresholds.criticalAxisReview.toFixed(1)} editorial target.`
        );
      }
    }
  }

  // --- Deterministic invariants ------------------------------------------
  // These are measurements, not opinions, so they are evaluated independently
  // of the judge's aggregate. A 233-word cold open is a hold whether or not the
  // judge liked the writing.
  const invariants = extras.invariants;
  if (invariants) {
    for (const finding of invariants.findings) {
      if (finding.severity === "hold") {
        failedCriticalAxes.push(finding.axis);
        holdReasons.push(finding.message);
      } else if (finding.severity === "review") {
        reviewReasons.push(finding.message);
      }
    }
  } else if (isProduction(env)) {
    holdReasons.push("Deterministic production invariants did not run; a script cannot be released unmeasured.");
    failedCriticalAxes.push("invariantsMissing");
  }

  // --- Pipeline provenance ------------------------------------------------
  // A script produced by the emergency single-shot fallback did not get an
  // outline, private agendas, a cold-open tournament, or character-separated
  // writing. It may exist for availability, but it may not publish itself.
  const provenance = extras.provenance ?? undefined;
  if (provenance) {
    if (provenance.path && provenance.path !== "outline_driven") {
      holdReasons.push(
        `Script was produced by the ${provenance.path} path` +
          `${provenance.fallbackReason ? ` (${provenance.fallbackReason})` : ""}. ` +
          `Fallback output requires human inspection before production.`
      );
      failedCriticalAxes.push("creativePipelinePath");
    }
    const failedStages = (provenance.stages || []).filter((s) => s.status === "failed");
    if (failedStages.length) {
      holdReasons.push(
        `Creative stage(s) failed: ${failedStages.map((s) => `${s.name}${s.detail ? ` (${s.detail})` : ""}`).join("; ")}.`
      );
      failedCriticalAxes.push("creativeStageFailure");
    }
  } else if (isProduction(env)) {
    holdReasons.push("Script carries no pipeline provenance; production cannot verify how it was written.");
    failedCriticalAxes.push("provenanceMissing");
  }

  const decision: ScriptEditorialDecision =
    holdReasons.length > 0 ? "hold" : reviewReasons.length > 0 ? "review" : "pass";

  // A "review" verdict now blocks AUTOMATIC downstream production. It does not
  // mean "ship it and mention it" — it means a human decides. Only "pass"
  // continues on its own.
  // Only "hold" mode actually stops production; "observe" records the verdict
  // for staging and local work without gating it.
  const downstreamBlocked = mode === "hold" && decision !== "pass";

  return {
    mode,
    decision,
    downstreamBlocked,
    reasons: [...holdReasons, ...reviewReasons],
    failedCriticalAxes: Array.from(new Set(failedCriticalAxes)),
    provenance,
    thresholds,
    evaluatedAt: new Date().toISOString(),
  };
}

export interface DownstreamBlockVerdict {
  blocked: boolean;
  decision: ScriptEditorialDecision | "unknown";
  reasons: string[];
  failedCriticalAxes: string[];
  /** Set when a recorded human release cleared an otherwise blocking verdict. */
  releasedBy?: string;
  /** Set when the editorial-gate rollout policy was consulted for this script.
   *  Present on both grandfathered passes and refusals, so an operator can see
   *  exactly what was compared. Typed loosely here to keep this module free of
   *  a queue-layer import. */
  rollout?: {
    grandfathered: boolean;
    disposition: string;
    reason: string;
    scriptCreatedAt: string | null;
    cutoverAt: string | null;
  };
}

const DECISION_RANK: Record<ScriptEditorialDecision, number> = { pass: 0, review: 1, hold: 2 };

/**
 * The single source of truth for "may this script spend TTS money".
 *
 * Two things changed after episode e7867729:
 *  1. `review` blocks. Previously only `hold` blocked, and `review` was what a
 *     script got whenever the judge was unavailable — so the common failure
 *     mode produced a verdict that stopped nothing.
 *  2. A hold is cleared by a recorded, attributable human release stored on the
 *     script itself, not by SCRIPT_EDITORIAL_HOLD_OVERRIDE=true. A process-wide
 *     env flag cleared every hold at once and left no audit trail.
 */
export function evaluateDownstreamBlock(
  content: unknown,
  env: NodeJS.ProcessEnv = process.env
): DownstreamBlockVerdict {
  const blob = content as {
    editorialGate?: Partial<ScriptEditorialGateResult>;
    humanRelease?: Partial<HumanReleaseRecord>;
  } | null;
  const gate = blob?.editorialGate;
  const mode = resolveScriptEditorialGateMode(env);

  if (mode === "off") {
    return { blocked: false, decision: gate?.decision ?? "unknown", reasons: [], failedCriticalAxes: [] };
  }

  if (!gate || !gate.decision) {
    // No verdict at all is not a pass. In production an unmeasured script is
    // exactly the thing this gate exists to stop.
    const blocked = isProduction(env);
    return {
      blocked,
      decision: "unknown",
      reasons: blocked ? ["Script carries no editorial gate verdict; it has never been evaluated."] : [],
      failedCriticalAxes: [],
    };
  }

  const decision = gate.decision;
  const reasons = Array.isArray(gate.reasons) ? gate.reasons : [];
  const failedCriticalAxes = Array.isArray(gate.failedCriticalAxes) ? gate.failedCriticalAxes : [];

  if (decision === "pass") {
    return { blocked: false, decision, reasons: [], failedCriticalAxes };
  }

  // Observe mode reports but does not stop production. It exists for local and
  // staging work; production resolves to "hold" mode by default.
  if (mode === "observe") {
    return { blocked: false, decision, reasons, failedCriticalAxes };
  }

  const release = blob?.humanRelease;
  if (
    release?.approvedBy &&
    release.approvedDecision &&
    DECISION_RANK[release.approvedDecision] >= DECISION_RANK[decision]
  ) {
    return { blocked: false, decision, reasons, failedCriticalAxes, releasedBy: release.approvedBy };
  }

  return { blocked: true, decision, reasons, failedCriticalAxes };
}

/** Back-compatible boolean form. */
export function editorialGateBlocksDownstream(
  content: unknown,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return evaluateDownstreamBlock(content, env).blocked;
}
