/**
 * Checks The Board's league → conference → team browsing without a database.
 *
 * Three things can silently break it, and none of them shows up as a crash:
 *
 *   1. A manifest that points at files that are not there. It is generated from
 *      a folder tree; a rename leaves a 404 and an empty tile.
 *   2. A name join that stops matching. The logo folders and the seeded Team
 *      rows were named by different people, so this is the fragile seam — if it
 *      slips, teams quietly lose their crest and their takes.
 *   3. Attribution leaking across leagues. "Cardinals" is three different teams;
 *      filing an NFL take under the baseball Cardinals is worse than filing it
 *      nowhere.
 *
 * Run:  npm run test:board-browse
 */

import fs from "fs";
import path from "path";
import { SEED_TEAMS } from "../lib/data/teamSeed";
import {
  SPORTS_LOGO_LEAGUES,
  conferenceOfTeam,
  logoTeam,
  matchLogoTeam,
} from "../lib/data/sportsLogoIndex";
import { resolveTakeTeams, type TakeTeamsDb } from "../lib/services/takeTeamsService";

let failures = 0;

function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    console.log(`  PASS  ${name}`);
  } else {
    failures++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function section(title: string) {
  console.log(`\n${title}`);
}

/* ------------------------------------------------------------------ *
 * 1. The manifest describes files that actually exist
 * ------------------------------------------------------------------ */

section("Manifest integrity");

const PUBLIC = path.join(process.cwd(), "public");
const onDisk = (webPath: string) => fs.existsSync(path.join(PUBLIC, decodeURIComponent(webPath)));

check("all five browsable leagues are present", SPORTS_LOGO_LEAGUES.length === 5, `got ${SPORTS_LOGO_LEAGUES.length}`);

{
  const missing: string[] = [];
  let logoCount = 0;
  for (const league of SPORTS_LOGO_LEAGUES) {
    if (league.logo) {
      logoCount++;
      if (!onDisk(league.logo)) missing.push(league.logo);
    }
    for (const conference of league.conferences) {
      if (conference.logo) {
        logoCount++;
        if (!onDisk(conference.logo)) missing.push(conference.logo);
      }
    }
    for (const team of league.teams) {
      logoCount++;
      if (!onDisk(team.logo)) missing.push(team.logo);
    }
  }
  check(`every one of ${logoCount} logo paths resolves on disk`, missing.length === 0, missing.slice(0, 5).join(", "));
}

{
  const problems: string[] = [];
  for (const league of SPORTS_LOGO_LEAGUES) {
    const slugs = new Set<string>();
    for (const team of league.teams) {
      if (slugs.has(team.slug)) problems.push(`${league.id}: duplicate ${team.slug}`);
      slugs.add(team.slug);
      if (!team.name.trim()) problems.push(`${league.id}/${team.slug}: blank name`);
    }
    if (league.conferences.length > 0) {
      const flattened = league.conferences.reduce((n, c) => n + c.teams.length, 0);
      if (flattened !== league.teams.length) {
        problems.push(`${league.id}: ${flattened} conference teams vs ${league.teams.length} flattened`);
      }
      for (const conference of league.conferences) {
        if (conference.teams.length === 0) problems.push(`${league.id}/${conference.slug}: no teams`);
        if (!conference.shortName.trim()) problems.push(`${league.id}/${conference.slug}: no short name`);
      }
    }
  }
  check("team slugs are unique per league and conferences are whole", problems.length === 0, problems.slice(0, 5).join("; "));
}

// Every league now ships its own mark — the two college leagues were monogram
// fallbacks until cfb-logo.jpg and cbb-logo.png were added by hand, which is
// also why the manifest must accept art that follows no naming convention.
check(
  "every league has a real mark, not a monogram fallback",
  SPORTS_LOGO_LEAGUES.every((l) => !!l.logo),
  SPORTS_LOGO_LEAGUES.filter((l) => !l.logo).map((l) => l.shortName).join(", ")
);

// plate and opaque answer different questions and must never both be set: one
// puts a surface BEHIND a transparent mark, the other says the mark brought its
// own. Setting both would frame a white image in off-white.
{
  const both: string[] = [];
  for (const league of SPORTS_LOGO_LEAGUES) {
    if (league.plate && league.opaque) both.push(league.shortName);
    for (const c of league.conferences) if (c.plate && c.opaque) both.push(`${league.id}/${c.slug}`);
    for (const t of league.teams) if (t.plate && t.opaque) both.push(`${league.id}/${t.slug}`);
  }
  check("no mark is both plated and opaque", both.length === 0, both.slice(0, 5).join(", "));
}

check(
  "pro leagues are flat, college leagues are tiered",
  SPORTS_LOGO_LEAGUES.every((l) =>
    ["NFL", "NBA", "MLB"].includes(l.id) ? l.conferences.length === 0 : l.conferences.length > 0
  )
);

check(
  "a college team resolves back to its conference",
  conferenceOfTeam("NCAAF", "alabama-crimson-tide")?.shortName === "SEC" &&
    conferenceOfTeam("NCAAB", "saint-marys-gaels")?.shortName === "WCC",
  `${conferenceOfTeam("NCAAF", "alabama-crimson-tide")?.shortName} / ${conferenceOfTeam("NCAAB", "saint-marys-gaels")?.shortName}`
);

// The manifest, not folklore, decides where a school plays: the asset set has
// Gonzaga in the rebuilt Pac-12, and the browser must follow it rather than a
// hard-coded idea of the WCC.
check(
  "conference membership follows the assets",
  conferenceOfTeam("NCAAB", "gonzaga-bulldogs")?.shortName === "Pac-12",
  String(conferenceOfTeam("NCAAB", "gonzaga-bulldogs")?.shortName)
);

check(
  "the mojibake folder keeps its path but not its display name",
  logoTeam("NCAAF", "san-josã-state-spartans")?.name === "San José State Spartans"
);

/* ------------------------------------------------------------------ *
 * 2. Every seeded Team row finds its crest
 * ------------------------------------------------------------------ */

section("Database team -> manifest team");

{
  const unmatched: string[] = [];
  const browsable = new Set(SPORTS_LOGO_LEAGUES.map((l) => l.id));
  const seeds = SEED_TEAMS.filter((t) => browsable.has(t.leagueId));
  for (const seed of seeds) {
    if (!matchLogoTeam(seed.leagueId, seed)) unmatched.push(`${seed.leagueId} ${seed.name}`);
  }
  check(`all ${seeds.length} seeded teams match a crest`, unmatched.length === 0, unmatched.slice(0, 8).join(", "));
}

const matchedTo = (leagueId: string, name: string, city = "", abbreviation = "") =>
  matchLogoTeam(leagueId, { name, city, abbreviation })?.slug ?? null;

check("exact full name", matchedTo("NFL", "Dallas Cowboys", "Dallas", "DAL") === "dallas-cowboys");
check(
  "provider-shaped row (nickname in name, city separate)",
  matchedTo("NFL", "Chiefs", "Kansas City", "KC") === "kansas-city-chiefs"
);
check("token-prefix completion", matchedTo("NCAAF", "Maryland", "", "UMD") === "maryland-terrapins");
check(
  "shortest completion wins over longer ones",
  matchedTo("NCAAB", "South Carolina", "", "SCAR") === "south-carolina-gamecocks",
  String(matchedTo("NCAAB", "South Carolina", "", "SCAR"))
);
check("punctuation is not a difference", matchedTo("NCAAF", "Texas A&M", "", "TAMU") === "texas-am-aggies");
check("a name in no league matches nothing", matchedTo("NFL", "Springfield Isotopes") === null);

/* ------------------------------------------------------------------ *
 * 3. Attributing takes to teams
 * ------------------------------------------------------------------ */

section("Take -> team attribution");

const browsableSeeds = SEED_TEAMS.filter((t) =>
  SPORTS_LOGO_LEAGUES.some((l) => l.id === t.leagueId)
).map((t) => ({
  id: t.id,
  name: t.name,
  city: t.city,
  abbreviation: t.abbreviation,
  leagueId: t.leagueId,
}));

const GAMES = [{ id: "g1", homeTeamId: "seed:nfl:kc", awayTeamId: "seed:nfl:buf" }];
const ODDS = [{ id: "o1", gameId: "g1" }];
const INJURIES = [{ id: "i1", teamId: "seed:nba:lal" }];
const TEAM_STATS = [{ id: "ts1", teamId: "seed:mlb:nyy" }];
const PLAYER_STATS = [{ id: "ps1", teamId: null as string | null }];

/** Enough of Prisma to answer `{ where: { id: { in: [...] } } }`. */
const inFilter = <T extends { id: string }>(rows: T[]) => (args: unknown) => {
  const ids: string[] = (args as { where?: { id?: { in?: string[] } } })?.where?.id?.in ?? [];
  return Promise.resolve(rows.filter((r) => ids.includes(r.id)));
};

const fakeDb: TakeTeamsDb = {
  team: { findMany: () => Promise.resolve(browsableSeeds) },
  game: { findMany: inFilter(GAMES) },
  oddsSnapshot: { findMany: inFilter(ODDS) },
  injury: { findMany: inFilter(INJURIES) },
  teamStat: { findMany: inFilter(TEAM_STATS) },
  playerStat: { findMany: inFilter(PLAYER_STATS) },
};

async function run() {
  const takes = [
    { id: "t-game", title: "Late-game clock management", leagueId: "NFL", evidenceIds: [{ type: "game", id: "g1" }] },
    { id: "t-odds", title: "The line moved four points", leagueId: "NFL", evidenceIds: [{ type: "oddsSnapshot", id: "o1" }] },
    { id: "t-injury", title: "Out again", leagueId: "NBA", evidenceIds: [{ type: "injury", id: "i1" }] },
    { id: "t-stat", title: "Run differential says otherwise", leagueId: "MLB", evidenceIds: [{ type: "teamStat", id: "ts1" }] },
    // News-only: no team-bearing evidence, so the text fallback has to carry it.
    { id: "t-text", title: "Cowboys collapse in the fourth", summary: "Dallas blew a 17-point lead.", leagueId: "NFL", evidenceIds: [{ type: "newsItem", id: "n1" }] },
    // Same nickname, different sport — must not cross over.
    { id: "t-mlb-cards", title: "Cardinals bullpen is a problem", leagueId: "MLB", evidenceIds: [] },
    { id: "t-nfl-cards", title: "Cardinals cannot protect the quarterback", leagueId: "NFL", evidenceIds: [] },
    // No league to scope by: a bare name is not enough to attribute.
    { id: "t-noleague", title: "Cowboys collapse in the fourth", leagueId: null, evidenceIds: [] },
    // An ordinary English word that is also a nickname.
    { id: "t-heat", title: "The heat of a playoff race", leagueId: "NBA", evidenceIds: [] },
    { id: "t-none", title: "Nothing identifiable here", leagueId: "NFL", evidenceIds: [] },
  ];

  const resolved = await resolveTakeTeams(takes, fakeDb);
  const slugs = (id: string) => (resolved.get(id) ?? []).map((r) => `${r.leagueId}/${r.teamSlug}`).sort();

  check("a game names both teams", slugs("t-game").join(",") === "NFL/buffalo-bills,NFL/kansas-city-chiefs", slugs("t-game").join(","));
  check("an odds snapshot resolves through its game", slugs("t-odds").join(",") === "NFL/buffalo-bills,NFL/kansas-city-chiefs", slugs("t-odds").join(","));
  check("an injury names one team", slugs("t-injury").join(",") === "NBA/los-angeles-lakers", slugs("t-injury").join(","));
  check("a team stat names one team", slugs("t-stat").join(",") === "MLB/new-york-yankees", slugs("t-stat").join(","));
  check("news-only takes fall back to the text", slugs("t-text").join(",") === "NFL/dallas-cowboys", slugs("t-text").join(","));
  check("a shared nickname stays in its own league (MLB)", slugs("t-mlb-cards").join(",") === "MLB/st-louis-cardinals", slugs("t-mlb-cards").join(","));
  check("a shared nickname stays in its own league (NFL)", slugs("t-nfl-cards").join(",") === "NFL/arizona-cardinals", slugs("t-nfl-cards").join(","));
  check("no league means no text attribution", slugs("t-noleague").length === 0, slugs("t-noleague").join(","));
  check("a nickname that is an ordinary word needs its city", slugs("t-heat").length === 0, slugs("t-heat").join(","));
  check("an unattributable take gets no team", slugs("t-none").length === 0, slugs("t-none").join(","));
  check("every take gets an entry, even an empty one", resolved.size === takes.length);

  console.log(
    failures === 0
      ? "\nAll board-browse checks passed."
      : `\n${failures} board-browse check(s) FAILED.`
  );
  if (failures > 0) process.exit(1);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
