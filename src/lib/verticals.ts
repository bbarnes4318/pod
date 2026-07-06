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

/** Map a TopicCandidate's leagueId/sport back to a vertical (for pre-fill). */
export function verticalForTopic(leagueId: string | null, sport: string | null): string | null {
  if (leagueId) {
    const byLeague = Object.entries(TEAM_LEAGUE_BY_VERTICAL).find(([, id]) => id === leagueId.toUpperCase());
    if (byLeague) return byLeague[0];
  }
  const s = (sport || "").toLowerCase();
  if (s.includes("football")) return "NFL";
  if (s.includes("basketball")) return "NBA";
  if (s.includes("baseball")) return "MLB";
  if (s.includes("hockey")) return "NHL";
  return null;
}
