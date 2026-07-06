// Canonical seeded teams for the podcast-creation verticals. This is the
// source of truth the additive migration 20260706150000_add_podcast_and_seed_teams
// was generated from (see src/scripts, scratch generator) — ids use a "seed:"
// prefix so they can never collide with ingestion-provider rows ("sio:...").
//
// Pro leagues: every current franchise. College: the Power-conference
// programs (SEC, Big Ten, Big 12, ACC + Notre Dame for football; those plus
// the Big East for basketball).

export interface SeedLeague {
  id: string;
  name: string;
  sport: string;
  slug: string;
}

export interface SeedTeam {
  id: string;
  leagueId: string;
  name: string; // display name (franchise nickname for pro, school for college)
  city: string; // pro only; "" for college programs
  abbreviation: string;
  slug: string;
}

export const SEED_LEAGUES: SeedLeague[] = [
  { id: "NFL", name: "National Football League", sport: "Football", slug: "nfl" },
  { id: "NBA", name: "National Basketball Association", sport: "Basketball", slug: "nba" },
  { id: "MLB", name: "Major League Baseball", sport: "Baseball", slug: "mlb" },
  { id: "NHL", name: "National Hockey League", sport: "Hockey", slug: "nhl" },
  { id: "NCAAF", name: "College Football", sport: "Football", slug: "college-football" },
  { id: "NCAAB", name: "College Basketball", sport: "Basketball", slug: "college-basketball" },
];

type ProTuple = [abbr: string, city: string, nickname: string];
type CollegeTuple = [abbr: string, school: string];

const NFL: ProTuple[] = [
  ["ARI", "Arizona", "Cardinals"], ["ATL", "Atlanta", "Falcons"], ["BAL", "Baltimore", "Ravens"],
  ["BUF", "Buffalo", "Bills"], ["CAR", "Carolina", "Panthers"], ["CHI", "Chicago", "Bears"],
  ["CIN", "Cincinnati", "Bengals"], ["CLE", "Cleveland", "Browns"], ["DAL", "Dallas", "Cowboys"],
  ["DEN", "Denver", "Broncos"], ["DET", "Detroit", "Lions"], ["GB", "Green Bay", "Packers"],
  ["HOU", "Houston", "Texans"], ["IND", "Indianapolis", "Colts"], ["JAX", "Jacksonville", "Jaguars"],
  ["KC", "Kansas City", "Chiefs"], ["LV", "Las Vegas", "Raiders"], ["LAC", "Los Angeles", "Chargers"],
  ["LAR", "Los Angeles", "Rams"], ["MIA", "Miami", "Dolphins"], ["MIN", "Minnesota", "Vikings"],
  ["NE", "New England", "Patriots"], ["NO", "New Orleans", "Saints"], ["NYG", "New York", "Giants"],
  ["NYJ", "New York", "Jets"], ["PHI", "Philadelphia", "Eagles"], ["PIT", "Pittsburgh", "Steelers"],
  ["SEA", "Seattle", "Seahawks"], ["SF", "San Francisco", "49ers"], ["TB", "Tampa Bay", "Buccaneers"],
  ["TEN", "Tennessee", "Titans"], ["WAS", "Washington", "Commanders"],
];

const NBA: ProTuple[] = [
  ["ATL", "Atlanta", "Hawks"], ["BOS", "Boston", "Celtics"], ["BKN", "Brooklyn", "Nets"],
  ["CHA", "Charlotte", "Hornets"], ["CHI", "Chicago", "Bulls"], ["CLE", "Cleveland", "Cavaliers"],
  ["DAL", "Dallas", "Mavericks"], ["DEN", "Denver", "Nuggets"], ["DET", "Detroit", "Pistons"],
  ["GSW", "Golden State", "Warriors"], ["HOU", "Houston", "Rockets"], ["IND", "Indiana", "Pacers"],
  ["LAC", "Los Angeles", "Clippers"], ["LAL", "Los Angeles", "Lakers"], ["MEM", "Memphis", "Grizzlies"],
  ["MIA", "Miami", "Heat"], ["MIL", "Milwaukee", "Bucks"], ["MIN", "Minnesota", "Timberwolves"],
  ["NOP", "New Orleans", "Pelicans"], ["NYK", "New York", "Knicks"], ["OKC", "Oklahoma City", "Thunder"],
  ["ORL", "Orlando", "Magic"], ["PHI", "Philadelphia", "76ers"], ["PHX", "Phoenix", "Suns"],
  ["POR", "Portland", "Trail Blazers"], ["SAC", "Sacramento", "Kings"], ["SAS", "San Antonio", "Spurs"],
  ["TOR", "Toronto", "Raptors"], ["UTA", "Utah", "Jazz"], ["WAS", "Washington", "Wizards"],
];

const MLB: ProTuple[] = [
  ["ARI", "Arizona", "Diamondbacks"], ["ATL", "Atlanta", "Braves"], ["BAL", "Baltimore", "Orioles"],
  ["BOS", "Boston", "Red Sox"], ["CHC", "Chicago", "Cubs"], ["CWS", "Chicago", "White Sox"],
  ["CIN", "Cincinnati", "Reds"], ["CLE", "Cleveland", "Guardians"], ["COL", "Colorado", "Rockies"],
  ["DET", "Detroit", "Tigers"], ["HOU", "Houston", "Astros"], ["KC", "Kansas City", "Royals"],
  ["LAA", "Los Angeles", "Angels"], ["LAD", "Los Angeles", "Dodgers"], ["MIA", "Miami", "Marlins"],
  ["MIL", "Milwaukee", "Brewers"], ["MIN", "Minnesota", "Twins"], ["NYM", "New York", "Mets"],
  ["NYY", "New York", "Yankees"], ["ATH", "Sacramento", "Athletics"], ["PHI", "Philadelphia", "Phillies"],
  ["PIT", "Pittsburgh", "Pirates"], ["SD", "San Diego", "Padres"], ["SF", "San Francisco", "Giants"],
  ["SEA", "Seattle", "Mariners"], ["STL", "St. Louis", "Cardinals"], ["TB", "Tampa Bay", "Rays"],
  ["TEX", "Texas", "Rangers"], ["TOR", "Toronto", "Blue Jays"], ["WSH", "Washington", "Nationals"],
];

const NHL: ProTuple[] = [
  ["ANA", "Anaheim", "Ducks"], ["BOS", "Boston", "Bruins"], ["BUF", "Buffalo", "Sabres"],
  ["CGY", "Calgary", "Flames"], ["CAR", "Carolina", "Hurricanes"], ["CHI", "Chicago", "Blackhawks"],
  ["COL", "Colorado", "Avalanche"], ["CBJ", "Columbus", "Blue Jackets"], ["DAL", "Dallas", "Stars"],
  ["DET", "Detroit", "Red Wings"], ["EDM", "Edmonton", "Oilers"], ["FLA", "Florida", "Panthers"],
  ["LAK", "Los Angeles", "Kings"], ["MIN", "Minnesota", "Wild"], ["MTL", "Montreal", "Canadiens"],
  ["NSH", "Nashville", "Predators"], ["NJD", "New Jersey", "Devils"], ["NYI", "New York", "Islanders"],
  ["NYR", "New York", "Rangers"], ["OTT", "Ottawa", "Senators"], ["PHI", "Philadelphia", "Flyers"],
  ["PIT", "Pittsburgh", "Penguins"], ["SJS", "San Jose", "Sharks"], ["SEA", "Seattle", "Kraken"],
  ["STL", "St. Louis", "Blues"], ["TBL", "Tampa Bay", "Lightning"], ["TOR", "Toronto", "Maple Leafs"],
  ["UTA", "Utah", "Mammoth"], ["VAN", "Vancouver", "Canucks"], ["VGK", "Vegas", "Golden Knights"],
  ["WSH", "Washington", "Capitals"], ["WPG", "Winnipeg", "Jets"],
];

// Power-conference football programs (SEC, Big Ten, Big 12, ACC) + Notre Dame.
const NCAAF: CollegeTuple[] = [
  // SEC
  ["ALA", "Alabama"], ["ARK", "Arkansas"], ["AUB", "Auburn"], ["FLA", "Florida"],
  ["UGA", "Georgia"], ["UK", "Kentucky"], ["LSU", "LSU"], ["MISS", "Ole Miss"],
  ["MSST", "Mississippi State"], ["MIZ", "Missouri"], ["OU", "Oklahoma"], ["SCAR", "South Carolina"],
  ["TENN", "Tennessee"], ["TEX", "Texas"], ["TAMU", "Texas A&M"], ["VAN", "Vanderbilt"],
  // Big Ten
  ["ILL", "Illinois"], ["IU", "Indiana"], ["IOWA", "Iowa"], ["UMD", "Maryland"],
  ["MICH", "Michigan"], ["MSU", "Michigan State"], ["MINN", "Minnesota"], ["NEB", "Nebraska"],
  ["NW", "Northwestern"], ["OSU", "Ohio State"], ["ORE", "Oregon"], ["PSU", "Penn State"],
  ["PUR", "Purdue"], ["RUT", "Rutgers"], ["UCLA", "UCLA"], ["USC", "USC"],
  ["WASH", "Washington"], ["WIS", "Wisconsin"],
  // Big 12
  ["ARIZ", "Arizona"], ["ASU", "Arizona State"], ["BAY", "Baylor"], ["BYU", "BYU"],
  ["CIN", "Cincinnati"], ["COLO", "Colorado"], ["HOU", "Houston"], ["ISU", "Iowa State"],
  ["KU", "Kansas"], ["KSU", "Kansas State"], ["OKST", "Oklahoma State"], ["TCU", "TCU"],
  ["TTU", "Texas Tech"], ["UCF", "UCF"], ["UTAH", "Utah"], ["WVU", "West Virginia"],
  // ACC
  ["BC", "Boston College"], ["CAL", "California"], ["CLEM", "Clemson"], ["DUKE", "Duke"],
  ["FSU", "Florida State"], ["GT", "Georgia Tech"], ["LOU", "Louisville"], ["MIA", "Miami"],
  ["UNC", "North Carolina"], ["NCST", "NC State"], ["PITT", "Pittsburgh"], ["SMU", "SMU"],
  ["STAN", "Stanford"], ["SYR", "Syracuse"], ["UVA", "Virginia"], ["VT", "Virginia Tech"],
  ["WAKE", "Wake Forest"],
  // Independent
  ["ND", "Notre Dame"],
];

// Major-conference basketball: the football list (Notre Dame plays ACC
// hoops) plus the Big East.
const NCAAB: CollegeTuple[] = [
  ...NCAAF,
  ["UCONN", "UConn"], ["NOVA", "Villanova"], ["GTWN", "Georgetown"], ["CREI", "Creighton"],
  ["MARQ", "Marquette"], ["XAV", "Xavier"], ["BUT", "Butler"], ["PROV", "Providence"],
  ["SJU", "St. John's"], ["HALL", "Seton Hall"], ["DEP", "DePaul"],
];

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function pro(leagueId: string, rows: ProTuple[]): SeedTeam[] {
  return rows.map(([abbreviation, city, nickname]) => ({
    id: `seed:${leagueId.toLowerCase()}:${abbreviation.toLowerCase()}`,
    leagueId,
    name: `${city} ${nickname}`,
    city,
    abbreviation,
    slug: `${leagueId.toLowerCase()}-${slugify(`${city} ${nickname}`)}-seed`,
  }));
}

function college(leagueId: string, rows: CollegeTuple[]): SeedTeam[] {
  return rows.map(([abbreviation, school]) => ({
    id: `seed:${leagueId.toLowerCase()}:${abbreviation.toLowerCase()}`,
    leagueId,
    name: school,
    city: "",
    abbreviation,
    slug: `${leagueId.toLowerCase()}-${slugify(school)}-seed`,
  }));
}

export const SEED_TEAMS: SeedTeam[] = [
  ...pro("NFL", NFL),
  ...pro("NBA", NBA),
  ...pro("MLB", MLB),
  ...pro("NHL", NHL),
  ...college("NCAAF", NCAAF),
  ...college("NCAAB", NCAAB),
];
