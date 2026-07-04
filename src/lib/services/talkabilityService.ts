// Talkability scoring — "is this topic actually worth an episode?"
//
// Deterministic 0-100 rating of a topic + its research brief, measuring the
// things that make content compelling on air. Used three ways:
//   1. Episode auto-select ranks candidates by talkability, not just recency
//      or the LLM's self-reported debate score.
//   2. scriptService gates generation: weak source material is flagged or
//      blocked BEFORE we spend money writing a mediocre episode on it.
//   3. The real-episode harness scores raw material before/after enrichment.
//
// Axes (100 total):
//   specificity  30 — numbers, names, dates, quotes in the actual fact texts
//   tension      20 — genuine disagreement fuel: opposing stances, contrarian
//                     angle, counter-arguments, a sharp debate question
//   evidence     20 — volume + diversity of evidence behind the facts
//   hook         15 — stakes/surprise language, a title people would click
//   freshness    15 — why-now framing and topic age

export interface TalkabilityAxis {
  score: number;
  max: number;
  detail: string;
}

export interface TalkabilityReport {
  total: number;
  axes: {
    specificity: TalkabilityAxis;
    tension: TalkabilityAxis;
    evidence: TalkabilityAxis;
    hook: TalkabilityAxis;
    freshness: TalkabilityAxis;
  };
}

export interface TalkabilityInput {
  title: string;
  summary?: string | null;
  createdAt?: Date | string | null;
  brief?: {
    facts?: any;
    stats?: any;
    keyFactsContext?: any;
    onAirTalkingPoints?: any;
    counterArguments?: any;
    contrarianAngle?: string | null;
    strongestDebateQuestion?: string | null;
    whyMattersNow?: string | null;
    mainAngle?: string | null;
    argumentForHostA?: string | null;
    argumentForHostB?: string | null;
    injuryContext?: string | null;
    oddsContext?: string | null;
    sourceIds?: any;
  } | null;
}

const STAKES_WORDS =
  /\b(fraud|fired|hot seat|collapse|meltdown|historic|record|revenge|elimination|blockbuster|stunning|shock|feud|guarantee|dynasty|bust|snub|controvers|outrage|benched|walkout|holdout|ultimatum|era|legacy)\b/i;

function textsOf(val: any): string[] {
  if (!Array.isArray(val)) return [];
  return val
    .map((f: any) => (typeof f === "string" ? f : f && typeof f === "object" ? String(f.text || f.claim || "") : ""))
    .filter(Boolean);
}

export function scoreTopicTalkability(input: TalkabilityInput): TalkabilityReport {
  const b = input.brief || {};
  const factTexts = [
    ...textsOf((b as any).keyFactsContext).length ? textsOf((b as any).keyFactsContext) : textsOf(b.facts),
    ...(textsOf((b as any).onAirTalkingPoints).length ? textsOf((b as any).onAirTalkingPoints) : textsOf(b.stats)),
  ];
  const allFactText = factTexts.join(" ");
  const factWordCount = allFactText.split(/\s+/).filter(Boolean).length || 1;

  // ---- specificity (30) ----
  const numbers = (allFactText.match(/\b\d[\d,.%-]*\b/g) || []).length;
  const properNouns = (allFactText.match(/\b[A-Z][a-z]{2,}\b/g) || []).length;
  const quotes = (allFactText.match(/["“”']([^"“”']{8,120})["“”']/g) || []).length;
  const density = ((numbers * 1.5 + properNouns * 0.5) / factWordCount) * 100;
  const specificityScore = Math.round(
    Math.min(30, density * 1.5 + Math.min(6, quotes * 2) + Math.min(6, factTexts.length))
  );
  const specificity: TalkabilityAxis = {
    score: specificityScore,
    max: 30,
    detail: `${numbers} numbers, ${properNouns} names, ${quotes} quote(s) across ${factTexts.length} fact(s)`,
  };

  // ---- tension (20) ----
  const counters = Array.isArray(b.counterArguments) ? b.counterArguments.length : 0;
  const hasContrarian = !!(b.contrarianAngle && b.contrarianAngle.trim().length > 12);
  const hasQuestion = !!(b.strongestDebateQuestion && b.strongestDebateQuestion.trim().length > 12);
  const stancesDiffer = !!(
    b.argumentForHostA &&
    b.argumentForHostB &&
    b.argumentForHostA.trim() &&
    b.argumentForHostB.trim()
  );
  const tensionScore = Math.min(
    20,
    (stancesDiffer ? 7 : 0) + (hasContrarian ? 5 : 0) + (hasQuestion ? 4 : 0) + Math.min(4, counters * 2)
  );
  const tension: TalkabilityAxis = {
    score: tensionScore,
    max: 20,
    detail: `stances: ${stancesDiffer}, contrarian: ${hasContrarian}, debate question: ${hasQuestion}, ${counters} counter-arg(s)`,
  };

  // ---- evidence (20) ----
  const sourceIds = Array.isArray(b.sourceIds) ? b.sourceIds : [];
  const typeSet = new Set(sourceIds.map((s: any) => s?.type).filter(Boolean));
  const extraContext = (b.injuryContext ? 1 : 0) + (b.oddsContext ? 1 : 0);
  const evidenceScore = Math.min(20, Math.min(12, sourceIds.length * 1.5) + typeSet.size * 2 + extraContext * 2);
  const evidence: TalkabilityAxis = {
    score: Math.round(evidenceScore),
    max: 20,
    detail: `${sourceIds.length} source(s) across ${typeSet.size} type(s), injury/odds context: ${extraContext}`,
  };

  // ---- hook (15) ----
  const title = input.title || "";
  const hookText = `${title} ${input.summary || ""} ${(b as any).mainAngle || ""}`;
  const isQuestion = /\?/.test(title);
  const stakes = (hookText.match(STAKES_WORDS) || []).length;
  const titleNames = (title.match(/\b[A-Z][a-z]{2,}\b/g) || []).length;
  const hookScore = Math.min(15, (isQuestion ? 4 : 0) + Math.min(6, stakes * 3) + Math.min(5, titleNames * 1.5));
  const hook: TalkabilityAxis = {
    score: Math.round(hookScore),
    max: 15,
    detail: `question title: ${isQuestion}, ${stakes} stakes word(s), ${titleNames} name(s) in title`,
  };

  // ---- freshness (15) ----
  const hasWhyNow = !!(b.whyMattersNow && b.whyMattersNow.trim().length > 12);
  let ageDays = 0;
  if (input.createdAt) {
    const created = new Date(input.createdAt).getTime();
    if (!isNaN(created)) ageDays = Math.max(0, (Date.now() - created) / 86400000);
  }
  const ageScore = ageDays <= 2 ? 8 : ageDays <= 5 ? 6 : ageDays <= 10 ? 3 : 1;
  const freshnessScore = Math.min(15, (hasWhyNow ? 7 : 0) + ageScore);
  const freshness: TalkabilityAxis = {
    score: freshnessScore,
    max: 15,
    detail: `why-now framing: ${hasWhyNow}, topic age ${ageDays.toFixed(1)}d`,
  };

  const total = specificity.score + tension.score + evidence.score + hook.score + freshness.score;
  return { total, axes: { specificity, tension, evidence, hook, freshness } };
}
