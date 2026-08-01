import type { CombinedQualityReport, JudgeAxis } from "./scriptQualityJudge";

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
];

export interface ScriptEditorialGateResult {
  mode: ScriptEditorialGateMode;
  decision: ScriptEditorialDecision;
  downstreamBlocked: boolean;
  reasons: string[];
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
  env: NodeJS.ProcessEnv = process.env
): ScriptEditorialGateResult {
  const mode = resolveScriptEditorialGateMode(env);
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
    reviewReasons.push(
      `Independent quality judge did not produce a verdict${report.judgeError ? `: ${report.judgeError}` : "."}`
    );
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

  const decision: ScriptEditorialDecision =
    holdReasons.length > 0 ? "hold" : reviewReasons.length > 0 ? "review" : "pass";
  return {
    mode,
    decision,
    downstreamBlocked: mode === "hold" && decision === "hold",
    reasons: [...holdReasons, ...reviewReasons],
    thresholds,
    evaluatedAt: new Date().toISOString(),
  };
}

export function editorialGateBlocksDownstream(
  content: unknown,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  const gate = (content as { editorialGate?: Partial<ScriptEditorialGateResult> } | null)?.editorialGate;
  if (!gate || gate.decision !== "hold") return false;
  if (env.SCRIPT_EDITORIAL_HOLD_OVERRIDE === "true") return false;
  return resolveScriptEditorialGateMode(env) === "hold";
}
