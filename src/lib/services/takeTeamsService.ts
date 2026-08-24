// Which teams is a take about?
//
// The Board lets a listener walk League → (Conference) → Team and see the takes
// waiting on that team. TopicCandidate has no team column, so the attribution
// has to be derived — and it is derived from what the pipeline already stored,
// never invented:
//
//   1. EVIDENCE (authoritative). Every approved take carries `evidenceIds`,
//      and the worker rejects any candidate whose refs do not resolve to real
//      rows. A game names two teams, an injury names one, a team/player stat
//      names one, an odds snapshot names a game. Following those refs gives an
//      attribution the pipeline itself already stands behind.
//
//   2. TEAM NAMES IN THE TEXT (fallback, league-scoped). A take sourced only
//      from news carries no team-bearing evidence, and NewsItem has no team
//      relation. For those, team names are matched against the take's own title
//      and summary — but ONLY within the league the take is already stamped
//      with, and only on whole words. An unscoped match would file an NFL
//      "Cardinals" take under the baseball Cardinals.
//
// Anything that resolves to nothing simply has no team, and the UI says so.
// A take is never assigned a team on a guess.

import { parseEvidenceRefList } from "./evidenceRefs";
import { BROWSABLE_LEAGUE_IDS, matchLogoTeam, nameTokens } from "../data/sportsLogoIndex";

/** A take, as much of one as attribution needs. */
export interface TakeForTeams {
  id: string;
  title: string;
  summary?: string | null;
  leagueId?: string | null;
  evidenceIds?: unknown;
}

/** A team in the logo manifest, qualified by league (slugs repeat across them). */
export interface TakeTeamRef {
  leagueId: string;
  teamSlug: string;
}

/** The DB surface this needs. PrismaClient and test doubles both satisfy it. */
export interface TakeTeamsDb {
  team: {
    findMany: (args: unknown) => Promise<
      Array<{ id: string; name: string; city: string; abbreviation: string; leagueId: string }>
    >;
  };
  game: {
    findMany: (args: unknown) => Promise<Array<{ id: string; homeTeamId: string; awayTeamId: string }>>;
  };
  oddsSnapshot: { findMany: (args: unknown) => Promise<Array<{ id: string; gameId: string }>> };
  injury: { findMany: (args: unknown) => Promise<Array<{ id: string; teamId: string | null }>> };
  teamStat: { findMany: (args: unknown) => Promise<Array<{ id: string; teamId: string }>> };
  playerStat: { findMany: (args: unknown) => Promise<Array<{ id: string; teamId: string | null }>> };
}

/**
 * Nicknames that are ordinary English words. Matching these bare would file
 * "the Jazz" against any take that mentions jazz, so they are only accepted
 * with the city attached ("Utah Jazz").
 */
const BARE_NICKNAME_DENYLIST = new Set([
  "heat", "jazz", "magic", "thunder", "kings", "wild", "avalanche", "storm", "beach",
  "orange", "crimson", "tide", "pride", "herd", "flames", "blue", "green", "red", "cardinal",
]);

const refKey = (type: string, id: string) => `${type}:${id}`;

/** Case-insensitive whole-word search that ignores punctuation differences. */
function mentions(haystackTokens: string[], phrase: string): boolean {
  const needle = nameTokens(phrase);
  if (needle.length === 0) return false;
  for (let i = 0; i + needle.length <= haystackTokens.length; i++) {
    let ok = true;
    for (let j = 0; j < needle.length; j++) {
      if (haystackTokens[i + j] !== needle[j]) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
  }
  return false;
}

/**
 * Resolve every take's teams in a fixed number of queries, regardless of how
 * many takes are passed in.
 */
export async function resolveTakeTeams(
  takes: TakeForTeams[],
  client?: TakeTeamsDb
): Promise<Map<string, TakeTeamRef[]>> {
  const out = new Map<string, TakeTeamRef[]>();
  if (takes.length === 0) return out;

  // Imported here rather than at module scope so this module can be exercised
  // against a test double without a database URL: `../db` asserts a full
  // production environment the moment it is loaded.
  const db = client ?? ((await import("../db")).db as unknown as TakeTeamsDb);

  /* ---------------- 1. Collect every evidence ref, by type ---------------- */

  const refsByTake = new Map<string, Array<{ type: string; id: string }>>();
  const idsByType = new Map<string, Set<string>>();
  for (const take of takes) {
    const { refs } = parseEvidenceRefList(take.evidenceIds);
    refsByTake.set(take.id, refs);
    for (const ref of refs) {
      const bucket = idsByType.get(ref.type) ?? new Set<string>();
      bucket.add(ref.id);
      idsByType.set(ref.type, bucket);
    }
  }
  const ids = (type: string) => [...(idsByType.get(type) ?? [])];

  /* ---------------- 2. Resolve refs to database team ids ----------------- */

  // Odds first: a snapshot names a game, and that game's teams are what the
  // reference is really about, so its gameId joins the game lookup.
  const oddsIds = ids("oddsSnapshot");
  const odds = oddsIds.length
    ? await db.oddsSnapshot.findMany({ where: { id: { in: oddsIds } }, select: { id: true, gameId: true } })
    : [];

  const gameIds = new Set<string>(ids("game"));
  for (const o of odds) gameIds.add(o.gameId);

  const [games, injuries, teamStats, playerStats] = await Promise.all([
    gameIds.size
      ? db.game.findMany({
          where: { id: { in: [...gameIds] } },
          select: { id: true, homeTeamId: true, awayTeamId: true },
        })
      : Promise.resolve([]),
    ids("injury").length
      ? db.injury.findMany({ where: { id: { in: ids("injury") } }, select: { id: true, teamId: true } })
      : Promise.resolve([]),
    ids("teamStat").length
      ? db.teamStat.findMany({ where: { id: { in: ids("teamStat") } }, select: { id: true, teamId: true } })
      : Promise.resolve([]),
    ids("playerStat").length
      ? db.playerStat.findMany({ where: { id: { in: ids("playerStat") } }, select: { id: true, teamId: true } })
      : Promise.resolve([]),
  ]);

  const gameTeams = new Map(games.map((g) => [g.id, [g.homeTeamId, g.awayTeamId]]));

  /** evidence ref key → database team ids it names. */
  const teamsByRef = new Map<string, string[]>();
  for (const g of games) teamsByRef.set(refKey("game", g.id), [g.homeTeamId, g.awayTeamId]);
  for (const o of odds) {
    const teams = gameTeams.get(o.gameId);
    if (teams) teamsByRef.set(refKey("oddsSnapshot", o.id), teams);
  }
  for (const i of injuries) if (i.teamId) teamsByRef.set(refKey("injury", i.id), [i.teamId]);
  for (const s of teamStats) teamsByRef.set(refKey("teamStat", s.id), [s.teamId]);
  for (const s of playerStats) if (s.teamId) teamsByRef.set(refKey("playerStat", s.id), [s.teamId]);

  /* ---------------- 3. Database teams → manifest teams ------------------- */

  // One query for every browsable team: it both resolves the ids above and
  // supplies the city/nickname aliases the text fallback needs.
  const dbTeams = await db.team.findMany({
    where: { leagueId: { in: BROWSABLE_LEAGUE_IDS } },
    select: { id: true, name: true, city: true, abbreviation: true, leagueId: true },
  });

  const refByTeamId = new Map<string, TakeTeamRef>();
  interface Alias {
    ref: TakeTeamRef;
    /** Phrases that identify this team on their own. */
    phrases: string[];
  }
  const aliasesByLeague = new Map<string, Alias[]>();

  for (const t of dbTeams) {
    const logo = matchLogoTeam(t.leagueId, t);
    if (!logo) continue;
    const ref: TakeTeamRef = { leagueId: t.leagueId, teamSlug: logo.slug };
    refByTeamId.set(t.id, ref);

    const city = (t.city ?? "").trim();
    const phrases = new Set<string>([logo.name, t.name]);
    if (city) phrases.add(`${city} ${t.name}`);
    // "Dallas Cowboys" is stored as name="Dallas Cowboys", city="Dallas" by the
    // seed and as name="Cowboys", city="Dallas" by the ingestion provider — so
    // the nickname is whichever of those the city does not already cover.
    const nickname = city && t.name.toLowerCase().startsWith(city.toLowerCase())
      ? t.name.slice(city.length).trim()
      : t.name;
    if (nickname && !BARE_NICKNAME_DENYLIST.has(nickname.toLowerCase())) phrases.add(nickname);

    const bucket = aliasesByLeague.get(t.leagueId) ?? [];
    bucket.push({ ref, phrases: [...phrases].filter(Boolean) });
    aliasesByLeague.set(t.leagueId, bucket);
  }

  /* ---------------- 4. Attribute each take ------------------------------- */

  for (const take of takes) {
    const found = new Map<string, TakeTeamRef>();

    for (const ref of refsByTake.get(take.id) ?? []) {
      for (const teamId of teamsByRef.get(refKey(ref.type, ref.id)) ?? []) {
        const hit = refByTeamId.get(teamId);
        if (hit) found.set(`${hit.leagueId}/${hit.teamSlug}`, hit);
      }
    }

    // Text fallback — only for takes the evidence could not place, and only
    // inside the league the take is already stamped with.
    if (found.size === 0 && take.leagueId) {
      const aliases = aliasesByLeague.get(take.leagueId);
      if (aliases) {
        const haystack = nameTokens(`${take.title} ${take.summary ?? ""}`);
        for (const alias of aliases) {
          if (alias.phrases.some((p) => mentions(haystack, p))) {
            found.set(`${alias.ref.leagueId}/${alias.ref.teamSlug}`, alias.ref);
          }
        }
      }
    }

    out.set(take.id, [...found.values()]);
  }

  return out;
}
