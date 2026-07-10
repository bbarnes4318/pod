// Single source of truth for the evidence corpus the SEMANTIC reviewer sees.
//
// Plumbing-bug fix: the fact-check gate used to build its reviewer evidence as
// ONE item per sourceId (detailText = the first fact matching that ref), which
// dropped every unmatched fact and all keyFactsContext — so with 13 refs the
// gate reviewer saw ~13 facts while the generation-time self-verify reviewer
// saw all ~88. Same reviewer, DIFFERENT evidence => different prompt => the two
// passes disagreed (the gate false-flagged facts it simply wasn't shown, e.g.
// "five total homers since 2018"). Both paths now build the reviewer evidence
// here, so the inputs are byte-identical.
//
// Pure: takes the topics' research briefs, returns the full corpus (in a stable
// order) plus a ref-id -> text index for the deterministic number check.

export interface ReviewerEvidence {
  /** Every fact/stat/keyFact/injury/odds text, in a deterministic order. */
  evidenceTexts: string[];
  /** ref id -> concatenated text of the facts/stats that cite it. */
  evidenceByRefId: Map<string, string>;
}

export interface TopicBriefLike {
  researchBrief?: {
    facts?: unknown;
    stats?: unknown;
    keyFactsContext?: unknown;
    injuryContext?: unknown;
    oddsContext?: unknown;
  } | null;
}

/** Build the reviewer evidence corpus identically for the gate and self-verify. */
export function collectReviewerEvidence(topics: TopicBriefLike[]): ReviewerEvidence {
  const evidenceTexts: string[] = [];
  const evidenceByRefId = new Map<string, string>();

  for (const t of Array.isArray(topics) ? topics : []) {
    const b: any = t?.researchBrief;
    if (!b) continue;

    const facts = Array.isArray(b.facts) ? (b.facts as any[]) : [];
    const stats = Array.isArray(b.stats) ? (b.stats as any[]) : [];
    for (const item of [...facts, ...stats]) {
      const txt = item && typeof item.text === "string" ? item.text : "";
      if (!txt) continue;
      evidenceTexts.push(txt);
      for (const r of Array.isArray(item.evidenceRefs) ? item.evidenceRefs : []) {
        if (r && r.id) evidenceByRefId.set(r.id, `${evidenceByRefId.get(r.id) || ""} ${txt}`.trim());
      }
    }

    const keyFacts = Array.isArray(b.keyFactsContext) ? (b.keyFactsContext as any[]) : [];
    for (const item of keyFacts) {
      const txt = typeof item === "string" ? item : item && typeof item.text === "string" ? item.text : "";
      if (txt) evidenceTexts.push(txt);
    }
    if (b.injuryContext) evidenceTexts.push(String(b.injuryContext));
    if (b.oddsContext) evidenceTexts.push(String(b.oddsContext));
  }

  return { evidenceTexts, evidenceByRefId };
}

/** The reviewer evidence packet shape (what runSemanticReview receives). */
export function toEvidencePanel(evidenceTexts: string[]): Array<{ detailText: string }> {
  return evidenceTexts.map((t) => ({ detailText: t }));
}

/** A cheap fingerprint (count + total chars) to prove two panels are identical. */
export function evidenceFingerprint(evidenceTexts: string[]): { count: number; chars: number } {
  return { count: evidenceTexts.length, chars: evidenceTexts.reduce((n, t) => n + t.length, 0) };
}
