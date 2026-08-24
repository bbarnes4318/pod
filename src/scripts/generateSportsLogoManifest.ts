/**
 * Build the sports-logo manifest that The Board's league → conference → team
 * browser navigates.
 *
 * `public/sports-logos/` is the source of truth: ~460 team folders, each named
 * for the team and holding logo variants named for the team's abbreviation.
 * Reading that tree at request time would mean ~1,900 stat() calls per render,
 * so this script walks it ONCE and emits a typed module.
 *
 * Two things here cannot be guessed from a filename and are therefore MEASURED:
 *
 *   · Which variant to show. "-dark" means "for dark backgrounds" (verified:
 *     ALA-dark.png is pure white, ALA-light.png is near-black), and the studio
 *     is a dark surface — but the convention is not universally honoured, and
 *     some marks are dark in BOTH variants. Each candidate is rasterised and
 *     its mean opaque luminance compared, so the file that is actually legible
 *     on the studio background wins.
 *
 *   · Which marks still need a light plate behind them. A logo that is dark in
 *     every variant (the Pac-12 wordmark is pure black) is invisible on that
 *     background; those are flagged so the UI can put them on a light tile
 *     instead of shipping an empty square.
 *
 * Run:  npm run logos:manifest
 */

import fs from "fs";
import path from "path";
import sharp from "sharp";

const PUBLIC_DIR = path.join(process.cwd(), "public", "sports-logos");
const OUT_FILE = path.join(process.cwd(), "src", "lib", "data", "sportsLogos.generated.ts");

/** Mean luminance (0-255) below which a mark disappears into the studio bg. */
const PLATE_BELOW = 72;

/* ------------------------------------------------------------------ *
 * League wiring — the only hand-written part. Each entry ties a folder
 * to the League row the topic pipeline stamps on a take (League.id).
 * ------------------------------------------------------------------ */

interface LeagueSpec {
  /** League.id in the database — how takes are attributed. */
  id: string;
  name: string;
  shortName: string;
  sport: string;
  /** Folder under public/sports-logos that holds this league's teams. */
  dir: string;
  /** Colleges nest teams under conference folders; pro leagues do not. */
  tiered: boolean;
}

const LEAGUES: LeagueSpec[] = [
  { id: "NFL", name: "National Football League", shortName: "NFL", sport: "Football", dir: "nfl", tiered: false },
  { id: "NBA", name: "National Basketball Association", shortName: "NBA", sport: "Basketball", dir: "nba", tiered: false },
  { id: "MLB", name: "Major League Baseball", shortName: "MLB", sport: "Baseball", dir: "mlb", tiered: false },
  { id: "NCAAF", name: "College Football", shortName: "CFB", sport: "Football", dir: "cfb-logos", tiered: true },
  { id: "NCAAB", name: "College Basketball", shortName: "CBB", sport: "Basketball", dir: path.join("cbb-logos", "mens"), tiered: true },
];

/* ------------------------------------------------------------------ *
 * Display names
 * ------------------------------------------------------------------ */

/** Slug tokens that are initialisms and must never be title-cased. */
const ACRONYMS = new Set([
  "byu", "lsu", "smu", "tcu", "ucf", "ucla", "unlv", "usc", "utep", "utsa", "uab", "uic", "unc",
  "vcu", "vmi", "njit", "umbc", "siu", "iu", "nc", "ut", "uc", "ul", "iupui", "fiu", "fau", "etsu",
  "usf", "unt", "uta", "utrgv", "uapb", "unca", "sfa", "smc", "nyit", "gw", "bc", "csu", "nau",
  "ucsd", "uncw", "unco", "usu", "byui",
]);

/** Tokens whose display form is neither lower-case nor Title Case. */
const TOKEN_OVERRIDES: Record<string, string> = {
  am: "A&M",
  at: "A&T",
  st: "St.",
  oh: "(OH)",
  uconn: "UConn",
  umass: "UMass",
  ualbany: "UAlbany",
  johns: "John's",
  marys: "Mary's",
  josephs: "Joseph's",
  peters: "Peter's",
  mcneese: "McNeese",
};

/**
 * Conference display + nav names. A folder slug title-cases into something
 * nobody says out loud ("Conference Usa", "Metro Conference" for the MAAC), and
 * the drill-down tiles need the name a fan would actually scan for.
 */
const CONFERENCES: Record<string, { name: string; shortName: string }> = {
  "america-east-conference": { name: "America East Conference", shortName: "America East" },
  "american-conference": { name: "American Athletic Conference", shortName: "American" },
  "atlantic-10-conference": { name: "Atlantic 10 Conference", shortName: "A-10" },
  "atlantic-coast-conference": { name: "Atlantic Coast Conference", shortName: "ACC" },
  "atlantic-sun-conference": { name: "ASUN Conference", shortName: "ASUN" },
  "big-12-conference": { name: "Big 12 Conference", shortName: "Big 12" },
  "big-east-conference": { name: "Big East Conference", shortName: "Big East" },
  "big-sky-conference": { name: "Big Sky Conference", shortName: "Big Sky" },
  "big-south-conference": { name: "Big South Conference", shortName: "Big South" },
  "big-ten-conference": { name: "Big Ten Conference", shortName: "Big Ten" },
  "big-west-conference": { name: "Big West Conference", shortName: "Big West" },
  "coastal-athletic-association": { name: "Coastal Athletic Association", shortName: "CAA" },
  "conference-usa": { name: "Conference USA", shortName: "C-USA" },
  "fbs-independents": { name: "FBS Independents", shortName: "Independents" },
  "horizon-league": { name: "Horizon League", shortName: "Horizon" },
  "ivy-league": { name: "Ivy League", shortName: "Ivy" },
  "metro-conference": { name: "Metro Atlantic Athletic Conference", shortName: "MAAC" },
  "mid-american-conference": { name: "Mid-American Conference", shortName: "MAC" },
  "mid-eastern-athletic-conference": { name: "Mid-Eastern Athletic Conference", shortName: "MEAC" },
  "missouri-valley-conference": { name: "Missouri Valley Conference", shortName: "MVC" },
  "mountain-west-conference": { name: "Mountain West Conference", shortName: "Mountain West" },
  "northeast-conference": { name: "Northeast Conference", shortName: "NEC" },
  "ohio-valley-conference": { name: "Ohio Valley Conference", shortName: "OVC" },
  "pac-12-conference": { name: "Pac-12 Conference", shortName: "Pac-12" },
  "patriot-league": { name: "Patriot League", shortName: "Patriot" },
  "southeastern-conference": { name: "Southeastern Conference", shortName: "SEC" },
  "southern-conference": { name: "Southern Conference", shortName: "SoCon" },
  "southland-conference": { name: "Southland Conference", shortName: "Southland" },
  "southwestern-athletic-conference": { name: "Southwestern Athletic Conference", shortName: "SWAC" },
  "summit-league": { name: "Summit League", shortName: "Summit" },
  "sun-belt-conference": { name: "Sun Belt Conference", shortName: "Sun Belt" },
  "united-athletic-conference": { name: "United Athletic Conference", shortName: "UAC" },
  "west-coast-conference": { name: "West Coast Conference", shortName: "WCC" },
};

/** Whole slugs the token rules cannot reach. */
const SLUG_OVERRIDES: Record<string, string> = {
  "la-clippers": "LA Clippers",
  "arkansas-pine-bluff-golden-lions": "Arkansas-Pine Bluff Golden Lions",
  "texas-am-corpus-christi-islanders": "Texas A&M-Corpus Christi Islanders",
  "bethune-cookman-wildcats": "Bethune-Cookman Wildcats",
  "gardner-webb-runnin-bulldogs": "Gardner-Webb Runnin' Bulldogs",
  "louisiana-ragin-cajuns": "Louisiana Ragin' Cajuns",
  "se-louisiana-lions": "Southeastern Louisiana Lions",
  "stephen-f-austin-lumberjacks": "Stephen F. Austin Lumberjacks",
  "depaul-blue-demons": "DePaul Blue Demons",
  // The Privateers are New Orleans, not LSU — the folder carries the old
  // LSUNO name, which title-cases into a school that does not exist.
  "lsu-new-orleans-privateers": "New Orleans Privateers",
  // The folder name is mojibake in the source assets ("josa~"). The path must
  // keep those bytes; the display name must not.
  "san-josã-state-spartans": "San José State Spartans",
  "william-mary-tribe": "William & Mary Tribe",
  "north-carolina-at-aggies": "North Carolina A&T Aggies",
  "texas-am-aggies": "Texas A&M Aggies",
  "florida-am-rattlers": "Florida A&M Rattlers",
  "alabama-am-bulldogs": "Alabama A&M Bulldogs",
  "prairie-view-am-panthers": "Prairie View A&M Panthers",
  "miami-oh-redhawks": "Miami (OH) RedHawks",
  "saint-josephs-hawks": "Saint Joseph's Hawks",
  "st-johns-red-storm": "St. John's Red Storm",
  "mount-st-marys-mountaineers": "Mount St. Mary's Mountaineers",
  "saint-peters-peacocks": "Saint Peter's Peacocks",
  "saint-marys-gaels": "Saint Mary's Gaels",
  "long-beach-state-beach": "Long Beach State Beach",
  "ole-miss-rebels": "Ole Miss Rebels",
  "umass-lowell-river-hawks": "UMass Lowell River Hawks",
};

function titleCase(slug: string): string {
  if (SLUG_OVERRIDES[slug]) return SLUG_OVERRIDES[slug];
  return slug
    .split("-")
    .map((tok) => {
      if (TOKEN_OVERRIDES[tok]) return TOKEN_OVERRIDES[tok];
      if (ACRONYMS.has(tok)) return tok.toUpperCase();
      if (/^[0-9]/.test(tok)) return tok;
      return tok.charAt(0).toUpperCase() + tok.slice(1);
    })
    .join(" ");
}

/* ------------------------------------------------------------------ *
 * Logo choice
 * ------------------------------------------------------------------ */

/**
 * Variants in the order we would LIKE to use them: vector first (these render
 * at any tile size), full-colour primary mark before a knockout, and always
 * the "-dark" (i.e. for-dark-background) cut before its light-background twin.
 */
const VARIANT_ORDER = [
  "-primary-dark.svg",
  "-dark.png",
  "-primary.svg",
  "-global.svg",
  "-cap-dark.svg",
  "-500.png",
  "-light.png",
  "-primary-light.svg",
  "-cap-light.svg",
];

interface Measured {
  file: string;
  /** Mean luminance of the opaque pixels, 0-255. */
  lum: number;
  /** The mark carries its own background rather than sitting on transparency. */
  opaqueRect: boolean;
}

const measureCache = new Map<string, Measured>();

async function measure(file: string): Promise<Measured> {
  const cached = measureCache.get(file);
  if (cached) return cached;
  // 64px is plenty to average a mark and keeps ~1,400 rasterisations quick.
  const { data, info } = await sharp(file)
    .resize(64, 64, { fit: "inside" })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  let lum = 0;
  let opaque = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 128) continue;
    lum += 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
    opaque++;
  }
  const total = info.width * info.height;
  const out: Measured = {
    file,
    lum: opaque ? lum / opaque : 0,
    opaqueRect: total > 0 && opaque / total > 0.97,
  };
  measureCache.set(file, out);
  return out;
}

/** The abbreviation a team's files are named for, e.g. "DAL" from DAL-dark.png. */
function abbrOf(files: string[]): string | null {
  for (const suffix of VARIANT_ORDER) {
    const hit = files.find((f) => f.endsWith(suffix));
    if (hit) return hit.slice(0, -suffix.length);
  }
  return null;
}

/** Web path for a file on disk, percent-encoded (one folder is "san-jose-…"). */
function webPath(abs: string): string {
  const rel = path.relative(path.join(process.cwd(), "public"), abs).split(path.sep);
  return "/" + rel.map(encodeURIComponent).join("/");
}

interface PickedLogo {
  logo: string;
  plate: boolean;
}

/**
 * Choose the variant that is actually legible on the studio's dark surface.
 * Preference order wins when the preferred cut is bright enough; otherwise the
 * brightest candidate does. If nothing clears the floor the mark is flagged for
 * a light plate rather than shipped as an invisible square.
 */
async function pickLogo(dir: string, files: string[]): Promise<PickedLogo | null> {
  const candidates: string[] = [];
  for (const suffix of VARIANT_ORDER) {
    const hit = files.find((f) => f.endsWith(suffix));
    if (hit) candidates.push(path.join(dir, hit));
  }
  if (candidates.length === 0) return null;

  const measured: Measured[] = [];
  for (const c of candidates) {
    try {
      measured.push(await measure(c));
    } catch {
      // A file sharp cannot decode is simply not a candidate.
    }
  }
  if (measured.length === 0) return null;

  const preferred = measured.find((m) => m.lum >= PLATE_BELOW);
  if (preferred) return { logo: webPath(preferred.file), plate: preferred.opaqueRect };

  const brightest = measured.reduce((a, b) => (b.lum > a.lum ? b : a));
  return { logo: webPath(brightest.file), plate: true };
}

/** primary/alternate hex from a team folder's colors.txt, when one exists. */
function readColors(dir: string): { primary?: string; alternate?: string } {
  const file = path.join(dir, "colors.txt");
  if (!fs.existsSync(file)) return {};
  const out: { primary?: string; alternate?: string } = {};
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^(primary|alternate)\s*=\s*(#[0-9a-fA-F]{3,8})\s*$/.exec(line.trim());
    if (m) out[m[1] as "primary" | "alternate"] = m[2].toLowerCase();
  }
  return out;
}

const isDir = (p: string) => fs.existsSync(p) && fs.statSync(p).isDirectory();
const subdirs = (p: string) => fs.readdirSync(p).filter((e) => isDir(path.join(p, e))).sort();
const filesIn = (p: string) => fs.readdirSync(p).filter((e) => !isDir(path.join(p, e)));

/* ------------------------------------------------------------------ */

interface OutTeam {
  slug: string;
  name: string;
  abbr: string;
  logo: string;
  plate: boolean;
  primary?: string;
  alternate?: string;
}
interface OutConference {
  slug: string;
  name: string;
  shortName: string;
  logo?: string;
  plate?: boolean;
  teams: OutTeam[];
}
interface OutLeague {
  id: string;
  name: string;
  shortName: string;
  sport: string;
  slug: string;
  logo?: string;
  plate?: boolean;
  conferences: OutConference[];
  teams: OutTeam[];
}

async function readTeam(dir: string, slug: string): Promise<OutTeam | null> {
  const files = filesIn(dir);
  const abbr = abbrOf(files);
  const picked = await pickLogo(dir, files);
  if (!abbr || !picked) return null;
  return { slug, name: titleCase(slug), abbr, ...picked, ...readColors(dir) };
}

async function main() {
  const leagues: OutLeague[] = [];
  let teamCount = 0;
  let plateCount = 0;

  for (const spec of LEAGUES) {
    const root = path.join(PUBLIC_DIR, spec.dir);
    if (!isDir(root)) throw new Error(`Missing logo folder for ${spec.id}: ${root}`);

    const leagueMark = await pickLogo(root, filesIn(root));
    const league: OutLeague = {
      id: spec.id,
      name: spec.name,
      shortName: spec.shortName,
      sport: spec.sport,
      slug: spec.dir.split(path.sep)[0],
      logo: leagueMark?.logo,
      plate: leagueMark?.plate,
      conferences: [],
      teams: [],
    };

    if (spec.tiered) {
      for (const confSlug of subdirs(root)) {
        const confDir = path.join(root, confSlug);
        const confMark = await pickLogo(confDir, filesIn(confDir));
        const teams: OutTeam[] = [];
        for (const teamSlug of subdirs(confDir)) {
          const team = await readTeam(path.join(confDir, teamSlug), teamSlug);
          if (team) teams.push(team);
        }
        teams.sort((a, b) => a.name.localeCompare(b.name));
        const named = CONFERENCES[confSlug];
        if (!named) throw new Error(`Unnamed conference folder "${confSlug}" — add it to CONFERENCES.`);
        league.conferences.push({
          slug: confSlug,
          name: named.name,
          shortName: named.shortName,
          logo: confMark?.logo,
          plate: confMark?.plate,
          teams,
        });
      }
      league.conferences.sort((a, b) => a.name.localeCompare(b.name));
      league.teams = league.conferences.flatMap((c) => c.teams);
    } else {
      for (const teamSlug of subdirs(root)) {
        const team = await readTeam(path.join(root, teamSlug), teamSlug);
        if (team) league.teams.push(team);
      }
      league.teams.sort((a, b) => a.name.localeCompare(b.name));
    }

    teamCount += league.teams.length;
    plateCount += league.teams.filter((t) => t.plate).length;
    leagues.push(league);
    console.log(
      `${spec.id.padEnd(6)} ${String(league.teams.length).padStart(3)} teams` +
        (spec.tiered ? ` across ${league.conferences.length} conferences` : "")
    );
  }

  const body = `// GENERATED FILE — do not edit by hand.
// Source: public/sports-logos/**  ·  Regenerate: npm run logos:manifest
// See src/scripts/generateSportsLogoManifest.ts for how variants are chosen.

import type { LogoLeague } from "./sportsLogoTypes";

export const SPORTS_LOGO_LEAGUES: LogoLeague[] = ${JSON.stringify(leagues, null, 2)};
`;
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, body);
  console.log(
    `\nWrote ${path.relative(process.cwd(), OUT_FILE)} — ${teamCount} teams, ${plateCount} on a light plate.`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
