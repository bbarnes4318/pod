// Is this topic FRAMED around betting, or does it merely mention odds?
//
// That distinction is the whole point. The show is about people and
// consequences. Odds are legitimate as a supporting FACT inside a topic —
// "the market moved after the injury" is colour. Odds are not legitimate as the
// FRAME — "is this line begging you to take Denver?" is a betting segment.
//
// So this classifier reads the FRAME fields (title, main angle, the debate
// question, the why-now) and deliberately does NOT read the evidence/fact
// fields. A topic whose facts contain a spread but whose argument is about a
// coach's job is human-stakes, and must classify as such.
//
// Deterministic and dependency-free so it can run at generation time, in a
// migration backfill, and in tests, with identical results.

export type TopicFrame = "betting" | "human";

/** The market as the subject: the number itself is what you are arguing about. */
const FRAME_PATTERNS: { re: RegExp; weight: number; label: string }[] = [
  // Naming a market instrument in the frame is close to decisive.
  { re: /\b(point\s+spread|run\s+line|puck\s+line|money\s?line|over\/under|over-under)\b/i, weight: 3, label: "market instrument" },
  { re: /\b(parlay|teaser|prop\s+bet|futures\s+odds|implied\s+probability|juice|vig|handle)\b/i, weight: 3, label: "betting vocabulary" },
  // "the line", "the total", "the market" used as a noun you argue about.
  { re: /\b(the|this|that|a)\s+(line|total|number|price|spread|market)\b/i, weight: 2, label: "market as subject" },
  { re: /\b(odds|line|total|spread)\s+(too|already|begging|wrong|right|move[ds]?|shift)/i, weight: 3, label: "is-the-number-wrong" },
  // Explicit wagering instructions to the listener.
  { re: /\b(lay(ing)?|take|back|fade|bet|wager)\s+(the\s+)?[-+]?\d+(\.\d+)?\b/i, weight: 3, label: "wagering instruction" },
  { re: /\b(worth\s+laying|do\s+you\s+lay|are\s+you\s+laying|cover\s+the\s+spread|beat\s+the\s+number)\b/i, weight: 3, label: "wagering instruction" },
  { re: /\bvalue\s+on\b/i, weight: 2, label: "value-on" },
  // A posted price quoted in the frame: -160, +136, -1.5, 48.5-point.
  { re: /[-+]\d{3,4}\b/, weight: 3, label: "quoted price" },
  // A half-point handicap ("2.5-Point", "48.5-point") only exists because a
  // sportsbook posted it — quoting one in the frame IS the betting frame.
  { re: /\b\d+(\.5)\s*[- ]?(point|run|goal)\b/i, weight: 3, label: "quoted handicap" },
  { re: /\bpriced\s+(like|as|at)\b/i, weight: 3, label: "priced-like" },
  // "favored by 2.5" is a posted handicap being quoted, not a general remark
  // about who is better — the number comes from a book.
  { re: /\b(favou?red\s+by|underdog\s+of|getting\s+the\s+points)\b/i, weight: 3, label: "handicap framing" },
  // Sportsbook-speak for the board itself.
  { re: /\b(disrespect\s+line|sucker\s+(over|bet)|sharp\s+money|book(s|maker)?\s+(has|have|posted))\b/i, weight: 3, label: "book framing" },
  { re: /\bon\s+the\s+board\b/i, weight: 2, label: "the board" },
];

/** Human stakes: a person, a decision, a job, a grudge, a consequence. */
const HUMAN_PATTERNS: RegExp[] = [
  /\b(fired|hot\s+seat|job|career|legacy|retire|benched|traded|cut|suspend|apolog|feud|grudge|betray|loyalty|quit|walk\s*out|holdout)\b/i,
  /\b(decision|chose|choice|deserve|owe[sd]?|responsib|accountab|blame|fault|trust|respect|disrespect(ed)?\s+(him|her|them|the\s+(player|team|fans)))\b/i,
  /\b(fans?|locker\s+room|front\s+office|owner|coach|manager|rookie|veteran)\b/i,
];

export interface BettingFrameResult {
  frame: TopicFrame;
  /** Weighted evidence for a betting frame; >= THRESHOLD means betting. */
  score: number;
  /** Which patterns fired — kept so a stored classification can be explained. */
  signals: string[];
}

export const BETTING_FRAME_THRESHOLD = 3;

/**
 * Classify from the FRAME fields only. Pass what the argument is *about*, never
 * the supporting evidence — odds inside evidence are allowed and must not flip
 * a human-stakes topic.
 */
export function classifyTopicFrame(input: {
  title?: string | null;
  summary?: string | null;
  mainAngle?: string | null;
  strongestDebateQuestion?: string | null;
  whyMattersNow?: string | null;
}): BettingFrameResult {
  // The title carries the frame most strongly; the rest is supporting framing.
  const title = (input.title || "").trim();
  const rest = [input.summary, input.mainAngle, input.strongestDebateQuestion, input.whyMattersNow]
    .filter(Boolean)
    .join(" ");

  let score = 0;
  const signals: string[] = [];
  for (const { re, weight, label } of FRAME_PATTERNS) {
    const inTitle = re.test(title);
    const inRest = re.test(rest);
    if (!inTitle && !inRest) continue;
    // A signal in the title is the frame. The same signal only in the supporting
    // framing counts for less — a why-now may legitimately mention that a line
    // moved — but several of them together still add up to a betting frame,
    // which is how "Are the Giants Being Disrespected Again?" (spread + total +
    // "the market" in its summary) is caught.
    const w = inTitle ? weight : Math.max(1, weight - 1);
    score += w;
    signals.push(`${label}${inTitle ? "" : " (context only)"}`);
  }

  // A strong human-stakes title pulls back a topic that merely cites a number,
  // but never rescues one that names a market instrument in its title.
  const humanInTitle = HUMAN_PATTERNS.filter((re) => re.test(title)).length;
  if (humanInTitle > 0 && score < BETTING_FRAME_THRESHOLD + 2) {
    score -= humanInTitle;
    signals.push(`human-stakes title (-${humanInTitle})`);
  }

  return { frame: score >= BETTING_FRAME_THRESHOLD ? "betting" : "human", score, signals };
}

/** Convenience for rows that already carry a brief. */
export function classifyTopicRow(topic: {
  title?: string | null;
  summary?: string | null;
  researchBrief?: { mainAngle?: string | null; strongestDebateQuestion?: string | null; whyMattersNow?: string | null } | null;
}): BettingFrameResult {
  return classifyTopicFrame({
    title: topic.title,
    summary: topic.summary,
    mainAngle: topic.researchBrief?.mainAngle ?? null,
    strongestDebateQuestion: topic.researchBrief?.strongestDebateQuestion ?? null,
    whyMattersNow: topic.researchBrief?.whyMattersNow ?? null,
  });
}
