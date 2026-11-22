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
  /** When present (real observations), replaces the signal-count rating for audienceDemand. */
  demandAssessment?: DemandAssessment;
}

export interface OpportunityResult {
  score: number;
  demand: ReturnType<typeof classifyDemand>;
  dimensions: Record<OpportunityDimension, ScoredDimension>;
}

// --- Demand from real observations ---------------------------------------------
//
// Two numbers, never merged:
//   confidence — how sure are we that the interest is real?  (independent
//                origins, source families, measured values, relevance, age)
//   strength   — how much interest, where metrics are comparable? Bucketed per
//                metric KIND. No traffic forecast, no invented volume.
// Verified-but-modest demand is high confidence + LOW strength. It is NOT the
// same as high demand, and it does not score like it.

export type DemandStrength = "NONE" | "LOW" | "MODERATE" | "HIGH" | "UNMEASURED";
export const DEMAND_METRIC_KINDS = ["RELATIVE_INTEREST", "ESTIMATED_VOLUME", "IMPRESSIONS", "VIEWS", "ENGAGEMENT", "DISCUSSION_ACTIVITY"] as const;

export interface ScoringObservation {
  id: string;
  metricKind: string;
  metricValue: number | null;
  sourceFamily: string;
  originKey: string;
  /** Topic relevance of this observation to the candidate, 0..1. */
  relevance: number;
  confidence: number;
  publishedAt?: string | Date | null;
  /** false = observed in a market the business doesn't serve. */
  geographyMatch?: boolean | null;
}

export interface DemandAssessment {
  confidence: number;
  strength: DemandStrength;
  label: DemandLabel;
  independentOrigins: number;
  families: number;
  measured: number;
  /** Shows already covering the topic (CONTENT_SUPPLY), when observed. */
  supply: number | null;
  observationIds: string[];
  reasons: string[];
}

/** Per-kind magnitude buckets [LOW→MODERATE, MODERATE→HIGH]. Starting editorial thresholds. */
const STRENGTH_BUCKETS: Record<string, [number, number]> = {
  VIEWS: [1_000, 50_000],
  ENGAGEMENT: [50, 2_000],
  DISCUSSION_ACTIVITY: [20, 150],
  IMPRESSIONS: [500, 20_000],
  ESTIMATED_VOLUME: [100, 5_000],
};
const STRENGTH_ORDER: DemandStrength[] = ["UNMEASURED", "NONE", "LOW", "MODERATE", "HIGH"];
const STRENGTH_VALUE: Record<DemandStrength, number> = { UNMEASURED: 0, NONE: 0, LOW: 0.35, MODERATE: 0.65, HIGH: 1 };

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function assessDemand(observations: ScoringObservation[], now: Date = new Date()): DemandAssessment {
  const reasons: string[] = [];
  const supplyObs = observations.filter((o) => o.metricKind === "CONTENT_SUPPLY" && o.relevance >= MIN_RELEVANCE && o.metricValue != null);
  const supply = supplyObs.length ? Math.max(...supplyObs.map((o) => o.metricValue!)) : null;
  const candidates = observations.filter((o) => (DEMAND_METRIC_KINDS as readonly string[]).includes(o.metricKind));
  const usable = candidates.filter((o) => o.relevance >= MIN_RELEVANCE && o.confidence >= 0.3 && o.geographyMatch !== false);
  const dropped = candidates.length - usable.length;
  if (dropped) reasons.push(`${dropped} observation(s) ignored as off-topic, low-confidence or outside the served markets.`);

  // One origin counts once: keep its strongest observation per metric kind.
  const byOrigin = new Map<string, ScoringObservation>();
  for (const o of usable) {
    const k = `${o.originKey}|${o.metricKind}`;
    const prev = byOrigin.get(k);
    if (!prev || (o.metricValue ?? -1) > (prev.metricValue ?? -1)) byOrigin.set(k, o);
  }
  const deduped = [...byOrigin.values()];
  const origins = new Set(deduped.map((o) => o.originKey)).size;
  const families = new Set(deduped.map((o) => o.sourceFamily)).size;
  const measured = deduped.filter((o) => o.metricValue != null).length;
  if (usable.length > deduped.length) reasons.push(`${usable.length - deduped.length} duplicate measurement(s) from shared origins collapsed.`);

  const ageFactor = (o: ScoringObservation) => {
    const t = o.publishedAt ? new Date(o.publishedAt).getTime() : NaN;
    if (!Number.isFinite(t)) return 0.8;
    const months = (now.getTime() - t) / (30 * 86_400_000);
    return months <= 24 ? 1 : months <= 48 ? 0.5 : 0.25;
  };
  let confidence = 0;
  if (deduped.length) {
    const avgQuality = deduped.reduce((s, o) => s + o.relevance * ageFactor(o) * Math.min(1, o.confidence), 0) / deduped.length;
    confidence = (1 - Math.exp(-origins / 3)) * (families >= 2 ? 1 : 0.7) * (0.5 + 0.5 * (measured / deduped.length)) * avgQuality;
  }
  confidence = Math.round(clamp01(confidence) * 100) / 100;

  let strength: DemandStrength = measured === 0 ? "UNMEASURED" : "NONE";
  for (const kind of Object.keys(STRENGTH_BUCKETS)) {
    const vals = deduped.filter((o) => o.metricKind === kind && o.metricValue != null).map((o) => o.metricValue!);
    if (!vals.length) continue;
    const [lo, hi] = STRENGTH_BUCKETS[kind];
    const m = median(vals);
    const s: DemandStrength = m >= hi ? "HIGH" : m >= lo ? "MODERATE" : m > 0 ? "LOW" : "NONE";
    if (STRENGTH_ORDER.indexOf(s) > STRENGTH_ORDER.indexOf(strength)) strength = s;
    reasons.push(`${kind.toLowerCase()}: median ${Math.round(m).toLocaleString("en-US")} across ${vals.length} independent item(s) → ${s}.`);
  }

  let label: DemandLabel = "INSUFFICIENT_EVIDENCE";
  if (origins >= 3 && families >= 2 && measured >= 2 && confidence >= 0.5) label = "VERIFIED_DEMAND";
  else if (origins >= 2) label = "PROMISING_DEMAND";
  else if (origins === 1) label = "EMERGING_OPPORTUNITY";
  reasons.unshift(`${origins} independent origin(s) across ${families} source famil${families === 1 ? "y" : "ies"}, ${measured} measured → confidence ${confidence}.`);

  return { confidence, strength, label, independentOrigins: origins, families, measured, supply, observationIds: deduped.map((o) => o.id), reasons };
}

/** audienceDemand rating: strength, discounted by how sure we are. Max 1 only for HIGH + certain. */
export function demandRating(a: DemandAssessment): number {
  return Math.round(STRENGTH_VALUE[a.strength] * (0.4 + 0.6 * a.confidence) * 100) / 100;
}

// --- Achieved Information Advantage (after research) ----------------------------
//
// Potential IAS rates what a topic COULD deliver. Achieved IAS is computed only
// from what the dossier actually established — verified claims, completed
// analyses with sourced or labelled inputs, distinct origins — so prose about
// an impressive analysis earns nothing until the analysis exists.

export interface AchievedInputs {
  verifiedClaims: number;
  independentOrigins: number;
  completedAnalyses: number; // worked examples / calculations with sourced or labelled-hypothetical inputs
  verifiedOriginalFindings: number;
  practicalApplications: number;
  specificityHits: number; // business-specific terms present in the premise/mechanisms
  /** Shows already covering the topic (CONTENT_SUPPLY); null = unknown. */
  supply: number | null;
  outstandingGaps: number;
}

export function scoreAchievedIas(x: AchievedInputs): IasResult {
  const r = (v: number, full: number) => clamp01(v / full);
  const dims: Record<IasDimension, RatedDimension> = {
    originalAnalysis: {
      rating: r(x.completedAnalyses + x.verifiedOriginalFindings, 3),
      justification: `${x.completedAnalyses} completed analysis/worked example(s), ${x.verifiedOriginalFindings} verified original finding(s).`,
      evidenceRefs: x.completedAnalyses ? ["dossier:analysis"] : [],
    },
    undercoveredKnowledge: {
      rating: x.supply == null ? 0.4 : x.supply <= 5 ? 1 : x.supply <= 20 ? 0.7 : x.supply < 50 ? 0.4 : 0.2,
      justification: x.supply == null ? "Podcast coverage not measured." : `${x.supply} existing podcast(s) match the topic terms.`,
      evidenceRefs: x.supply == null ? [] : ["observation:supply"],
    },
    industrySpecificity: {
      rating: r(x.specificityHits, 5),
      justification: `${x.specificityHits} business-specific term(s) carried through the research.`,
      evidenceRefs: x.specificityHits ? ["profile:terms"] : [],
    },
    practicalUsefulness: {
      rating: r(x.practicalApplications, 3),
      justification: `${x.practicalApplications} practical application(s) grounded in the research.`,
      evidenceRefs: x.practicalApplications ? ["dossier:applications"] : [],
    },
    evidenceSupportedDepth: {
      rating: r(x.verifiedClaims, 8) * (x.independentOrigins >= 3 ? 1 : x.independentOrigins === 2 ? 0.8 : 0.5) * (x.outstandingGaps > 3 ? 0.8 : 1),
      justification: `${x.verifiedClaims} verified claim(s) from ${x.independentOrigins} independent origin(s); ${x.outstandingGaps} open gap(s).`,
      evidenceRefs: x.verifiedClaims ? ["dossier:claims"] : [],
    },
  };
  return scoreInformationAdvantage(dims);
}

/**
 * MAPPING (documented so it isn't double counting):
 *   uniqueInformationAdvantage = IAS WITHOUT practicalUsefulness, rescaled 80 → 20.
 *   practicalListenerValue     = IAS practicalUsefulness rating × 20.
 * Practical usefulness is therefore counted once in the Opportunity Score.
 */
export function scoreOpportunity(input: OpportunityInput): OpportunityResult {
  const da = input.demandAssessment;
  const demand = da
    ? { label: da.label, usable: da.independentOrigins, families: da.families }
    : classifyDemand(input.signals);
  const iasNonPractical = input.ias.score - input.ias.dimensions.practicalUsefulness.points;
  const nonPracticalMax = 100 - IAS_WEIGHTS.practicalUsefulness;
  const demandR = da ? demandRating(da) : DEMAND_RATING[demand.label];
  const dimensions: Record<OpportunityDimension, ScoredDimension> = {
    audienceDemand: {
      points: Math.round(demandR * OPPORTUNITY_WEIGHTS.audienceDemand * 10) / 10,
      max: OPPORTUNITY_WEIGHTS.audienceDemand,
      rating: demandR,
      capped: false,
      justification: da
        ? `Strength ${da.strength}, confidence ${da.confidence} (${da.independentOrigins} independent origin(s), ${da.families} famil${da.families === 1 ? "y" : "ies"}).`
        : `${demand.label}: ${demand.usable} usable signal(s) across ${demand.families} source famil${demand.families === 1 ? "y" : "ies"}.`,
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
