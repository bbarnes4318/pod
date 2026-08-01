// Editorial story ranking — scores the story listeners cannot stop following,
// not merely the loudest headline. The LLM proposes the eight judgments; this
// module clamps, weights and explains them server-side so a model cannot invent
// its own scoring formula or hide a weak axis behind a dramatic title.

export const EDITORIAL_STORY_AXES = [
  "unresolvedUncertainty",
  "humanConsequence",
  "opposingInterpretations",
  "novelty",
  "revealPotential",
  "emotionalContradiction",
  "evidenceRichness",
  "positionChangePotential",
] as const;

export type EditorialStoryAxis = (typeof EDITORIAL_STORY_AXES)[number];
export type EditorialStoryScores = Record<EditorialStoryAxis, number>;

const WEIGHTS: Record<EditorialStoryAxis, number> = {
  unresolvedUncertainty: 0.17,
  humanConsequence: 0.17,
  opposingInterpretations: 0.14,
  novelty: 0.10,
  revealPotential: 0.13,
  emotionalContradiction: 0.11,
  evidenceRichness: 0.10,
  positionChangePotential: 0.08,
};

export interface EditorialStoryReport {
  total: number;
  axes: EditorialStoryScores;
  weakestAxes: EditorialStoryAxis[];
  holdReasons: string[];
}

function score(value: unknown, fallback = 45): number {
  const parsed = Number(value);
  return Math.max(0, Math.min(100, Number.isFinite(parsed) ? parsed : fallback));
}

export function scoreEditorialStory(input: Partial<Record<EditorialStoryAxis, unknown>>): EditorialStoryReport {
  const axes = Object.fromEntries(
    EDITORIAL_STORY_AXES.map((axis) => [axis, score(input[axis])])
  ) as EditorialStoryScores;
  const total = Math.round(
    EDITORIAL_STORY_AXES.reduce((sum, axis) => sum + axes[axis] * WEIGHTS[axis], 0) * 10
  ) / 10;
  const weakestAxes = [...EDITORIAL_STORY_AXES]
    .sort((a, b) => axes[a] - axes[b])
    .slice(0, 3);
  const holdReasons: string[] = [];
  if (axes.humanConsequence < 45) holdReasons.push("No concrete person bears a meaningful consequence.");
  if (axes.unresolvedUncertainty < 42) holdReasons.push("The answer is substantially known before the episode begins.");
  if (axes.evidenceRichness < 35) holdReasons.push("The available evidence cannot support reveals or reversals.");
  if (axes.opposingInterpretations < 38) holdReasons.push("The disagreement is cosmetic rather than credibly two-sided.");
  return { total, axes, weakestAxes, holdReasons };
}

/** Blend durable editorial value with immediacy. Star recognition and raw
 * controversy are allowed to help, but they can no longer dominate selection. */
export function compositeTopicScore(input: {
  editorial: EditorialStoryReport;
  recency: number;
  starPower: number;
  controversy: number;
}): number {
  const bounded = (n: number) => Math.max(0, Math.min(100, Number(n) || 0));
  return Math.round((
    input.editorial.total * 0.68 +
    bounded(input.recency) * 0.14 +
    bounded(input.controversy) * 0.10 +
    bounded(input.starPower) * 0.08
  ) * 10) / 10;
}
