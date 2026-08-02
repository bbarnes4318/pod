// DURABLE EVENT IDENTITY — the primitives that survive a paraphrase.
//
// WHY THIS EXISTS
// ---------------
// `storyClustering.ts` originally shipped with an "anchor rule": a merge was
// only ever allowed when the code could NAME a hard shared identifier — the
// same Game row, the same evidence row, the same article URL, or a heavy
// overlap of literal proper nouns. That was honest about precision and it was
// REJECTED, correctly: three topics about one event that have every identifier
// stripped and are reworded to avoid the exact team and player names are still
// three topics about one event. A duplicate must not be able to escape by
// changing its vocabulary.
//
// This module supplies the signals that let a merge be BOTH nameable and
// paraphrase-proof:
//
//   1. ENTITY ALIAS RESOLUTION — "the Halos", "Angels", "LAA", "Los Angeles
//      Angels" and "Anaheim" all resolve to one canonical id (MLB:LAA). Team
//      names are league-scoped, because "Rangers", "Giants", "Kings", "Jets",
//      "Panthers" and "Cardinals" each name two different franchises.
//   2. CLAIM FINGERPRINTS — the propositional content of a headline reduced to
//      normalized atoms (actor/action/object/outcome/magnitude). "the AL blanked
//      the NL four to nothing", "American League shuts out National League 4-0"
//      and "a four-run shutout" all yield `score:4-0` + `act:shutout`.
//      Spelled-out numbers become digits and scores are orientation-normalized
//      (`4-0` and `0-4` are the same atom) so perspective flips still match.
//   3. CONCEPT EXPANSION — a curated sports-domain synonym/concept lexicon
//      ("blanked"/"shutout"/"whitewash"/"scoreless" -> SHUTOUT) so two writers
//      who never picked the same verb still land on the same vector dimensions.
//
// ON "EMBEDDINGS", STATED PLAINLY
// -------------------------------
// There is no embedding API available to this codebase (Anthropic-only, out of
// credit) and CI has to be deterministic and offline. So there are NO learned
// embeddings here and nothing in this file pretends otherwise. What stands in
// for them is the three-part combination above: distributional similarity over
// a CURATED DOMAIN LEXICON (concept expansion), plus claim-fingerprint
// matching, plus entity-alias resolution. That is weaker than a real sentence
// encoder on open-domain text and stronger than raw bag-of-words on sports
// prose, which is the only domain this runs on. `EmbeddingHook` below is an
// OPTIONAL, OFF-BY-DEFAULT seam for a real encoder; when it is unset — which is
// always, today — every path in this module and in `storyClustering.ts` works
// unchanged. The offline path is the product, not a fallback.
//
// Everything here is pure, synchronous, allocation-only and clock-free.

// ---------------------------------------------------------------------------
// Text normalization (moved here from storyClustering so the identity
// primitives have no import cycle; storyClustering re-exports them unchanged).
// ---------------------------------------------------------------------------

export const STOPWORDS = new Set<string>([
  "a", "about", "after", "again", "against", "all", "am", "an", "and", "any", "are", "aren",
  "as", "at", "be", "became", "because", "been", "before", "being", "below", "between", "both",
  "but", "by", "can", "cant", "could", "couldnt", "did", "didnt", "do", "does", "doesnt", "doing",
  "dont", "down", "during", "each", "few", "for", "from", "further", "get", "gets", "got", "had",
  "has", "hasnt", "have", "havent", "having", "he", "her", "here", "hers", "him", "his", "how",
  "i", "if", "in", "into", "is", "isnt", "it", "its", "just", "like", "made", "make", "makes",
  "me", "might", "more", "most", "much", "must", "my", "never", "no", "nor", "not", "now", "of",
  "off", "on", "once", "one", "only", "or", "other", "our", "out", "over", "own", "really", "s",
  "same", "say", "says", "she", "should", "so", "some", "still", "such", "t", "than", "that",
  "the", "their", "theirs", "them", "then", "there", "these", "they", "this", "those", "through",
  "to", "too", "under", "until", "up", "very", "was", "wasnt", "we", "were", "what", "when",
  "where", "which", "while", "who", "whom", "why", "will", "with", "would", "you", "your", "yours",
  // Question scaffolding: every generated topic title is a question, so these
  // carry no information about WHICH story a topic is.
  "did", "does", "is", "are", "was", "were", "should", "could", "can", "has", "have", "will",
  "just", "real", "actually", "even",
]);

/** Very light suffix stripper — enough to fold pitcher/pitchers, shut/shutout
 *  style variants together without dragging in a real stemmer dependency. */
export function stemWord(word: string): string {
  let w = word;
  if (w.length > 4 && w.endsWith("ies")) return `${w.slice(0, -3)}y`;
  if (w.length > 4 && w.endsWith("sses")) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith("ss")) return w;
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("us")) w = w.slice(0, -1);
  if (w.length > 5 && w.endsWith("ing")) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith("ed")) w = w.slice(0, -2);
  if (w.length > 4 && w.endsWith("er")) w = w.slice(0, -2);
  return w;
}

/** Case/punctuation/spacing-insensitive headline form (matches the generator's
 *  own normalizeTitle contract in topicIngestion.ts). */
export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[‘’“”]/g, "'")
    .replace(/[^a-z0-9'-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Stopword-stripped, stemmed content tokens. Hyphenated compounds are kept
 *  whole ("all-star") AND split, so "All-Star" matches "all star". */
export function contentTokens(text: string | null | undefined): string[] {
  if (!text) return [];
  const out: string[] = [];
  for (const raw of normalizeText(text).split(" ")) {
    if (!raw) continue;
    const bare = raw.replace(/'/g, "");
    if (bare.includes("-")) {
      const joined = bare.replace(/-/g, "");
      if (joined.length > 2 && !STOPWORDS.has(joined)) out.push(stemWord(joined));
      for (const part of bare.split("-")) {
        if (part.length > 2 && !STOPWORDS.has(part)) out.push(stemWord(part));
      }
      continue;
    }
    if (bare.length < 2) continue;
    if (STOPWORDS.has(bare)) continue;
    if (/^\d+$/.test(bare) && bare.length < 3) continue;
    out.push(stemWord(bare));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Canonical team / franchise aliases
// ---------------------------------------------------------------------------
//
// Encoding: LEAGUE|ABBR|City|Nickname|extra,aliases
// The canonical id is `LEAGUE:ABBR`. Full name (City + Nickname), city alone,
// nickname alone, the abbreviation and every listed colloquialism all resolve
// to it. Nicknames are LEAGUE-SCOPED on purpose — "Rangers" is a hockey team in
// New York and a baseball team in Texas, and merging those would be a bug.

const TEAM_TABLE: string[] = [
  // ---- MLB -----------------------------------------------------------------
  "MLB|ARI|Arizona|Diamondbacks|D-backs,Dbacks,Snakes,Phoenix",
  "MLB|ATL|Atlanta|Braves|",
  "MLB|BAL|Baltimore|Orioles|O's,Os,Birds",
  "MLB|BOS|Boston|Red Sox|Sox,BoSox,Redsox",
  "MLB|CHC|Chicago|Cubs|Cubbies,North Siders",
  "MLB|CWS|Chicago|White Sox|South Siders,ChiSox,Whitesox",
  "MLB|CIN|Cincinnati|Reds|Redlegs",
  "MLB|CLE|Cleveland|Guardians|Tribe",
  "MLB|COL|Colorado|Rockies|Rox,Denver",
  "MLB|DET|Detroit|Tigers|",
  "MLB|HOU|Houston|Astros|Stros",
  "MLB|KC|Kansas City|Royals|",
  "MLB|LAA|Los Angeles|Angels|Halos,Anaheim,Anaheim Angels,LA Angels,Los Angeles Angels of Anaheim",
  "MLB|LAD|Los Angeles|Dodgers|LA Dodgers,Boys in Blue",
  "MLB|MIA|Miami|Marlins|Fish,Florida Marlins",
  "MLB|MIL|Milwaukee|Brewers|Crew,Brew Crew",
  "MLB|MIN|Minnesota|Twins|Minneapolis",
  "MLB|NYM|New York|Mets|Amazins",
  "MLB|NYY|New York|Yankees|Yanks,Bronx Bombers,Pinstripes",
  "MLB|OAK|Oakland|Athletics|A's,As,Sacramento Athletics",
  "MLB|PHI|Philadelphia|Phillies|Phils",
  "MLB|PIT|Pittsburgh|Pirates|Bucs,Buccos",
  "MLB|SD|San Diego|Padres|Friars",
  "MLB|SF|San Francisco|Giants|",
  "MLB|SEA|Seattle|Mariners|M's,Ms",
  "MLB|STL|St. Louis|Cardinals|Cards,Redbirds,St Louis",
  "MLB|TB|Tampa Bay|Rays|Devil Rays",
  "MLB|TEX|Texas|Rangers|Arlington",
  "MLB|TOR|Toronto|Blue Jays|Jays,Bluejays",
  "MLB|WSH|Washington|Nationals|Nats",
  // ---- NFL -----------------------------------------------------------------
  "NFL|ARI|Arizona|Cardinals|Cards,Phoenix",
  "NFL|ATL|Atlanta|Falcons|",
  "NFL|BAL|Baltimore|Ravens|",
  "NFL|BUF|Buffalo|Bills|",
  "NFL|CAR|Carolina|Panthers|Charlotte",
  "NFL|CHI|Chicago|Bears|",
  "NFL|CIN|Cincinnati|Bengals|",
  "NFL|CLE|Cleveland|Browns|",
  "NFL|DAL|Dallas|Cowboys|America's Team",
  "NFL|DEN|Denver|Broncos|",
  "NFL|DET|Detroit|Lions|",
  "NFL|GB|Green Bay|Packers|Pack",
  "NFL|HOU|Houston|Texans|",
  "NFL|IND|Indianapolis|Colts|Indy",
  "NFL|JAX|Jacksonville|Jaguars|Jags",
  "NFL|KC|Kansas City|Chiefs|",
  "NFL|LV|Las Vegas|Raiders|Oakland Raiders,Vegas",
  "NFL|LAC|Los Angeles|Chargers|Bolts,San Diego Chargers",
  "NFL|LAR|Los Angeles|Rams|St. Louis Rams",
  "NFL|MIA|Miami|Dolphins|Fins",
  "NFL|MIN|Minnesota|Vikings|Vikes",
  "NFL|NE|New England|Patriots|Pats,Foxborough",
  "NFL|NO|New Orleans|Saints|",
  "NFL|NYG|New York|Giants|G-Men",
  "NFL|NYJ|New York|Jets|",
  "NFL|PHI|Philadelphia|Eagles|Iggles",
  "NFL|PIT|Pittsburgh|Steelers|",
  "NFL|SF|San Francisco|49ers|Niners,Forty Niners",
  "NFL|SEA|Seattle|Seahawks|",
  "NFL|TB|Tampa Bay|Buccaneers|Bucs",
  "NFL|TEN|Tennessee|Titans|Nashville",
  "NFL|WAS|Washington|Commanders|Washington Football Team",
  // ---- NBA -----------------------------------------------------------------
  "NBA|ATL|Atlanta|Hawks|",
  "NBA|BOS|Boston|Celtics|",
  "NBA|BKN|Brooklyn|Nets|New Jersey Nets",
  "NBA|CHA|Charlotte|Hornets|",
  "NBA|CHI|Chicago|Bulls|",
  "NBA|CLE|Cleveland|Cavaliers|Cavs",
  "NBA|DAL|Dallas|Mavericks|Mavs",
  "NBA|DEN|Denver|Nuggets|",
  "NBA|DET|Detroit|Pistons|",
  "NBA|GSW|Golden State|Warriors|Dubs,Bay Area",
  "NBA|HOU|Houston|Rockets|",
  "NBA|IND|Indiana|Pacers|Indianapolis",
  "NBA|LAC|Los Angeles|Clippers|Clips",
  "NBA|LAL|Los Angeles|Lakers|",
  "NBA|MEM|Memphis|Grizzlies|Grizz",
  "NBA|MIA|Miami|Heat|",
  "NBA|MIL|Milwaukee|Bucks|",
  "NBA|MIN|Minnesota|Timberwolves|Wolves,Minneapolis",
  "NBA|NOP|New Orleans|Pelicans|Pels",
  "NBA|NYK|New York|Knicks|Knickerbockers",
  "NBA|OKC|Oklahoma City|Thunder|",
  "NBA|ORL|Orlando|Magic|",
  "NBA|PHI|Philadelphia|76ers|Sixers",
  "NBA|PHX|Phoenix|Suns|",
  "NBA|POR|Portland|Trail Blazers|Blazers",
  "NBA|SAC|Sacramento|Kings|",
  "NBA|SAS|San Antonio|Spurs|",
  "NBA|TOR|Toronto|Raptors|Raps",
  "NBA|UTA|Utah|Jazz|Salt Lake City",
  "NBA|WAS|Washington|Wizards|",
  // ---- NHL -----------------------------------------------------------------
  "NHL|ANA|Anaheim|Ducks|Mighty Ducks",
  "NHL|BOS|Boston|Bruins|",
  "NHL|BUF|Buffalo|Sabres|",
  "NHL|CGY|Calgary|Flames|",
  "NHL|CAR|Carolina|Hurricanes|Canes,Raleigh",
  "NHL|CHI|Chicago|Blackhawks|",
  "NHL|COL|Colorado|Avalanche|Avs,Denver",
  "NHL|CBJ|Columbus|Blue Jackets|Jackets",
  "NHL|DAL|Dallas|Stars|",
  "NHL|DET|Detroit|Red Wings|Wings",
  "NHL|EDM|Edmonton|Oilers|",
  "NHL|FLA|Florida|Panthers|Sunrise",
  "NHL|LAK|Los Angeles|Kings|",
  "NHL|MIN|Minnesota|Wild|",
  "NHL|MTL|Montreal|Canadiens|Habs",
  "NHL|NSH|Nashville|Predators|Preds",
  "NHL|NJD|New Jersey|Devils|",
  "NHL|NYI|New York|Islanders|Isles",
  "NHL|NYR|New York|Rangers|Broadway Blueshirts",
  "NHL|OTT|Ottawa|Senators|Sens",
  "NHL|PHI|Philadelphia|Flyers|",
  "NHL|PIT|Pittsburgh|Penguins|Pens",
  "NHL|SJS|San Jose|Sharks|",
  "NHL|SEA|Seattle|Kraken|",
  "NHL|STL|St. Louis|Blues|St Louis",
  "NHL|TBL|Tampa Bay|Lightning|Bolts",
  "NHL|TOR|Toronto|Maple Leafs|Leafs",
  "NHL|UTA|Utah|Mammoth|Utah Hockey Club",
  "NHL|VAN|Vancouver|Canucks|",
  "NHL|VGK|Vegas|Golden Knights|Las Vegas,Knights",
  "NHL|WSH|Washington|Capitals|Caps",
  "NHL|WPG|Winnipeg|Jets|",
];

/** Sub-league sides that behave like teams in exhibition/championship prose. */
const LEAGUE_GROUP_TABLE: string[] = [
  "MLB|AL|American League|AL|American Leaguers",
  "MLB|NL|National League|NL|National Leaguers",
  "NFL|AFC|American Football Conference|AFC|",
  "NFL|NFC|National Football Conference|NFC|",
  "NBA|EAST|Eastern Conference|East|",
  "NBA|WEST|Western Conference|West|",
  "NHL|EAST|Eastern Conference|East|",
  "NHL|WEST|Western Conference|West|",
];

interface TeamEntry {
  canonical: string;
  league: string;
  abbr: string;
  display: string;
}

const ALIAS_INDEX = new Map<string, TeamEntry[]>();
const CANONICAL_DISPLAY = new Map<string, string>();

function indexAlias(alias: string, entry: TeamEntry): void {
  const key = normalizeText(alias).replace(/'/g, "");
  if (!key || key.length < 2) return;
  const list = ALIAS_INDEX.get(key);
  if (!list) ALIAS_INDEX.set(key, [entry]);
  else if (!list.some((e) => e.canonical === entry.canonical)) list.push(entry);
}

function buildTeamIndex(): void {
  const rows = [
    ...TEAM_TABLE.map((r) => ({ raw: r, group: false })),
    ...LEAGUE_GROUP_TABLE.map((r) => ({ raw: r, group: true })),
  ];
  for (const { raw, group } of rows) {
    const [league, abbr, city, nickname, extras] = raw.split("|");
    const canonical = `${league}:${abbr}`;
    const display = group ? city : `${city} ${nickname}`;
    const entry: TeamEntry = { canonical, league, abbr, display };
    CANONICAL_DISPLAY.set(canonical, display);
    indexAlias(display, entry);
    indexAlias(nickname, entry);
    indexAlias(abbr, entry);
    if (!group) indexAlias(city, entry);
    for (const extra of (extras || "").split(",")) {
      if (extra.trim()) indexAlias(extra.trim(), entry);
    }
  }
}
buildTeamIndex();

/** Operator-facing name for a canonical id ("MLB:LAA" -> "Los Angeles Angels"). */
export function describeCanonicalEntity(canonical: string): string {
  if (canonical.startsWith("AMB:")) return `${canonical.slice(4)} (ambiguous across leagues)`;
  return CANONICAL_DISPLAY.get(canonical) ?? canonical;
}

/**
 * Resolve one surface form to a canonical franchise id.
 *
 * `league` disambiguates shared nicknames. With no league and an ambiguous
 * alias the result is `AMB:<alias>`, which still compares equal to another
 * mention of the same ambiguous alias but never to a resolved franchise — a
 * deliberately conservative choice, since guessing wrong invents a shared team.
 */
export function canonicalizeTeamName(name: string, league?: string | null): string | null {
  const key = normalizeText(name).replace(/'/g, "").replace(/\s+/g, " ").trim();
  if (!key) return null;
  const entries = ALIAS_INDEX.get(key);
  if (!entries || entries.length === 0) return null;
  const lg = (league || "").trim().toUpperCase();
  if (lg) {
    const scoped = entries.filter((e) => e.league === lg);
    if (scoped.length === 1) return scoped[0].canonical;
    if (scoped.length > 1) return `AMB:${key}`;
  }
  if (entries.length === 1) return entries[0].canonical;
  return `AMB:${key}`;
}

// ---------------------------------------------------------------------------
// Capitalized-run scanning: teams and people out of raw prose
// ---------------------------------------------------------------------------

/**
 * Common English words and sports role nouns that appear capitalized in
 * headline case but are never a person's name. Without this a title-case
 * headline ("Was One Veteran's Return the Only Story?") manufactures people out
 * of ordinary words, and a fabricated person is worse than no person: it makes
 * two paraphrases of one event look like two different casts.
 */
const COMMON_WORDS = new Set<string>([
  // determiners / function words / headline furniture
  "a", "about", "after", "again", "against", "all", "already", "also", "always", "am", "an",
  "and", "another", "any", "anyone", "are", "around", "as", "at", "back", "be", "became",
  "because", "become", "been", "before", "behind", "being", "below", "best", "better", "between",
  "big", "both", "but", "by", "can", "cant", "could", "day", "days", "did", "do", "does", "done",
  "down", "during", "each", "early", "either", "else", "enough", "even", "ever", "every", "far",
  "few", "final", "first", "for", "from", "full", "further", "get", "gets", "give", "go", "going",
  "gone", "good", "got", "great", "had", "half", "has", "have", "he", "her", "here", "hers", "him",
  "his", "how", "however", "if", "in", "inside", "instead", "into", "is", "it", "its", "just",
  "keep", "kept", "last", "late", "later", "least", "left", "less", "let", "like", "little",
  "long", "look", "made", "make", "makes", "many", "may", "maybe", "me", "might", "more", "most",
  "much", "must", "my", "near", "need", "never", "new", "next", "night", "no", "none", "nobody",
  "nor", "not", "now", "of", "off", "old", "on", "once", "one", "only", "onto", "or", "other",
  "our", "out", "outside", "over", "own", "past", "per", "put", "quiet", "rather", "real",
  "really", "right", "run", "said", "same", "say", "second", "see", "seen", "she", "short",
  "should", "since", "so", "some", "soon", "still", "such", "sure", "take", "than", "that", "the",
  "their", "them", "then", "there", "these", "they", "thing", "things", "third", "this", "those",
  "though", "through", "time", "to", "today", "together", "too", "top", "toward", "two", "under",
  "until", "up", "upon", "us", "use", "very", "want", "was", "way", "we", "week", "well", "were",
  "what", "when", "where", "whether", "which", "while", "who", "whole", "whom", "why", "will",
  "with", "without", "worth", "would", "year", "years", "yes", "yet", "you", "your",
  // question / opinion scaffolding common in generated titles
  "actually", "already", "answer", "argument", "case", "chance", "change", "choice", "claim",
  "cost", "debate", "decision", "doubt", "end", "fact", "future", "history", "idea", "issue",
  "matter", "moment", "myth", "part", "picture", "plan", "point", "price", "problem", "question",
  "reason", "reality", "result", "risk", "side", "sign", "story", "take", "test", "thought",
  "truth", "value", "verdict", "view", "watch", "watching", "worry",
  // sports role nouns and event vocabulary
  "all-star", "allstar", "arm", "arms", "assist", "assists", "attack", "audience", "ball",
  "baseball", "basketball", "bat", "bats", "bench", "block", "blocks", "board", "bowl", "box",
  "break", "bullpen", "cap", "captain", "career", "catcher", "center", "centre", "champion",
  "champions", "championship", "closer", "coach", "comeback", "conference", "contract", "core",
  "corner", "count", "court", "crowd", "cup", "deadline", "deal", "defence", "defense", "division",
  "draft", "drive", "duel", "dynasty", "exhibition", "fan", "fans", "field", "final", "finals",
  "football", "forward", "franchise", "free", "game", "games", "goal", "goals", "goalie",
  "guard", "hit", "hits", "hockey", "home", "homer", "ice", "inning", "innings", "injury",
  "league", "lineup", "loss", "losses", "manager", "match", "midsummer", "minutes", "mound",
  "offense", "offence", "opener", "outfielder", "ovation", "owner", "pace", "parade", "pass",
  "penalty", "pitch", "pitcher", "pitchers", "pitching", "play", "player", "players", "playoff",
  "playoffs", "point", "points", "position", "postseason", "practice", "pressure", "quarter",
  "quarterback", "race", "rally", "rank", "ratings", "record", "return", "rink", "rival",
  "rivalry", "rookie", "roster", "round", "run", "runs", "save", "saves", "score", "season",
  "series", "shot", "shots", "showcase", "shutout", "skater", "slump", "snoozefest", "spot",
  "squad", "stadium", "star", "starter", "stats", "streak", "strike", "sweep", "swing", "table",
  "tackle", "team", "teams", "title", "trade", "veteran", "victory", "win", "wins", "world",
]);

export interface CanonicalEntitySet {
  /** Canonical franchise / conference ids, e.g. "MLB:LAA". */
  teams: string[];
  /** Full person names in lowercase, e.g. "mike trout". */
  people: string[];
  /** Surname keys for people, so "Trout" and "Mike Trout" agree. */
  personKeys: string[];
  /** Surface forms that resolved to a team, for operator-readable reasons. */
  teamMentions: string[];
}

const MAX_ALIAS_WORDS = 4;

/**
 * Scan RAW text (capitalisation intact) for canonical teams and people.
 *
 * Two deliberate filters keep manufactured names out:
 *  - a possessive first token ("Veteran's Return") is a modifier, never a name;
 *  - either token appearing in COMMON_WORDS disqualifies the pair.
 */
export function extractCanonicalEntities(
  text: string | null | undefined,
  league?: string | null
): CanonicalEntitySet {
  const teams = new Set<string>();
  const people = new Set<string>();
  const personKeys = new Set<string>();
  const teamMentions = new Set<string>();
  if (!text) {
    return { teams: [], people: [], personKeys: [], teamMentions: [] };
  }

  const tokens = text.split(/[^A-Za-z0-9'’.\-]+/).filter(Boolean);
  let run: Array<{ raw: string; possessive: boolean }> = [];

  const flush = () => {
    if (run.length === 0) return;
    const bare = run.map((t) => t.raw.replace(/[’']s$/i, "").replace(/[’']/g, ""));
    // Longest-first n-gram sweep so "Los Angeles Angels" beats "Angels".
    let i = 0;
    const claimed = new Array<boolean>(run.length).fill(false);
    for (let n = Math.min(MAX_ALIAS_WORDS, run.length); n >= 1; n--) {
      for (i = 0; i + n <= run.length; i++) {
        if (claimed.slice(i, i + n).some(Boolean)) continue;
        const phrase = bare.slice(i, i + n).join(" ");
        const canonical = canonicalizeTeamName(phrase, league);
        if (canonical) {
          teams.add(canonical);
          teamMentions.add(phrase.toLowerCase());
          for (let k = i; k < i + n; k++) claimed[k] = true;
        }
      }
    }
    // People: an exact two-word capitalized pair that resolved to no team, is
    // not possessive, and uses no common word.
    for (let k = 0; k + 1 < run.length; k++) {
      if (claimed[k] || claimed[k + 1]) continue;
      const first = run[k];
      const second = run[k + 1];
      if (first.possessive) continue;
      if (!/^[A-Z][a-z'’.\-]+$/.test(first.raw)) continue;
      if (!/^[A-Z][a-z'’.\-]+$/.test(second.raw.replace(/[’']s$/i, ""))) continue;
      const a = bare[k].toLowerCase();
      const b = bare[k + 1].toLowerCase();
      if (a.length < 3 || b.length < 2) continue;
      if (COMMON_WORDS.has(a) || COMMON_WORDS.has(b)) continue;
      if (canonicalizeTeamName(a, league) || canonicalizeTeamName(b, league)) continue;
      people.add(`${a} ${b}`);
      personKeys.add(b);
      k++; // a name consumes both tokens
    }
    run = [];
  };

  for (const tok of tokens) {
    const possessive = /[’']s$/i.test(tok);
    const core = tok.replace(/[’']s$/i, "");
    const isCapital = /^[A-Z][A-Za-z0-9'’.\-]*$/.test(core) || /^[A-Z0-9]{2,}$/.test(core);
    if (isCapital) run.push({ raw: core, possessive });
    else flush();
  }
  flush();

  return {
    teams: [...teams].sort(),
    people: [...people].sort(),
    personKeys: [...personKeys].sort(),
    teamMentions: [...teamMentions].sort(),
  };
}

// ---------------------------------------------------------------------------
// Number normalization
// ---------------------------------------------------------------------------

const NUMBER_WORDS: Record<string, number> = {
  zero: 0, nil: 0, none: 0, nothing: 0, naught: 0, nought: 0, scoreless: 0,
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, dozen: 12, thirteen: 13, fourteen: 14, fifteen: 15,
  sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30,
  forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100,
};

const TENS = ["twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
const ONES = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];
const COMPOUND_RE = new RegExp(`\\b(${TENS.join("|")})[- ](${ONES.join("|")})\\b`, "g");
const SINGLE_RE = new RegExp(`\\b(${Object.keys(NUMBER_WORDS).join("|")})\\b`, "g");

/**
 * Spelled-out numbers become digits so "four to nothing" and "4-0" reduce to
 * the same claim atom. `scoreless`/`nil`/`nothing` are the zero forms sports
 * prose actually uses.
 */
export function normalizeNumbers(text: string): string {
  return text
    .replace(COMPOUND_RE, (_m, tens: string, ones: string) => String(NUMBER_WORDS[tens] + NUMBER_WORDS[ones]))
    .replace(SINGLE_RE, (m) => String(NUMBER_WORDS[m]));
}

// ---------------------------------------------------------------------------
// Curated domain concept lexicon (the offline stand-in for embeddings)
// ---------------------------------------------------------------------------

const CONCEPT_GROUPS: Record<string, string[]> = {
  SHUTOUT: ["shutout", "shutouts", "blank", "blanked", "blanking", "whitewash", "scoreless", "zeroed", "goose", "cleansheet", "clean sheet", "hitless"],
  EXHIBITION: ["allstar", "midsummer", "exhibition", "showcase", "showpiece", "probowl", "friendly", "showdown"],
  PITCHING: ["pitcher", "pitchers", "pitching", "bullpen", "reliever", "relief", "hurler", "mound", "inning", "innings", "closer", "rotation"],
  BOREDOM: ["snoozefest", "snooze", "boring", "dull", "flat", "lifeless", "dramafree", "sleepy", "forgettable", "tedious", "uneventful", "listless", "meaningless", "watchable"],
  BROADCAST: ["ratings", "audience", "viewership", "viewers", "broadcast", "telecast", "television", "tuned", "primetime"],
  CROWD: ["ovation", "crowd", "fans", "attendance", "stands", "cheer", "applause", "sellout"],
  SCORING: ["runs", "scoring", "offense", "offence", "bats", "hitting", "hitters", "goals", "points", "lowestscoring"],
  ANALYTICS: ["analytics", "spreadsheet", "optimisation", "optimization", "metrics", "sabermetrics", "algorithmic", "efficiency", "matchup", "matchups", "data"],
  MANAGEMENT: ["manager", "managed", "managing", "coach", "coached", "coaching", "strategy", "tactics", "bench"],
  CONTRACT: ["contract", "extension", "salary", "payroll", "cap", "dollars", "money", "guaranteed", "arbitration"],
  TRADE: ["trade", "traded", "acquire", "acquired", "swap", "dealt", "deadline"],
  INJURY: ["injury", "injured", "hamstring", "acl", "surgery", "sidelined", "strain", "ailing", "rehab", "il"],
  DISCIPLINE: ["suspension", "suspended", "ban", "banned", "fined", "discipline", "ejected", "ejection", "appeal"],
  DEFENSE: ["defense", "defence", "defensive", "rim", "paint", "protection", "blocks", "stops", "coverage"],
  STREAK: ["streak", "straight", "consecutive", "skid", "slump", "unbeaten"],
  FIRING: ["fired", "firing", "dismissed", "sacked", "ousted", "hotseat", "replaced"],
  MILESTONE: ["record", "milestone", "historic", "history", "franchise", "alltime", "career"],
  POSTSEASON: ["playoff", "playoffs", "postseason", "wildcard", "elimination", "series", "final", "finals", "championship", "title", "clinch"],
  ROOKIE: ["rookie", "debut", "prospect", "draft", "drafted", "callup"],
  VETERAN: ["veteran", "ageing", "aging", "comeback", "returned", "farewell", "retirement", "retire"],
  QUALITY: ["quality", "product", "entertainment", "entertaining", "spectacle", "watchability"],
};

const CONCEPT_BY_STEM = new Map<string, string[]>();
for (const [concept, words] of Object.entries(CONCEPT_GROUPS)) {
  for (const w of words) {
    for (const tok of contentTokens(w)) {
      const list = CONCEPT_BY_STEM.get(tok);
      if (!list) CONCEPT_BY_STEM.set(tok, [concept]);
      else if (!list.includes(concept)) list.push(concept);
    }
  }
}

/** How many copies of a concept marker a matching token contributes. Higher
 *  than 1 so shared MEANING outweighs shared incidental vocabulary. */
export const CONCEPT_TOKEN_WEIGHT = 2;

/**
 * Term vector expanded with curated concept markers.
 *
 * This is the "defensible offline semantic representation": two writers who
 * chose "blanked" and "shut out" share no literal token but both emit
 * `~SHUTOUT`, so the cosine sees the agreement. It is a hand-curated
 * distributional lexicon, not a learned model, and it only covers the sports
 * domain — that limitation is real and stated on purpose.
 */
export function expandConcepts(tokens: string[]): string[] {
  const out = [...tokens];
  for (const t of tokens) {
    const concepts = CONCEPT_BY_STEM.get(t);
    if (!concepts) continue;
    for (const c of concepts) {
      for (let i = 0; i < CONCEPT_TOKEN_WEIGHT; i++) out.push(`~${c}`);
    }
  }
  return out;
}

/** The concept ids a piece of text triggers — used in operator explanations. */
export function conceptsOf(tokens: string[]): string[] {
  const s = new Set<string>();
  for (const t of tokens) for (const c of CONCEPT_BY_STEM.get(t) ?? []) s.add(c);
  return [...s].sort();
}

// ---------------------------------------------------------------------------
// Claim fingerprints
// ---------------------------------------------------------------------------

export interface ClaimAtom {
  /** Comparable identity, e.g. "score:4-0", "act:shutout", "mag:11:pitcher". */
  atom: string;
  /** 0..1 — how much of an event identity this atom carries on its own. */
  weight: number;
  /** Operator-readable phrasing, e.g. "a final score of 4-0". */
  label: string;
}

/** A normalized final score is nearly an event id within one league-day. */
export const SCORE_ATOM_WEIGHT = 0.95;

/** Event-type phrases -> `evt:` atoms. Matched on normalized text. */
const EVENT_TYPE_PHRASES: Array<[RegExp, string, number, string]> = [
  [/\b(all-?star|allstar|midsummer|exhibition|showcase|showpiece|pro-?bowl)\b/, "exhibition", 0.55, "an all-star / exhibition showcase"],
  [/\b(world series|super ?bowl|stanley cup|nba finals|grand final|championship game|title game)\b/, "championship", 0.6, "a championship decider"],
  [/\b(playoff|playoffs|postseason|wild-?card|elimination game|game 7|game seven)\b/, "postseason", 0.55, "a postseason game"],
  [/\b(trade deadline|deadline day)\b/, "deadline", 0.55, "the trade deadline"],
  [/\b(draft night|draft lottery|the draft)\b/, "draft", 0.55, "the draft"],
  [/\b(opening day|season opener|home opener)\b/, "opener", 0.55, "a season opener"],
  [/\b(spring training|preseason|training camp)\b/, "preseason", 0.5, "the preseason"],
];

/** Action phrases -> `act:` atoms. */
const ACTION_PHRASES: Array<[RegExp, string, number, string]> = [
  [/\b(shut-?out|shutout|blanked|blanking|whitewash|scoreless|kept off the (board|scoresheet))\b/, "shutout", 0.5, "a shutout"],
  [/\b(no-?hitter|perfect game)\b/, "nohitter", 0.7, "a no-hitter"],
  [/\b(walk-?off)\b/, "walkoff", 0.6, "a walk-off"],
  [/\b(overtime|extra innings|shoot-?out)\b/, "overtime", 0.35, "overtime / extra innings"],
  [/\b(traded|trade for|acquired|dealt to|swap)\b/, "trade", 0.5, "a trade"],
  [/\b(signed|signing|extension|re-?signed|agreed to a deal)\b/, "signing", 0.5, "a signing or extension"],
  [/\b(fired|firing|dismissed|sacked|ousted|stepped down)\b/, "firing", 0.5, "a firing"],
  [/\b(suspend|suspended|suspension|banned|ejected)\b/, "discipline", 0.55, "a suspension or ejection"],
  [/\b(injur|hamstring|torn|surgery|sidelined|ruptured)\w*\b/, "injury", 0.5, "an injury"],
  [/\b(retire|retired|retirement|farewell tour)\b/, "retirement", 0.55, "a retirement"],
  [/\b(record|milestone|all-?time|franchise record)\b/, "record", 0.4, "a record or milestone"],
  [/\b(ratings|viewership|audience|telecast|broadcast)\b/, "ratings", 0.4, "a ratings/audience story"],
  [/\b(snoozefest|drama-?free|boring|dull|lifeless|forgettable|uneventful)\b/, "boredom", 0.35, "a low-drama complaint"],
  [/\b(clinch|clinched|eliminated|elimination)\b/, "standings", 0.5, "a clinch or elimination"],
  [/\b(beat|defeated|won|topped|edged|downed|overcame)\b/, "win", 0.15, "a win"],
];

const MAG_UNITS = "pitcher|reliever|player|inning|run|goal|point|yard|game|round|team|save|strikeout|hit|win|loss|percent|second|minute|shot|rebound|assist|touchdown|homer|start|catch|penalty|turnover";

/** Magnitudes below this are too common to identify anything ("one inning"). */
const MIN_MAGNITUDE = 3;

/**
 * Reduce title + summary + angles to normalized claim atoms.
 *
 * The point is that "the AL blanked the NL four to nothing", "American League
 * shuts out National League 4-0" and "an eleven-pitcher, four-run shutout"
 * converge on the SAME atoms — `score:4-0`, `act:shutout`, `evt:exhibition` —
 * without any of them naming the same words.
 */
export function extractClaimAtoms(rawText: string | null | undefined): ClaimAtom[] {
  if (!rawText) return [];
  const atoms = new Map<string, ClaimAtom>();
  const add = (atom: string, weight: number, label: string) => {
    const existing = atoms.get(atom);
    if (!existing || existing.weight < weight) atoms.set(atom, { atom, weight, label });
  };

  let text = ` ${normalizeNumbers(normalizeText(rawText))} `;

  // (1) Batting / shooting lines first, so "2-for-3" is never read as a score.
  text = text.replace(/\b(\d{1,2})\s*(?:-|\s)\s*for\s*(?:-|\s)\s*(\d{1,2})\b/g, (_m, a: string, b: string) => {
    add(`line:${a}-${b}`, 0.6, `a ${a}-for-${b} line`);
    return " ";
  });

  // (2) "a four-run shutout" / "three-goal blanking" -> an explicit N-0 score.
  text = text.replace(
    /\b(\d{1,3})[-\s]?(?:run|goal|point)s?\s+(?:shut-?out|shutout|blanking|whitewash)\b/g,
    (_m, a: string) => {
      add(`score:${a}-0`, SCORE_ATOM_WEIGHT, `a final score of ${a}-0`);
      add("act:shutout", 0.5, "a shutout");
      return " ";
    }
  );

  // (3) Explicit scores: "4-0", "4 to 0", "four to nothing" (already digits).
  //     Orientation-normalized so a perspective flip still matches.
  text = text.replace(/\b(\d{1,3})\s*(?:-|to)\s*(\d{1,3})\b/g, (_m, a: string, b: string) => {
    const hi = Math.max(Number(a), Number(b));
    const lo = Math.min(Number(a), Number(b));
    add(`score:${hi}-${lo}`, SCORE_ATOM_WEIGHT, `a final score of ${hi}-${lo}`);
    if (lo === 0) add("act:shutout", 0.5, "a shutout");
    return " ";
  });

  // (4) Ages, then generic magnitudes.
  text = text.replace(/\b(\d{1,3})[-\s]year[-\s]old\b/g, (_m, a: string) => {
    add(`mag:${a}:age`, 0.3, `a ${a}-year-old`);
    return " ";
  });
  const magRe = new RegExp(`\\b(\\d{1,3})[-\\s](${MAG_UNITS})s?\\b`, "g");
  let m: RegExpExecArray | null;
  while ((m = magRe.exec(text)) !== null) {
    const n = Number(m[1]);
    if (n < MIN_MAGNITUDE) continue;
    const unit = m[2];
    add(`mag:${n}:${unit}`, unit === "percent" ? 0.45 : 0.6, `${n} ${unit}${n === 1 ? "" : "s"}`);
  }
  const pctRe = /\b(\d{1,3})\s*(?:percent|per cent)\b/g;
  while ((m = pctRe.exec(text)) !== null) add(`mag:${m[1]}:percent`, 0.45, `${m[1]} percent`);

  // (5) Event types and actions from the curated phrase lexicons. These run on
  //     a hyphen-collapsed variant too, so "all-star" and "all star" agree.
  const probe = `${text} ${text.replace(/-/g, "")} ${text.replace(/-/g, " ")}`;
  for (const [re, id, weight, label] of EVENT_TYPE_PHRASES) {
    if (re.test(probe)) add(`evt:${id}`, weight, label);
  }
  for (const [re, id, weight, label] of ACTION_PHRASES) {
    if (re.test(probe)) add(`act:${id}`, weight, label);
  }

  return [...atoms.values()].sort((a, b) => (a.atom < b.atom ? -1 : a.atom > b.atom ? 1 : 0));
}

export interface ClaimComparison {
  sharedAtoms: ClaimAtom[];
  /** Σ weight of shared atoms. */
  sharedWeight: number;
  /** The single most identifying shared atom's weight. */
  peakWeight: number;
  /** Σ weight of the union. */
  unionWeight: number;
  /** sharedWeight / unionWeight. */
  jaccard: number;
  /** Atoms of the same KIND with different values (4-0 vs 6-3) — evidence the
   *  two stories are about different events, not the same one. */
  conflicts: string[];
}

const CONFLICT_KINDS = new Set(["score", "line"]);

/** Compare two claim fingerprints. */
export function compareClaims(a: ClaimAtom[], b: ClaimAtom[]): ClaimComparison {
  const byAtomB = new Map(b.map((x) => [x.atom, x]));
  const shared: ClaimAtom[] = [];
  for (const x of a) {
    const y = byAtomB.get(x.atom);
    if (y) shared.push({ atom: x.atom, weight: Math.max(x.weight, y.weight), label: x.label });
  }
  const union = new Map<string, number>();
  for (const x of [...a, ...b]) union.set(x.atom, Math.max(union.get(x.atom) ?? 0, x.weight));
  const sharedWeight = shared.reduce((s, x) => s + x.weight, 0);
  const unionWeight = [...union.values()].reduce((s, w) => s + w, 0);
  const peakWeight = shared.reduce((mx, x) => Math.max(mx, x.weight), 0);

  const kindsOf = (list: ClaimAtom[]) => {
    const map = new Map<string, Set<string>>();
    for (const x of list) {
      const kind = x.atom.split(":")[0];
      if (!CONFLICT_KINDS.has(kind)) continue;
      const set = map.get(kind) ?? new Set<string>();
      set.add(x.atom);
      map.set(kind, set);
    }
    return map;
  };
  const ka = kindsOf(a);
  const kb = kindsOf(b);
  const conflicts: string[] = [];
  for (const [kind, setA] of ka) {
    const setB = kb.get(kind);
    if (!setB || setB.size === 0) continue;
    let overlap = false;
    for (const x of setA) if (setB.has(x)) overlap = true;
    if (!overlap) conflicts.push(`${kind} (${[...setA].join("/")} vs ${[...setB].join("/")})`);
  }

  return {
    sharedAtoms: shared.sort((x, y) => y.weight - x.weight || (x.atom < y.atom ? -1 : 1)),
    sharedWeight: Number(sharedWeight.toFixed(6)),
    peakWeight,
    unionWeight: Number(unionWeight.toFixed(6)),
    jaccard: unionWeight === 0 ? 0 : Number((sharedWeight / unionWeight).toFixed(6)),
    conflicts,
  };
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

export function toDayString(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

const MS_PER_DAY = 86_400_000;

export function dayDiff(a: string, b: string): number {
  return Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / MS_PER_DAY;
}

/** Smallest gap in days between any pair of dates. `null` when either side has
 *  no dates at all — "unknown", which is not the same as "far apart". */
export function minDayGap(a: string[], b: string[]): number | null {
  if (a.length === 0 || b.length === 0) return null;
  let best = Infinity;
  for (const x of a) for (const y of b) best = Math.min(best, dayDiff(x, y));
  return Number.isFinite(best) ? best : null;
}

/** Signed gap: how many days b is AFTER a (negative = b is older). */
export function forwardDayGap(a: string[], b: string[]): number | null {
  if (a.length === 0 || b.length === 0) return null;
  const maxA = a.slice().sort().at(-1)!;
  const maxB = b.slice().sort().at(-1)!;
  return (Date.parse(`${maxB}T00:00:00Z`) - Date.parse(`${maxA}T00:00:00Z`)) / MS_PER_DAY;
}

// ---------------------------------------------------------------------------
// Update-vs-duplicate marker lexicons
// ---------------------------------------------------------------------------

/** Phrases that mean the earlier story left something UNRESOLVED. Deliberately
 *  phrase-level: a bare "will" or "could" is question scaffolding, not an open
 *  question about the event. */
export const OPEN_QUESTION_MARKERS: string[] = [
  "under review", "awaiting", "pending", "undecided", "unclear", "uncertain",
  "yet to", "to be determined", "still deciding", "no timetable", "no decision",
  "day-to-day", "day to day", "questionable for", "facing discipline",
  "facing a suspension", "could face", "may face", "expected to miss", "in limbo",
  "up in the air", "has not said", "declined to say", "no ruling", "appeal is",
  "will be decided", "deadline looms", "remains open", "waiting on",
];

/** Phrases that mean the later story CLOSED something. */
export const RESOLUTION_MARKERS: string[] = [
  "announced", "was suspended", "suspended for", "has been suspended", "ruled",
  "ruling", "decided", "confirmed", "officially", "finalized", "finalised",
  "agreed to", "cleared to", "was cleared", "upheld", "overturned", "reinstated",
  "handed a", "issued a", "completed the trade", "was traded", "has been traded",
  "was fired", "was hired", "signed a", "has been named", "will miss the season",
  "underwent surgery", "returned to the lineup", "made it official", "verdict",
];

/** Action atoms that, when NEW in the later story, are a real development
 *  rather than another angle on the same facts. */
export const RESOLUTION_ACTIONS = new Set<string>([
  "act:trade", "act:signing", "act:firing", "act:discipline", "act:injury",
  "act:retirement", "act:standings",
]);

export function containsAnyPhrase(text: string, phrases: string[]): string | null {
  const hay = ` ${normalizeText(text)} `;
  for (const p of phrases) {
    const needle = ` ${normalizeText(p)} `;
    if (hay.includes(needle.slice(0, -1)) || hay.includes(needle)) return p;
  }
  return null;
}

// ---------------------------------------------------------------------------
// OPTIONAL embedding hook — OFF BY DEFAULT
// ---------------------------------------------------------------------------

/**
 * A caller MAY install a real sentence encoder. Nothing in this repo does, and
 * every code path works without one; when no hook is installed the offline
 * concept/claim/alias stack is used alone, exactly as it is in CI.
 *
 * The hook can only ever CORROBORATE — `storyClustering` never merges on an
 * embedding cosine by itself, because a merge must still be able to name a
 * concrete shared signal.
 */
export type EmbeddingHook = (texts: string[]) => Promise<number[][]>;

let embeddingHook: EmbeddingHook | null = null;

/** Install (or clear, with `null`) the optional encoder. Default: not installed. */
export function configureEmbeddingHook(hook: EmbeddingHook | null): void {
  embeddingHook = hook;
}

export function isEmbeddingHookEnabled(): boolean {
  return embeddingHook !== null;
}

/** Embed texts if — and only if — a hook was explicitly installed. */
export async function embedTexts(texts: string[]): Promise<number[][] | null> {
  if (!embeddingHook) return null;
  try {
    const out = await embeddingHook(texts);
    return Array.isArray(out) && out.length === texts.length ? out : null;
  } catch {
    return null;
  }
}

export function vectorCosine(a: number[] | null | undefined, b: number[] | null | undefined): number {
  if (!a || !b || a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
