// The podcast vertical taxonomy. A "vertical" is what a listener picks when
// creating a podcast; team-bearing verticals map onto a League row so teams
// can be queried from the existing Team table (seeded additively by
// migration 20260706150000_add_podcast_and_seed_teams).

export const VERTICALS = [
  "All",
  "NFL",
  "NBA",
  "MLB",
  "NHL",
  "College Football",
  "College Basketball",
  "Gambling/Point Spread",
  "Fantasy Sports",
  "Poker",
] as const;

export type Vertical = (typeof VERTICALS)[number];

/** Verticals a listener can actually store on a podcast ("All" expands). */
export const SELECTABLE_VERTICALS = VERTICALS.filter((v) => v !== "All");

/** Vertical → League.id for verticals that have teams. */
export const TEAM_LEAGUE_BY_VERTICAL: Record<string, string> = {
  NFL: "NFL",
  NBA: "NBA",
  MLB: "MLB",
  NHL: "NHL",
  "College Football": "NCAAF",
  "College Basketball": "NCAAB",
};

/** Verticals with no team concept — the team step is skipped for these. */
export const NO_TEAM_VERTICALS = ["Gambling/Point Spread", "Fantasy Sports", "Poker"];

export function isValidVertical(v: string): boolean {
  return (VERTICALS as readonly string[]).includes(v);
}

/** Expand "All" into the full selectable list; dedupe and drop unknowns. */
export function normalizeVerticals(input: string[]): string[] {
  const picked = input.includes("All") ? [...SELECTABLE_VERTICALS] : input;
  return [...new Set(picked.filter(isValidVertical))];
}

/** League ids whose teams are selectable for the given verticals. */
export function teamLeagueIdsForVerticals(verticals: string[]): string[] {
  return [...new Set(normalizeVerticals(verticals).map((v) => TEAM_LEAGUE_BY_VERTICAL[v]).filter(Boolean))];
}

/** Non-sport verticals' League.id rows (seeded by migration 20260706210000). */
export const NONSPORT_LEAGUE_BY_VERTICAL: Record<string, string> = {
  "Gambling/Point Spread": "GAMBLING",
  "Fantasy Sports": "FANTASY",
  Poker: "POKER",
};

/** Map a TopicCandidate's leagueId/sport back to a vertical (for pre-fill). */
export function verticalForTopic(leagueId: string | null, sport: string | null): string | null {
  if (leagueId) {
    const id = leagueId.toUpperCase();
    const byLeague = Object.entries(TEAM_LEAGUE_BY_VERTICAL).find(([, lid]) => lid === id);
    if (byLeague) return byLeague[0];
    const byNonSport = Object.entries(NONSPORT_LEAGUE_BY_VERTICAL).find(([, lid]) => lid === id);
    if (byNonSport) return byNonSport[0];
  }
  const s = (sport || "").toLowerCase();
  if (s.includes("football")) return "NFL";
  if (s.includes("basketball")) return "NBA";
  if (s.includes("baseball")) return "MLB";
  if (s.includes("hockey")) return "NHL";
  if (s.includes("poker")) return "Poker";
  if (s.includes("fantasy")) return "Fantasy Sports";
  if (s.includes("betting") || s.includes("gambling")) return "Gambling/Point Spread";
  return null;
}

// ---------- Topic ↔ vertical matching (episode auto-selection) ----------

const BETTING_RE = /\b(odds|spread|moneyline|over\/under|parlay|betting|bettors?|sportsbooks?|line (?:move|movement)|implied (?:probability|score)|cover(?:ing)? the (?:spread|number)|total)\b/i;
const FANTASY_RE = /\b(fantasy|waiver(?: wire)?|start[\s/-]?(?:or[\s/-]?)?sit|dfs|draft ?kings|fan ?duel|sleeper pick|roster percentage)\b/i;
const POKER_RE = /\b(poker|wsop|wpt|hold\s?'?em|final table|bluff(?:ed|ing)?|bad beat|pot odds)\b/i;

export interface TopicVerticalShape {
  leagueId?: string | null;
  sport?: string | null;
  title: string;
  summary?: string | null;
  bettingRelevanceScore?: number | null;
}

/**
 * Whether a topic belongs to a vertical. Sports verticals match on League;
 * non-sport verticals match on their seeded League row, score, or keywords —
 * this works for topics that predate any tagging.
 */
export function topicMatchesVertical(topic: TopicVerticalShape, vertical: string): boolean {
  const topicLeague = (topic.leagueId || "").toUpperCase();

  const sportsLeague = TEAM_LEAGUE_BY_VERTICAL[vertical];
  if (sportsLeague) return topicLeague === sportsLeague;

  const text = `${topic.title} ${topic.summary || ""}`;
  if (vertical === "Gambling/Point Spread") {
    return topicLeague === "GAMBLING" || (topic.bettingRelevanceScore ?? 0) >= 60 || BETTING_RE.test(text);
  }
  if (vertical === "Fantasy Sports") {
    return topicLeague === "FANTASY" || FANTASY_RE.test(text);
  }
  if (vertical === "Poker") {
    return topicLeague === "POKER" || POKER_RE.test(text);
  }
  return false;
}

export function topicMatchesAnyVertical(topic: TopicVerticalShape, verticals: string[]): boolean {
  // "All" means no filter at all (some topics — e.g. MMA — belong to no
  // specific creation vertical and must still qualify for an All podcast).
  if (verticals.length === 0 || verticals.includes("All")) return true;
  const list = normalizeVerticals(verticals);
  if (list.length === 0) return true;
  // A stored "everything" selection (All expands on save) is also no filter.
  if (list.length === SELECTABLE_VERTICALS.length) return true;
  return list.some((v) => topicMatchesVertical(topic, v));
}
