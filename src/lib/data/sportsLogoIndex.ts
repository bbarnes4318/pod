// Lookups over the generated sports-logo manifest.
//
// The manifest is keyed by FOLDER slug ("kansas-city-chiefs"); the database is
// keyed by Team.id ("seed:nfl:kc", "sio:…"). Nothing in either one references
// the other, so this module is the join — and it is deliberately pure, so the
// join can be exercised without a database.
//
// Matching is by name, not by abbreviation alone: the logo files were named by
// whoever exported them and the seed rows by us, so the two disagree often
// enough ("SCAR" vs "SC", "NOVA" vs "VILL") that an abbreviation-only join
// silently drops teams. Names agree far more often, and where they do not, the
// disagreement is almost always that one side omits the nickname — "Maryland"
// for "Maryland Terrapins" — which the token-prefix rule below resolves.

import { SPORTS_LOGO_LEAGUES } from "./sportsLogos.generated";
import type { LogoConference, LogoLeague, LogoTeam } from "./sportsLogoTypes";

export type { LogoConference, LogoLeague, LogoTeam };
export { SPORTS_LOGO_LEAGUES };

/** League.ids The Board can browse, in display order. */
export const BROWSABLE_LEAGUE_IDS: string[] = SPORTS_LOGO_LEAGUES.map((l) => l.id);

const LEAGUE_BY_ID = new Map(SPORTS_LOGO_LEAGUES.map((l) => [l.id, l]));

export function logoLeague(leagueId: string | null | undefined): LogoLeague | null {
  if (!leagueId) return null;
  return LEAGUE_BY_ID.get(leagueId) ?? null;
}

export function logoConference(leagueId: string, confSlug: string | null | undefined): LogoConference | null {
  if (!confSlug) return null;
  return logoLeague(leagueId)?.conferences.find((c) => c.slug === confSlug) ?? null;
}

/** Team slugs repeat across leagues (Alabama plays both), so lookup is scoped. */
export function logoTeam(leagueId: string, teamSlug: string | null | undefined): LogoTeam | null {
  if (!teamSlug) return null;
  return logoLeague(leagueId)?.teams.find((t) => t.slug === teamSlug) ?? null;
}

// Built once at module load: the board asks this for every crest on every take
// while counting tiles, and a scan of 32 conferences x ~12 teams per question
// is a lot of comparisons for an answer that never changes.
const CONFERENCE_BY_TEAM = new Map<string, LogoConference>();
for (const league of SPORTS_LOGO_LEAGUES) {
  for (const conference of league.conferences) {
    for (const team of conference.teams) {
      CONFERENCE_BY_TEAM.set(`${league.id}/${team.slug}`, conference);
    }
  }
}

/** The conference a college team sits in, for breadcrumbs and tile counts. */
export function conferenceOfTeam(leagueId: string, teamSlug: string): LogoConference | null {
  return CONFERENCE_BY_TEAM.get(`${leagueId}/${teamSlug}`) ?? null;
}

/* ------------------------------------------------------------------ *
 * Name matching
 * ------------------------------------------------------------------ */

/**
 * Words of a name, stripped of case, accents and punctuation.
 * "Texas A&M" and "texas a&m" and "Texas A & M" all become ["texas", "a", "m"].
 */
export function nameTokens(value: string): string[] {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

interface Indexed {
  team: LogoTeam;
  tokens: string[];
}

const TOKEN_INDEX = new Map<string, Indexed[]>(
  SPORTS_LOGO_LEAGUES.map((l) => [l.id, l.teams.map((team) => ({ team, tokens: nameTokens(team.name) }))])
);

const ABBR_INDEX = new Map<string, Map<string, LogoTeam[]>>(
  SPORTS_LOGO_LEAGUES.map((l) => {
    const byAbbr = new Map<string, LogoTeam[]>();
    for (const team of l.teams) {
      const key = team.abbr.toUpperCase();
      const bucket = byAbbr.get(key);
      if (bucket) bucket.push(team);
      else byAbbr.set(key, [team]);
    }
    return [l.id, byAbbr];
  })
);

/** A database team, as much of one as matching needs. */
export interface TeamLike {
  name: string;
  city?: string | null;
  abbreviation?: string | null;
}

function exactMatch(candidates: Indexed[], tokens: string[]): LogoTeam | null {
  if (tokens.length === 0) return null;
  const hits = candidates.filter(
    (c) => c.tokens.length === tokens.length && c.tokens.every((t, i) => t === tokens[i])
  );
  return hits.length === 1 ? hits[0].team : null;
}

/**
 * "Maryland" → "Maryland Terrapins". The database stores college programs by
 * school and the logo folders by school + nickname, so a database name is
 * usually a token-boundary PREFIX of the manifest name.
 *
 * Ties are refused rather than guessed: "South Carolina" prefixes Gamecocks
 * (one extra token), State Bulldogs and Upstate Spartans (two each), so the
 * shortest completion wins outright. Where two candidates are equally short —
 * genuinely ambiguous — this returns null instead of picking one.
 */
function prefixMatch(candidates: Indexed[], tokens: string[]): LogoTeam | null {
  if (tokens.length === 0) return null;
  const hits = candidates
    .filter((c) => c.tokens.length > tokens.length && tokens.every((t, i) => c.tokens[i] === t))
    .sort((a, b) => a.tokens.length - b.tokens.length);
  if (hits.length === 0) return null;
  if (hits.length > 1 && hits[0].tokens.length === hits[1].tokens.length) return null;
  return hits[0].team;
}

/**
 * Find the manifest team a database row refers to, within one league.
 * Returns null rather than a best guess — an unmatched team simply does not
 * get a logo, which is a far smaller failure than the wrong crest.
 */
export function matchLogoTeam(leagueId: string, team: TeamLike): LogoTeam | null {
  const candidates = TOKEN_INDEX.get(leagueId);
  if (!candidates) return null;

  const city = (team.city ?? "").trim();
  const full = city ? `${city} ${team.name}` : team.name;

  const byFull = exactMatch(candidates, nameTokens(full));
  if (byFull) return byFull;

  const byName = exactMatch(candidates, nameTokens(team.name));
  if (byName) return byName;

  const abbr = (team.abbreviation ?? "").trim().toUpperCase();
  if (abbr) {
    const bucket = ABBR_INDEX.get(leagueId)?.get(abbr);
    if (bucket?.length === 1) return bucket[0];
  }

  return prefixMatch(candidates, nameTokens(full)) ?? prefixMatch(candidates, nameTokens(team.name));
}
