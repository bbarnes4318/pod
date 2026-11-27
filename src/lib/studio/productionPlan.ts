// How the studio proposes a rundown from a creative objective.
//
// Pure and deterministic: the same pool and the same objective always give the
// same proposal, and every choice carries the stored facts it was made from.
// No model is called here. AI Producer and Guided Production both read this, so
// "what the studio recommends" has one definition.
//
// ponytail: relevance is word overlap between the objective and a topic's own
// text. It cannot tell "the Lakers' defence" from "defending the Lakers". If
// that ceiling starts to matter, rank with an embedding or a model call here;
// the callers only need `PlannedTopic[]` back.

export interface PlanTopic {
  id: string;
  title: string;
  summary: string | null;
  sport: string;
  leagueId: string | null;
  /** 0-100, the heat the board shows. */
  talkability: number;
  debateScore: number;
  evidenceCount: number;
  sourceCount: number;
  eligible: boolean;
  brief?: { whyMattersNow?: string | null; mainAngle?: string | null; strongestDebateQuestion?: string | null } | null;
}

export interface PlannedTopic {
  id: string;
  /** Ranking number only. Not shown as a fact about the topic. */
  score: number;
  /** Objective words found in this topic's own text. */
  matched: string[];
  /** Plain statements of stored facts behind the pick. */
  reasons: string[];
}

export interface ProductionPlan {
  topics: PlannedTopic[];
  leadId: string | null;
  /** Things the creator should know about this proposal (shortfalls, no match). */
  notes: string[];
}

const STOP = new Set(
  "the a an and or but for with from into about over this that these those episode show make want need more less very just what why how who when where our your their its his her them they are was were been have has had will would should could not out off new get got give take cover talk focus".split(" ")
);

/** The words of an objective worth matching on. */
export function objectiveTerms(objective: string): string[] {
  const words = objective.toLowerCase().match(/[a-z0-9][a-z0-9'-]{2,}/g) ?? [];
  return [...new Set(words.map((w) => w.replace(/'s$/, "")).filter((w) => !STOP.has(w)))].slice(0, 12);
}

const PER_MATCH = 12;
const MATCH_CAP = 36;
/** Applied to a third topic from one league, so a rundown is not one story three times. */
const SAME_LEAGUE_PENALTY = 15;

function haystack(t: PlanTopic): string {
  return [t.title, t.summary, t.sport, t.leagueId, t.brief?.mainAngle, t.brief?.whyMattersNow, t.brief?.strongestDebateQuestion]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function describe(t: PlanTopic, matched: string[]): string[] {
  const reasons: string[] = [];
  if (matched.length) reasons.push(`Matches your objective: ${matched.join(", ")}`);
  reasons.push(`Heat ${Math.round(t.talkability)} of 100`);
  reasons.push(`${t.sourceCount} source${t.sourceCount === 1 ? "" : "s"}, ${t.evidenceCount} evidence item${t.evidenceCount === 1 ? "" : "s"}`);
  return reasons;
}

/** Every eligible topic, best first for this objective. */
export function rankForObjective(topics: PlanTopic[], objective: string): PlannedTopic[] {
  const terms = objectiveTerms(objective);
  return topics
    .filter((t) => t.eligible)
    .map((t) => {
      const hay = haystack(t);
      const matched = terms.filter((w) => hay.includes(w));
      return { t, matched, score: t.talkability + Math.min(MATCH_CAP, matched.length * PER_MATCH) };
    })
    .sort((a, b) => b.score - a.score || b.t.debateScore - a.t.debateScore || a.t.id.localeCompare(b.t.id))
    .map(({ t, matched, score }) => ({ id: t.id, score, matched, reasons: describe(t, matched) }));
}

/**
 * The next-best topics to sit beside what is already picked. Relevance still
 * counts, but a league already covered twice is pushed down, so the suggestion
 * widens the episode instead of repeating it.
 */
export function suggestCompanions(topics: PlanTopic[], pickedIds: string[], objective: string, count: number): PlannedTopic[] {
  const byId = new Map(topics.map((t) => [t.id, t]));
  const leagueCount = new Map<string, number>();
  for (const id of pickedIds) {
    const league = byId.get(id)?.leagueId;
    if (league) leagueCount.set(league, (leagueCount.get(league) ?? 0) + 1);
  }
  const pickedLeagues = new Set(leagueCount.keys());
  const out: PlannedTopic[] = [];
  const pool = rankForObjective(topics, objective).filter((p) => !pickedIds.includes(p.id));
  while (out.length < count && pool.length) {
    let best = 0;
    let bestScore = -Infinity;
    pool.forEach((p, i) => {
      const league = byId.get(p.id)?.leagueId ?? null;
      const crowded = league !== null && (leagueCount.get(league) ?? 0) >= 2 && p.matched.length === 0;
      const adjusted = p.score - (crowded ? SAME_LEAGUE_PENALTY : 0);
      if (adjusted > bestScore) { bestScore = adjusted; best = i; }
    });
    const [pick] = pool.splice(best, 1);
    const league = byId.get(pick.id)?.leagueId ?? null;
    if (league) leagueCount.set(league, (leagueCount.get(league) ?? 0) + 1);
    const variety = league && pickedLeagues.size > 0 ? (pickedLeagues.has(league) ? "Same league as a story you already have" : "A different league from the stories you already have") : null;
    out.push(variety ? { ...pick, reasons: [...pick.reasons, variety] } : pick);
  }
  return out;
}

/** A complete proposed rundown: `target` topics, ordered, with a lead. */
export function planProduction(input: { topics: PlanTopic[]; objective: string; target: number; maxTopics: number }): ProductionPlan {
  const target = Math.max(1, Math.min(input.maxTopics, Math.floor(input.target) || 1));
  const ranked = rankForObjective(input.topics, input.objective);
  const notes: string[] = [];
  if (ranked.length === 0) {
    return { topics: [], leadId: null, notes: ["No topic in the current pool is ready to use. New ones arrive as the feeds update."] };
  }
  const lead = ranked[0];
  const rest = suggestCompanions(input.topics, [lead.id], input.objective, target - 1);
  const topics = [lead, ...rest];

  const terms = objectiveTerms(input.objective);
  if (terms.length > 0 && topics.every((t) => t.matched.length === 0)) {
    notes.push(`Nothing in the current pool mentions ${terms.slice(0, 4).join(", ")}. These are the strongest stories overall instead.`);
  }
  if (topics.length < target) {
    notes.push(`Only ${topics.length} topic${topics.length === 1 ? " is" : "s are"} ready right now, so the rundown is shorter than the ${target} you asked for.`);
  }
  return { topics, leadId: lead.id, notes };
}
