// BLIND MODEL EVALUATION on our own material.
//
// WHY THIS EXISTS. Every routing decision in this repository has, at some point,
// been made from a vibe: a model was "the best one", or a variable named
// SCRIPT_LLM_MODEL was read as authorisation to put one model in nine chairs.
// Neither is evidence. A public benchmark is not evidence either — none of them
// measure whether two sports hosts sound like different people for forty-five
// seconds, which is the only thing this show is actually trying to do.
//
// So the rule this module enforces is narrow and absolute: A MODEL IS PROMOTED
// ONLY FROM STORED, BLIND RESULTS ON OUR FIXTURES. Not from a leaderboard, not
// from a release announcement, not from one impressive sample. `decidePromotion`
// takes stored records and nothing else, and there is no model name anywhere in
// this file — by construction it cannot prefer a vendor.
//
// TEN DIMENSIONS, SPLIT BY HOW THEY ARE KNOWN:
//
//   DETERMINISTIC   host distinctness, factual support, repetition — computed
//                   from the script by the same code production uses. No judge,
//                   no variance, no opinion.
//   MEASURED        estimated cost, latency — read off the cost ledger and the
//                   clock. Facts about the run.
//   JUDGED          story selection, opening strength, spoken naturalness,
//                   argumentative progression, character consistency — scored by
//                   an LLM judge that is shown ANONYMISED, SHUFFLED candidates
//                   and is never told which model produced what.
//
// The split matters. A harness where a judge scores all ten lets one model's
// prose style carry dimensions that are supposed to be counted, and the
// deterministic three are exactly the ones a persuasive writer would otherwise
// talk its way past.

import { createHash } from "node:crypto";

// ---------------------------------------------------------------- dimensions

export type EvaluationDimension =
  | "story_selection"
  | "opening_strength"
  | "host_distinctness"
  | "spoken_naturalness"
  | "argumentative_progression"
  | "factual_support"
  | "repetition"
  | "character_consistency"
  | "estimated_cost"
  | "latency";

export type DimensionKind = "deterministic" | "measured" | "judged";

export interface DimensionSpec {
  key: EvaluationDimension;
  label: string;
  kind: DimensionKind;
  /** True when a HIGHER raw value is better. Cost and latency are inverted. */
  higherIsBetter: boolean;
  /**
   * Weight in the quality composite. Cost and latency are deliberately ZERO:
   * they are constraints, not quality, and a cheap fast model that writes badly
   * must never out-score a good one on a weighted average. They gate instead —
   * see `PromotionRules`.
   */
  weight: number;
  /** What this dimension is actually asking. Shown to the blind judge verbatim. */
  question: string;
}

export const DIMENSIONS: readonly DimensionSpec[] = [
  {
    key: "story_selection",
    label: "Story selection quality",
    kind: "judged",
    higherIsBetter: true,
    weight: 1,
    question:
      "Is the chosen angle the strongest available one for a debate — a genuine unresolved question with real stakes — rather than the most obvious summary of the evidence?",
  },
  {
    key: "opening_strength",
    label: "Opening strength",
    kind: "judged",
    higherIsBetter: true,
    weight: 2,
    question:
      "Do the first forty-five seconds start mid-argument with an open loop and a concrete stake, with no greeting, no show description and no throat-clearing?",
  },
  {
    key: "host_distinctness",
    label: "Host distinctness",
    kind: "deterministic",
    higherIsBetter: true,
    weight: 2,
    question: "",
  },
  {
    key: "spoken_naturalness",
    label: "Spoken naturalness",
    kind: "judged",
    higherIsBetter: true,
    weight: 2,
    question:
      "Does this read as speech a person would actually say aloud — interruptions, incomplete thoughts, contractions — rather than prose read out?",
  },
  {
    key: "argumentative_progression",
    label: "Argumentative progression",
    kind: "judged",
    higherIsBetter: true,
    weight: 2,
    question:
      "Does the argument MOVE — each turn responding to the last, positions shifting under pressure — rather than two people restating fixed views?",
  },
  {
    key: "factual_support",
    label: "Factual support",
    kind: "deterministic",
    higherIsBetter: true,
    weight: 2,
    question: "",
  },
  {
    key: "repetition",
    label: "Freedom from repetition",
    kind: "deterministic",
    higherIsBetter: true,
    weight: 1,
    question: "",
  },
  {
    key: "character_consistency",
    label: "Character consistency",
    kind: "judged",
    higherIsBetter: true,
    weight: 2,
    question:
      "Does each host stay the person the brief describes — same instincts, same speech shape, same blind spots — from first line to last?",
  },
  {
    key: "estimated_cost",
    label: "Estimated cost (USD)",
    kind: "measured",
    higherIsBetter: false,
    weight: 0,
    question: "",
  },
  {
    key: "latency",
    label: "Latency (ms)",
    kind: "measured",
    higherIsBetter: false,
    weight: 0,
    question: "",
  },
] as const;

export const JUDGED_DIMENSIONS = DIMENSIONS.filter((d) => d.kind === "judged");
export const QUALITY_DIMENSIONS = DIMENSIONS.filter((d) => d.weight > 0);

// ---------------------------------------------------------------- records

/** One candidate's result on one fixture. Scores are 0-100 except the measured pair. */
export interface CandidateFixtureResult {
  /** provider/model. NEVER shown to the judge. */
  candidate: string;
  fixtureKey: string;
  /** The anonymous name the judge saw, kept so a verdict can be re-checked. */
  blindLabel: string;
  scores: Partial<Record<EvaluationDimension, number>>;
  /** Populated when this candidate failed on this fixture. A failure is a
   *  RESULT — never a missing row, never a zero pretending to be a score. */
  failure: string | null;
  latencyMs: number;
  estimatedCostUsd: number | null;
  tokensIn: number;
  tokensOut: number;
}

export interface EvaluationRun {
  runId: string;
  ranAt: string;
  /** Digest of the fixture material, so two runs are only comparable when they
   *  used the same inputs. This is what stops "we changed the fixtures and the
   *  new model got better". */
  fixtureDigest: string;
  /** The route being compared against. */
  incumbent: string;
  candidates: string[];
  results: CandidateFixtureResult[];
  /** The judge's own route, recorded so a judge that shares a provider with a
   *  candidate is visible when the table is read. */
  judge: string;
  judgeIndependentOfCandidates: boolean;
  notes: string[];
}

// ---------------------------------------------------------------- blinding

/**
 * Stable anonymous labels, assigned by a digest of (runId, candidate).
 *
 * Deterministic so a run can be replayed and audited, and order-independent so
 * "Candidate A" is not simply whoever was configured first — which would leak
 * the incumbent to a judge that has seen one of these tables before.
 */
export function assignBlindLabels(runId: string, candidates: string[]): Map<string, string> {
  const ordered = [...candidates].sort((a, b) => {
    const ha = createHash("sha256").update(`${runId}|${a}`).digest("hex");
    const hb = createHash("sha256").update(`${runId}|${b}`).digest("hex");
    return ha < hb ? -1 : ha > hb ? 1 : a.localeCompare(b);
  });
  const labels = new Map<string, string>();
  ordered.forEach((candidate, i) => labels.set(candidate, `Candidate ${String.fromCharCode(65 + i)}`));
  return labels;
}

/**
 * Everything that could identify the model behind a script.
 *
 * Provider and model names leak through generated text more often than one
 * would hope — a model that mentions its own name in an aside, a stray
 * "As an AI" — and one leak turns a blind comparison into a branded one.
 */
export function scrubCandidateIdentity(text: string, candidates: string[]): string {
  let out = String(text ?? "");
  const tokens = new Set<string>();
  for (const candidate of candidates) {
    for (const part of candidate.split(/[/:@\s-]+/)) {
      if (part.length >= 3) tokens.add(part);
    }
  }
  for (const token of [...tokens].sort((a, b) => b.length - a.length)) {
    out = out.replace(new RegExp(escapeRegExp(token), "gi"), "[redacted-model]");
  }
  return out;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------- aggregation

export interface CandidateSummary {
  candidate: string;
  /** Weighted 0-100 over the quality dimensions. Null when nothing completed. */
  qualityComposite: number | null;
  perDimension: Partial<Record<EvaluationDimension, number>>;
  fixturesAttempted: number;
  fixturesCompleted: number;
  failures: string[];
  medianLatencyMs: number | null;
  totalEstimatedCostUsd: number | null;
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function mean(values: number[]): number | null {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

/**
 * Roll a run up per candidate.
 *
 * A candidate that FAILED a fixture does not get that fixture averaged away:
 * `fixturesCompleted` is reported next to `fixturesAttempted`, and the promotion
 * rules refuse a candidate that did not complete everything. A model that writes
 * beautifully two times in three is not a model this pipeline can use.
 */
export function summarizeRun(run: EvaluationRun): CandidateSummary[] {
  return run.candidates.map((candidate) => {
    const rows = run.results.filter((r) => r.candidate === candidate);
    const completed = rows.filter((r) => !r.failure);

    const perDimension: Partial<Record<EvaluationDimension, number>> = {};
    for (const dim of DIMENSIONS) {
      const values = completed
        .map((r) => r.scores[dim.key])
        .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
      const avg = mean(values);
      if (avg !== null) perDimension[dim.key] = avg;
    }

    let composite: number | null = null;
    const weighted = QUALITY_DIMENSIONS.filter((d) => typeof perDimension[d.key] === "number");
    if (completed.length && weighted.length === QUALITY_DIMENSIONS.length) {
      const totalWeight = weighted.reduce((sum, d) => sum + d.weight, 0);
      composite = weighted.reduce((sum, d) => sum + perDimension[d.key]! * d.weight, 0) / totalWeight;
    }

    const costs = completed.map((r) => r.estimatedCostUsd).filter((v): v is number => typeof v === "number");
    return {
      candidate,
      qualityComposite: composite,
      perDimension,
      fixturesAttempted: rows.length,
      fixturesCompleted: completed.length,
      failures: rows.filter((r) => r.failure).map((r) => `${r.fixtureKey}: ${r.failure}`),
      medianLatencyMs: median(completed.map((r) => r.latencyMs)),
      totalEstimatedCostUsd: costs.length ? costs.reduce((a, b) => a + b, 0) : null,
    };
  });
}

// ---------------------------------------------------------------- promotion

export interface PromotionRules {
  /** Distinct stored runs required before any promotion is considered. */
  minRuns: number;
  /** Fixtures each candidate must have completed, per run. */
  minFixturesPerRun: number;
  /** Composite points the challenger must beat the incumbent by. Guards against
   *  promoting on judge noise. */
  minCompositeMargin: number;
  /** Points a challenger may regress on ANY single quality dimension. */
  maxDimensionRegression: number;
  /** Multiple of the incumbent's median latency the challenger may not exceed. */
  maxLatencyMultiple: number;
  /** Multiple of the incumbent's cost the challenger may not exceed. */
  maxCostMultiple: number;
}

/**
 * Deliberately strict.
 *
 * The cost of NOT promoting is that a good model waits for more evidence. The
 * cost of promoting wrongly is a season of episodes that are worse in a way
 * nobody notices until a listener does. Those are not symmetrical, so the bar
 * sits well above "scored higher once".
 */
export const DEFAULT_PROMOTION_RULES: PromotionRules = {
  minRuns: 2,
  minFixturesPerRun: 3,
  minCompositeMargin: 3,
  maxDimensionRegression: 5,
  maxLatencyMultiple: 1.5,
  maxCostMultiple: 1.5,
};

export interface PromotionDecision {
  promote: boolean;
  challenger: string | null;
  incumbent: string;
  /** Every reason the decision went the way it did. Always populated. */
  reasons: string[];
  /** What is still missing, when the answer is "not yet". */
  evidenceGaps: string[];
  compositeDelta: number | null;
  regressions: Array<{ dimension: EvaluationDimension; incumbent: number; challenger: number; delta: number }>;
}

/**
 * Decide whether a challenger may take a role — FROM STORED RESULTS ONLY.
 *
 * The signature is the guarantee: `runs` is the only input carrying any claim
 * about quality. There is no model list, no vendor preference and no benchmark
 * table in this function, so a promotion that happens here happened because of
 * something this show measured on its own material.
 */
export function decidePromotion(
  runs: EvaluationRun[],
  incumbent: string,
  rules: PromotionRules = DEFAULT_PROMOTION_RULES
): PromotionDecision {
  const reasons: string[] = [];
  const evidenceGaps: string[] = [];

  const usable = runs.filter((run) => run.candidates.includes(incumbent));
  if (usable.length < rules.minRuns) {
    evidenceGaps.push(
      `${usable.length} stored run(s) include the incumbent; ${rules.minRuns} are required. ` +
        `A single run is one sample of a noisy judge.`
    );
  }

  // Runs that used DIFFERENT fixture material cannot be pooled: a comparison
  // across changed inputs measures the inputs.
  const digests = new Set(usable.map((r) => r.fixtureDigest));
  if (digests.size > 1) {
    evidenceGaps.push(
      `Stored runs used ${digests.size} different fixture sets. Results are only comparable within one set — ` +
        `re-run the challengers against the current fixtures.`
    );
  }

  const captured = usable.filter((r) => !r.judgeIndependentOfCandidates);
  if (captured.length) {
    evidenceGaps.push(
      `${captured.length} run(s) were scored by a judge sharing a provider with a candidate. ` +
        `A lab grading its own model is not evidence for promoting it.`
    );
  }

  // Pool per candidate across runs.
  const summaries = new Map<string, CandidateSummary[]>();
  for (const run of usable) {
    for (const summary of summarizeRun(run)) {
      const list = summaries.get(summary.candidate) ?? [];
      list.push(summary);
      summaries.set(summary.candidate, list);
    }
  }

  const incumbentRuns = summaries.get(incumbent) ?? [];
  const incumbentComposite = mean(
    incumbentRuns.map((s) => s.qualityComposite).filter((v): v is number => v !== null)
  );
  if (incumbentComposite === null) {
    evidenceGaps.push(`The incumbent (${incumbent}) has no complete result to compare against.`);
  }

  // Rank challengers by pooled composite. Highest first; ties broken by latency.
  const challengers = [...summaries.entries()]
    .filter(([candidate]) => candidate !== incumbent)
    .map(([candidate, list]) => {
      const composite = mean(list.map((s) => s.qualityComposite).filter((v): v is number => v !== null));
      const latency = mean(list.map((s) => s.medianLatencyMs).filter((v): v is number => v !== null));
      const cost = mean(list.map((s) => s.totalEstimatedCostUsd).filter((v): v is number => v !== null));
      const incomplete = list.filter((s) => s.fixturesCompleted < rules.minFixturesPerRun);
      const perDimension: Partial<Record<EvaluationDimension, number>> = {};
      for (const dim of QUALITY_DIMENSIONS) {
        const avg = mean(list.map((s) => s.perDimension[dim.key]).filter((v): v is number => typeof v === "number"));
        if (avg !== null) perDimension[dim.key] = avg;
      }
      return { candidate, composite, latency, cost, incomplete, perDimension, list };
    })
    .sort((a, b) => (b.composite ?? -1) - (a.composite ?? -1));

  const best = challengers[0];
  if (!best) {
    evidenceGaps.push("No challenger appears in the stored runs.");
  }

  if (evidenceGaps.length || !best || incumbentComposite === null || best.composite === null) {
    reasons.push("Not promoting: the stored evidence does not meet the bar.");
    return {
      promote: false,
      challenger: best?.candidate ?? null,
      incumbent,
      reasons,
      evidenceGaps,
      compositeDelta: best?.composite !== null && best?.composite !== undefined && incumbentComposite !== null
        ? best.composite - incumbentComposite
        : null,
      regressions: [],
    };
  }

  const delta = best.composite - incumbentComposite;

  // Incumbent per-dimension pooled, for the regression check.
  const incumbentPerDimension: Partial<Record<EvaluationDimension, number>> = {};
  for (const dim of QUALITY_DIMENSIONS) {
    const avg = mean(
      incumbentRuns.map((s) => s.perDimension[dim.key]).filter((v): v is number => typeof v === "number")
    );
    if (avg !== null) incumbentPerDimension[dim.key] = avg;
  }

  const regressions = QUALITY_DIMENSIONS.map((dim) => {
    const inc = incumbentPerDimension[dim.key];
    const chal = best.perDimension[dim.key];
    if (typeof inc !== "number" || typeof chal !== "number") return null;
    return { dimension: dim.key, incumbent: inc, challenger: chal, delta: chal - inc };
  })
    .filter((r): r is NonNullable<typeof r> => r !== null)
    .filter((r) => r.delta < -rules.maxDimensionRegression);

  const blockers: string[] = [];
  if (best.incomplete.length) {
    blockers.push(
      `${best.candidate} did not complete ${rules.minFixturesPerRun} fixture(s) in ` +
        `${best.incomplete.length} run(s). A model that fails one fixture in three cannot hold a role.`
    );
  }
  if (delta < rules.minCompositeMargin) {
    blockers.push(
      `${best.candidate} leads by ${delta.toFixed(1)} composite point(s); ${rules.minCompositeMargin} are required. ` +
        `Anything smaller is inside judge noise.`
    );
  }
  for (const r of regressions) {
    blockers.push(
      `${best.candidate} regresses ${Math.abs(r.delta).toFixed(1)} point(s) on ${r.dimension} ` +
        `(${r.incumbent.toFixed(1)} → ${r.challenger.toFixed(1)}); the limit is ${rules.maxDimensionRegression}.`
    );
  }

  const incumbentLatency = mean(
    incumbentRuns.map((s) => s.medianLatencyMs).filter((v): v is number => v !== null)
  );
  if (incumbentLatency !== null && best.latency !== null && best.latency > incumbentLatency * rules.maxLatencyMultiple) {
    blockers.push(
      `${best.candidate} is ${(best.latency / incumbentLatency).toFixed(2)}x the incumbent's latency; ` +
        `the ceiling is ${rules.maxLatencyMultiple}x. Movements are sequential, so latency compounds per episode.`
    );
  }

  const incumbentCost = mean(
    incumbentRuns.map((s) => s.totalEstimatedCostUsd).filter((v): v is number => v !== null)
  );
  if (incumbentCost !== null && incumbentCost > 0 && best.cost !== null && best.cost > incumbentCost * rules.maxCostMultiple) {
    blockers.push(
      `${best.candidate} costs ${(best.cost / incumbentCost).toFixed(2)}x the incumbent; ` +
        `the ceiling is ${rules.maxCostMultiple}x.`
    );
  }

  if (blockers.length) {
    return {
      promote: false,
      challenger: best.candidate,
      incumbent,
      reasons: ["Not promoting.", ...blockers],
      evidenceGaps: [],
      compositeDelta: delta,
      regressions,
    };
  }

  return {
    promote: true,
    challenger: best.candidate,
    incumbent,
    reasons: [
      `${best.candidate} beats ${incumbent} by ${delta.toFixed(1)} composite point(s) across ` +
        `${usable.length} stored blind run(s) on identical fixtures, with no dimension regressing more than ` +
        `${rules.maxDimensionRegression} point(s), and within the latency and cost ceilings.`,
    ],
    evidenceGaps: [],
    compositeDelta: delta,
    regressions: [],
  };
}

/** Digest of the fixture material a run used. Two runs pool only if these match. */
export function fixtureDigest(material: unknown): string {
  return createHash("sha256").update(JSON.stringify(material)).digest("hex").slice(0, 16);
}

// ---------------------------------------------------------------- rendering

export function renderSummaryTable(run: EvaluationRun): string {
  const summaries = summarizeRun(run);
  const width = Math.max(...summaries.map((s) => s.candidate.length), 9);
  const header = `  ${"candidate".padEnd(width)}  composite  ${QUALITY_DIMENSIONS.map((d) => d.key.slice(0, 9).padStart(10)).join("")}  latency  cost`;
  const rows = summaries.map((s) => {
    const dims = QUALITY_DIMENSIONS.map((d) => {
      const v = s.perDimension[d.key];
      return (typeof v === "number" ? v.toFixed(0) : "—").padStart(10);
    }).join("");
    return (
      `  ${s.candidate.padEnd(width)}  ${(s.qualityComposite === null ? "—" : s.qualityComposite.toFixed(1)).padStart(9)}  ${dims}  ` +
      `${(s.medianLatencyMs === null ? "—" : `${Math.round(s.medianLatencyMs)}ms`).padStart(7)}  ` +
      `${s.totalEstimatedCostUsd === null ? "unpriced" : `$${s.totalEstimatedCostUsd.toFixed(4)}`}` +
      (s.fixturesCompleted < s.fixturesAttempted
        ? `  [${s.fixturesAttempted - s.fixturesCompleted} FAILED]`
        : "")
    );
  });
  return [header, ...rows].join("\n");
}
