// Business topic scoring (directive §10.6, §12, §13, §14).
//
// Two independent questions, two independent numbers:
//   1. How much real audience interest exists?   → demand label (evidence-counted)
//   2. How much unique value can we deliver?      → Information Advantage Score
// The 100-point Opportunity Score combines them with documented weights.
//
// The weights are STARTING EDITORIAL WEIGHTS, not fitted coefficients. Every
// dimension is persisted with its justification so a ranking can be explained
// and later recalibrated against real listener data.
//
// Anti-inflation rules enforced here, not in prompts:
//   * A dimension rated above 0.5 with no evidence refs and no analysis plan is
//     capped at 0.5 — a high score needs something behind it.
//   * Demand labels are COUNTED from signals, never asserted. One source family
//     (e.g. one viral thread, or ten threads on one forum) can't make "verified".
//   * Ranking can tilt toward the customer's goal; scores and gates cannot.

export const DEMAND_LABELS = ["VERIFIED_DEMAND", "PROMISING_DEMAND", "EMERGING_OPPORTUNITY", "INSUFFICIENT_EVIDENCE"] as const;
export type DemandLabel = (typeof DEMAND_LABELS)[number];

export const SOURCE_FAMILIES = ["search", "video", "podcast", "community", "publication", "first_party", "government"] as const;
export type SourceFamily = (typeof SOURCE_FAMILIES)[number];

/** The demand evidence contract (§10.6). Metrics that a source doesn't expose stay null. */
export interface DemandSignal {
  sourceName: string;
  sourceFamily: SourceFamily;
  sourceRef: string;
  researchDate: string;
  publishedDate: string | null;
  metricName: string;
  metricValue: number | null;
  measurementWindow: string;
  geography: string | null;
  audienceRelevance: number; // 0..1
  sourceConfidence: number; // 0..1
  interpretation: string;
  limitations: string;
}

export interface RatedDimension {
  rating: number; // 0..1
  justification: string;
  evidenceRefs: string[];
  /** A concrete analysis we WILL perform (e.g. "compute cost per placed policy from X and Y"). */
  analysisPlan?: string | null;
}

export interface ScoredDimension {
  points: number;
  max: number;
  rating: number;
  capped: boolean;
  justification: string;
}

const MIN_RELEVANCE = 0.4;

/** Count usable signals into a label. Pure. */
export function classifyDemand(signals: DemandSignal[]): { label: DemandLabel; usable: number; families: number } {
  const usable = signals.filter((s) => s.audienceRelevance >= MIN_RELEVANCE && s.sourceConfidence >= 0.3 && !!s.sourceRef);
  const families = new Set(usable.map((s) => s.sourceFamily)).size;
  const measured = usable.filter((s) => s.metricValue != null).length;
  let label: DemandLabel = "INSUFFICIENT_EVIDENCE";
  if (usable.length >= 3 && families >= 2 && measured >= 2) label = "VERIFIED_DEMAND";
  else if (usable.length >= 2) label = "PROMISING_DEMAND";
  else if (usable.length === 1) label = "EMERGING_OPPORTUNITY";
  return { label, usable: usable.length, families };
}

const DEMAND_RATING: Record<DemandLabel, number> = {
  VERIFIED_DEMAND: 1,
  PROMISING_DEMAND: 0.65,
  EMERGING_OPPORTUNITY: 0.35,
  INSUFFICIENT_EVIDENCE: 0,
};

function clamp01(n: number): number {
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
}

function scoreDimension(d: RatedDimension, max: number): ScoredDimension {
  let rating = clamp01(d.rating);
  const backed = d.evidenceRefs.length > 0 || !!d.analysisPlan?.trim();
  const capped = rating > 0.5 && !backed;
  if (capped) rating = 0.5;
  return { points: Math.round(rating * max * 10) / 10, max, rating, capped, justification: d.justification };
}

// --- Information Advantage (§12) -------------------------------------------

export const IAS_WEIGHTS = {
  originalAnalysis: 25,
  undercoveredKnowledge: 20,
  industrySpecificity: 20,
  practicalUsefulness: 20,
  evidenceSupportedDepth: 15,
} as const;
export type IasDimension = keyof typeof IAS_WEIGHTS;

export interface IasResult {
  score: number;
  dimensions: Record<IasDimension, ScoredDimension>;
}

export function scoreInformationAdvantage(input: Record<IasDimension, RatedDimension>): IasResult {
  const dimensions = {} as Record<IasDimension, ScoredDimension>;
  let total = 0;
  for (const key of Object.keys(IAS_WEIGHTS) as IasDimension[]) {
    dimensions[key] = scoreDimension(input[key], IAS_WEIGHTS[key]);
    total += dimensions[key].points;
  }
  return { score: Math.round(total), dimensions };
}

// --- Opportunity (§13) -------------------------------------------------------

export const OPPORTUNITY_WEIGHTS = {
  audienceDemand: 25,
  targetListenerFit: 15,
  uniqueInformationAdvantage: 20,
  practicalListenerValue: 20,
  timelinessOrEvergreen: 10,
  evidenceQuality: 10,
} as const;
export type OpportunityDimension = keyof typeof OPPORTUNITY_WEIGHTS;

export interface OpportunityInput {
  signals: DemandSignal[];
  ias: IasResult;
  targetListenerFit: RatedDimension;
  timelinessOrEvergreen: RatedDimension;
  evidenceQuality: RatedDimension;
}

export interface OpportunityResult {
  score: number;
  demand: ReturnType<typeof classifyDemand>;
  dimensions: Record<OpportunityDimension, ScoredDimension>;
}

/**
 * MAPPING (documented so it isn't double counting):
 *   uniqueInformationAdvantage = IAS WITHOUT practicalUsefulness, rescaled 80 → 20.
 *   practicalListenerValue     = IAS practicalUsefulness rating × 20.
 * Practical usefulness is therefore counted once in the Opportunity Score.
 */
export function scoreOpportunity(input: OpportunityInput): OpportunityResult {
  const demand = classifyDemand(input.signals);
  const iasNonPractical = input.ias.score - input.ias.dimensions.practicalUsefulness.points;
  const nonPracticalMax = 100 - IAS_WEIGHTS.practicalUsefulness;
  const dimensions: Record<OpportunityDimension, ScoredDimension> = {
    audienceDemand: {
      points: DEMAND_RATING[demand.label] * OPPORTUNITY_WEIGHTS.audienceDemand,
      max: OPPORTUNITY_WEIGHTS.audienceDemand,
      rating: DEMAND_RATING[demand.label],
      capped: false,
      justification: `${demand.label}: ${demand.usable} usable signal(s) across ${demand.families} source famil${demand.families === 1 ? "y" : "ies"}.`,
    },
    targetListenerFit: scoreDimension(input.targetListenerFit, OPPORTUNITY_WEIGHTS.targetListenerFit),
    uniqueInformationAdvantage: {
      points: Math.round((clamp01(iasNonPractical / nonPracticalMax) * OPPORTUNITY_WEIGHTS.uniqueInformationAdvantage) * 10) / 10,
      max: OPPORTUNITY_WEIGHTS.uniqueInformationAdvantage,
      rating: clamp01(iasNonPractical / nonPracticalMax),
      capped: false,
      justification: `Information Advantage ${input.ias.score}/100 (practical usefulness counted separately).`,
    },
    practicalListenerValue: {
      points: Math.round(input.ias.dimensions.practicalUsefulness.rating * OPPORTUNITY_WEIGHTS.practicalListenerValue * 10) / 10,
      max: OPPORTUNITY_WEIGHTS.practicalListenerValue,
      rating: input.ias.dimensions.practicalUsefulness.rating,
      capped: input.ias.dimensions.practicalUsefulness.capped,
      justification: input.ias.dimensions.practicalUsefulness.justification,
    },
    timelinessOrEvergreen: scoreDimension(input.timelinessOrEvergreen, OPPORTUNITY_WEIGHTS.timelinessOrEvergreen),
    evidenceQuality: scoreDimension(input.evidenceQuality, OPPORTUNITY_WEIGHTS.evidenceQuality),
  };
  const score = Math.round(Object.values(dimensions).reduce((s, d) => s + d.points, 0));
  return { score, demand, dimensions };
}

// --- Categories + gates (§14, §27) -------------------------------------------

export const TOPIC_CATEGORIES = ["TRENDING", "EVERGREEN", "INSIDER_INTELLIGENCE", "HIDDEN_OPPORTUNITY"] as const;
export type TopicCategory = (typeof TOPIC_CATEGORIES)[number];

/** Reasons a scored topic must be held rather than offered. Empty = may be offered. */
export function holdReasons(t: { categories: TopicCategory[]; opportunity: OpportunityResult; ias: IasResult }): string[] {
  const reasons: string[] = [];
  const label = t.opportunity.demand.label;
  if (t.categories.includes("TRENDING") && label !== "VERIFIED_DEMAND" && label !== "PROMISING_DEMAND") {
    reasons.push("Tagged trending without demand evidence to support it.");
  }
  if (t.categories.includes("INSIDER_INTELLIGENCE") && t.ias.score < 50) {
    reasons.push("Tagged insider intelligence but the Information Advantage is below 50.");
  }
  if (t.opportunity.dimensions.evidenceQuality.rating < 0.3) {
    reasons.push("Evidence quality too low to research an episode from.");
  }
  return reasons;
}

// --- Goal-based ranking -------------------------------------------------------

const TRAFFIC_GOALS = new Set(["Maximum relevant traffic", "Brand awareness", "Podcast monetization"]);
const DEPTH_GOALS = new Set(["Qualified lead generation", "Thought leadership", "Industry authority", "Strategic partnerships", "Recruiting"]);

/**
 * Order topics for a show's goal. Changes ORDER only — the stored scores and the
 * hold gate are identical for every goal. Held topics always sort last.
 */
export function rankForGoal<T extends { opportunity: OpportunityResult; ias: IasResult; held: boolean }>(topics: T[], goal: string): T[] {
  const tilt = (t: T) => {
    const base = t.opportunity.score;
    // Traffic goals count demand twice; depth goals add a quarter of the IAS.
    if (TRAFFIC_GOALS.has(goal)) return base + t.opportunity.dimensions.audienceDemand.points;
    if (DEPTH_GOALS.has(goal)) return base + 0.25 * t.ias.score;
    return base;
  };
  return [...topics].sort((a, b) => Number(a.held) - Number(b.held) || tilt(b) - tilt(a));
}
