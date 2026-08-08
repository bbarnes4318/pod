// Event-level story clustering + rundown diversity.
// Run: npm run test:story-clustering
//
// THE FAILURE THIS PINS DOWN
// --------------------------
// Production episode e7867729 selected three "different" topics that were all
// the SAME event — the 2026 MLB All-Star Game (AL 4-0 NL, in Philadelphia):
//
//   1. "Was Mike Trout the Real Story of a Drama-Free All-Star Game?"
//   2. "Did the MLB All-Star Game Just Become a Snoozefest?"
//   3. "Is an 11-Pitcher All-Star Shutout Great Baseball or Spreadsheet Baseball?"
//
// and restated one argument for 8.5 minutes. The NEGATIVE fixture below is
// those three topics with realistic overlapping evidence. The CONTROL fixture
// is three genuinely distinct stories (different leagues, teams, dates,
// evidence, URLs) which must ALL survive — a filter that rejects everything is
// not a filter, it is an outage.
//
// THE SECOND FAILURE THIS PINS DOWN (the rejected caveat)
// -------------------------------------------------------
// The first version of the clustering module could only merge when it could
// name a HARD identifier — a shared Game row, evidence row, URL, or a heavy
// overlap of literal proper nouns — and it documented that three PARAPHRASES of
// one event with the identifiers stripped would slip through. That caveat was
// rejected. `allStarParaphrased` below is exactly that shape: the same three
// topics reworded to share no game id, no evidence row, no source URL and no
// proper noun beyond the sport. It must still cluster into one, and the fixture
// asserts its own honesty before asserting the merge.
//
// Recall like that is only worth having if precision survives it, so the
// adversarial fixtures are the other half of the file:
//   - `sameTeamsDifferentDates` — same franchises, same 4-0 claim, months apart
//   - `twoPlayersSameTeam`      — same franchises, same night, different people
//   - `sameNightDifferentGames` — two different 4-0 shutouts, one league, one night
// Each pair clears every merge precondition EXCEPT one discriminator, and each
// asserts that the discriminator is the ONLY thing separating them — so a
// regression that weakens a veto fails here rather than in production.
/* eslint-disable @typescript-eslint/no-explicit-any -- test harness: the
   in-memory fake DB doubles are intentionally loosely typed. */

import assert from "node:assert/strict";
import {
  classifyEventRelation,
  clusterTopicsByEvent,
  compareFingerprints,
  compareTopics,
  deriveEventFingerprint,
  enforceEventDiversity,
  explainDuplicate,
  extractClaimAtoms,
  isEmbeddingHookEnabled,
  scoreRundownDiversity,
  CANONICAL_ENTITY_MIN_CONCEPT_COSINE,
  RUNDOWN_DIVERSITY_THRESHOLD,
  SEMANTIC_SAME_EVENT_ENTITY_JACCARD,
  SOFT_OVERLAP_COSINE,
  type ClusterableTopic,
} from "../lib/services/storyClustering";
import { canonicalizeTeamName } from "../lib/services/eventIdentity";
import { selectAutoTopics } from "../lib/services/episodeService";

// The fixtures are deliberately terse; isolate SELECTION from the talkability
// floor exactly the way testEpisodeCreation.ts does (0 would be read as 35).
process.env.TOPIC_MIN_TALKABILITY = "1";

let passed = 0;
let failed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.error(`  ✗ ${name}\n      ${(err as Error).message}`);
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

type Fixture = ClusterableTopic & {
  status: string;
  sport: string;
  leagueId: string | null;
  summary: string | null;
  debateScore: number;
  bettingRelevanceScore: number;
  createdAt: Date;
  researchBrief: {
    facts: unknown;
    sourceIds: unknown;
    argumentForHostA: string | null;
    argumentForHostB: string | null;
    mainAngle: string | null;
    contrarianAngle: string | null;
  } | null;
};

const ASG_GAME_ID = "mlb-2026-allstar-phi";
const ASG_DATE = new Date("2026-07-14T23:45:00Z");

const ESPN_RECAP = "https://www.espn.com/mlb/story/_/id/2026-all-star-game-recap?ex_cid=share";
const MLB_RECAP = "https://www.mlb.com/news/2026-all-star-game-recap";
const ATHLETIC_PITCHING = "https://theathletic.com/2026/07/15/all-star-game-bullpen-parade/";
const RATINGS = "https://www.sportsmediawatch.com/2026/07/all-star-game-ratings-2026/";

function topic(over: Partial<Fixture> & { id: string; title: string }): Fixture {
  return {
    status: "approved",
    sport: "MLB",
    leagueId: "MLB",
    summary: null,
    debateScore: 88,
    bettingRelevanceScore: 10,
    createdAt: new Date("2026-07-15T08:00:00Z"),
    evidenceIds: [],
    sources: [],
    eventContext: null,
    researchBrief: {
      facts: [{ text: "placeholder fact" }],
      sourceIds: [],
      argumentForHostA: "One side of it.",
      argumentForHostB: "The other side of it.",
      mainAngle: null,
      contrarianAngle: null,
    },
    ...over,
  } as Fixture;
}

const ASG_CONTEXT = {
  games: [{
    id: ASG_GAME_ID,
    leagueId: "MLB",
    homeTeamId: "mlb-national-league",
    awayTeamId: "mlb-american-league",
    scheduledAt: ASG_DATE,
  }],
  newsItems: [] as Array<{ id: string; title?: string | null; url?: string | null; publishedAt?: Date | string | null; entities?: unknown }>,
};

/** The three real topics from e7867729, with realistic overlapping evidence. */
function allStarFixture(): Fixture[] {
  return [
    topic({
      id: "asg-trout",
      title: "Was Mike Trout the Real Story of a Drama-Free All-Star Game?",
      summary:
        "Mike Trout went 2-for-3 in his first All-Star Game since 2023 as the American League beat the National League 4-0 in Philadelphia, and the loudest ovation of a quiet night went to a 34-year-old outfielder nobody expected to be on the field.",
      debateScore: 91,
      evidenceIds: [
        { type: "game", id: ASG_GAME_ID },
        { type: "newsItem", id: "news-asg-trout" },
        { type: "newsItem", id: "news-asg-recap" },
      ],
      sources: [
        { canonicalUrl: ESPN_RECAP, publishedAt: ASG_DATE, title: "American League blanks National League in All-Star Game" },
        { canonicalUrl: "https://www.mlb.com/news/mike-trout-all-star-return", publishedAt: ASG_DATE },
      ],
      eventContext: {
        ...ASG_CONTEXT,
        newsItems: [{
          id: "news-asg-recap",
          title: "American League blanks National League 4-0 in Philadelphia All-Star Game",
          url: ESPN_RECAP,
          publishedAt: ASG_DATE,
          entities: ["Mike Trout", "American League", "National League", "Philadelphia"],
        }],
      },
      researchBrief: {
        facts: [{ text: "Trout went 2-for-3." }, { text: "AL won 4-0." }],
        sourceIds: [{ type: "newsItem", id: "news-asg-trout" }, { type: "newsItem", id: "news-asg-recap" }],
        argumentForHostA: "Trout's return was the only thing worth watching.",
        argumentForHostB: "One veteran's night out does not rescue an exhibition.",
        mainAngle: "Mike Trout's All-Star Game return carried an otherwise flat night in Philadelphia.",
        contrarianAngle: "The American League's 4-0 win was forgettable with or without Trout.",
      },
    }),
    topic({
      id: "asg-snoozefest",
      title: "Did the MLB All-Star Game Just Become a Snoozefest?",
      summary:
        "The American League's 4-0 win over the National League in Philadelphia was the lowest-scoring All-Star Game in a decade, and the broadcast drew its smallest audience since 2018.",
      debateScore: 89,
      evidenceIds: [
        { type: "game", id: ASG_GAME_ID },
        { type: "newsItem", id: "news-asg-recap" },
        { type: "newsItem", id: "news-asg-ratings" },
      ],
      sources: [
        { canonicalUrl: ESPN_RECAP, publishedAt: ASG_DATE },
        { canonicalUrl: RATINGS, publishedAt: new Date("2026-07-15T14:00:00Z") },
      ],
      eventContext: {
        ...ASG_CONTEXT,
        newsItems: [{
          id: "news-asg-recap",
          title: "American League blanks National League 4-0 in Philadelphia All-Star Game",
          url: ESPN_RECAP,
          publishedAt: ASG_DATE,
          entities: ["American League", "National League", "Philadelphia"],
        }],
      },
      researchBrief: {
        facts: [{ text: "Lowest-scoring All-Star Game in ten years." }, { text: "Smallest audience since 2018." }],
        sourceIds: [{ type: "newsItem", id: "news-asg-recap" }, { type: "newsItem", id: "news-asg-ratings" }],
        argumentForHostA: "A 4-0 exhibition nobody watched is a product problem.",
        argumentForHostB: "The All-Star Game was never supposed to be competitive.",
        mainAngle: "The 4-0 All-Star Game in Philadelphia was the least watchable version of the event yet.",
        contrarianAngle: "Ratings decline is a television story, not a baseball story.",
      },
    }),
    topic({
      id: "asg-bullpen",
      title: "Is an 11-Pitcher All-Star Shutout Great Baseball or Spreadsheet Baseball?",
      summary:
        "Eleven American League pitchers combined to shut out the National League 4-0 in Philadelphia, none of them working more than one inning, in an All-Star Game managed exactly like a division-race Tuesday.",
      debateScore: 87,
      evidenceIds: [
        { type: "game", id: ASG_GAME_ID },
        { type: "newsItem", id: "news-asg-pitching" },
        { type: "newsItem", id: "news-asg-recap" },
      ],
      sources: [
        { canonicalUrl: MLB_RECAP, publishedAt: ASG_DATE },
        { canonicalUrl: ATHLETIC_PITCHING, publishedAt: new Date("2026-07-15T11:00:00Z") },
      ],
      eventContext: {
        ...ASG_CONTEXT,
        newsItems: [{
          id: "news-asg-pitching",
          title: "Eleven pitchers, nine innings: inside the All-Star Game bullpen parade",
          url: ATHLETIC_PITCHING,
          publishedAt: ASG_DATE,
          entities: ["American League", "National League", "Philadelphia"],
        }],
      },
      researchBrief: {
        facts: [{ text: "Eleven AL pitchers, none over one inning." }, { text: "Combined shutout, 4-0." }],
        sourceIds: [{ type: "newsItem", id: "news-asg-pitching" }, { type: "newsItem", id: "news-asg-recap" }],
        argumentForHostA: "An eleven-pitcher shutout is optimisation, not entertainment.",
        argumentForHostB: "Every one of those arms is the best in the world at one inning.",
        mainAngle: "The All-Star Game's eleven-pitcher shutout in Philadelphia is modern baseball in miniature.",
        contrarianAngle: "Bullpen specialisation is what makes a 4-0 shutout possible at all.",
      },
    }),
  ];
}

/** Three genuinely different stories: different leagues, teams, dates, sources. */
function controlFixture(): Fixture[] {
  return [
    topic({
      id: "ctl-chiefs",
      title: "Should the Chiefs Trade for a Left Tackle Before the Deadline?",
      sport: "NFL",
      leagueId: "NFL",
      debateScore: 90,
      createdAt: new Date("2026-10-12T08:00:00Z"),
      summary:
        "Kansas City has allowed pressure on 41 percent of Patrick Mahomes' dropbacks over the last three weeks, and Denver's front four exposed the left side again on Sunday.",
      evidenceIds: [
        { type: "game", id: "nfl-2026-w6-kc-den" },
        { type: "newsItem", id: "news-kc-oline" },
      ],
      sources: [{ canonicalUrl: "https://www.espn.com/nfl/story/_/id/chiefs-offensive-line-deadline", publishedAt: new Date("2026-10-12T02:00:00Z") }],
      eventContext: {
        games: [{ id: "nfl-2026-w6-kc-den", leagueId: "NFL", homeTeamId: "nfl-den", awayTeamId: "nfl-kc", scheduledAt: new Date("2026-10-11T20:05:00Z") }],
        newsItems: [{ id: "news-kc-oline", title: "Chiefs' left tackle problem is now a deadline problem", url: "https://www.espn.com/nfl/story/_/id/chiefs-offensive-line-deadline", publishedAt: new Date("2026-10-12T02:00:00Z"), entities: ["Patrick Mahomes", "Kansas City Chiefs", "Denver Broncos"] }],
      },
      researchBrief: {
        facts: [{ text: "41% pressure rate over three weeks." }],
        sourceIds: [{ type: "newsItem", id: "news-kc-oline" }],
        argumentForHostA: "Protect the franchise quarterback at any price.",
        argumentForHostB: "Renting a tackle in October never fixes a line.",
        mainAngle: "Kansas City's pass protection has become the ceiling on its season.",
        contrarianAngle: "Deadline tackles almost never solve anything.",
      },
    }),
    topic({
      id: "ctl-wemby",
      title: "Has Victor Wembanyama Already Broken the Center Position?",
      sport: "NBA",
      leagueId: "NBA",
      debateScore: 92,
      createdAt: new Date("2026-11-03T08:00:00Z"),
      summary:
        "San Antonio is allowing 12 fewer points per 100 possessions with Victor Wembanyama on the floor, and Oklahoma City spent an entire fourth quarter refusing to enter the paint.",
      evidenceIds: [
        { type: "game", id: "nba-2026-sas-okc" },
        { type: "newsItem", id: "news-wemby-defense" },
      ],
      sources: [{ canonicalUrl: "https://theathletic.com/2026/11/03/wembanyama-defensive-impact/", publishedAt: new Date("2026-11-03T05:00:00Z") }],
      eventContext: {
        games: [{ id: "nba-2026-sas-okc", leagueId: "NBA", homeTeamId: "nba-sas", awayTeamId: "nba-okc", scheduledAt: new Date("2026-11-02T23:00:00Z") }],
        newsItems: [{ id: "news-wemby-defense", title: "Nobody wants to drive on Victor Wembanyama anymore", url: "https://theathletic.com/2026/11/03/wembanyama-defensive-impact/", publishedAt: new Date("2026-11-03T05:00:00Z"), entities: ["Victor Wembanyama", "San Antonio Spurs", "Oklahoma City Thunder"] }],
      },
      researchBrief: {
        facts: [{ text: "-12 defensive rating swing on/off." }],
        sourceIds: [{ type: "newsItem", id: "news-wemby-defense" }],
        argumentForHostA: "He has made rim pressure a losing strategy.",
        argumentForHostB: "One elite defender does not redefine a position.",
        mainAngle: "San Antonio's defence bends around one player in a way the league has not seen.",
        contrarianAngle: "Defensive ratings flatter big men on bad offensive teams.",
      },
    }),
    topic({
      id: "ctl-panthers",
      title: "Are the Panthers Paying Too Much to Keep Their Cup Core Together?",
      sport: "NHL",
      leagueId: "NHL",
      debateScore: 85,
      createdAt: new Date("2026-10-23T08:00:00Z"),
      summary:
        "Florida has 71 percent of the salary cap committed to nine skaters through 2029, and Tampa Bay's rebuild is already producing cheaper minutes on the same rink.",
      evidenceIds: [
        { type: "game", id: "nhl-2026-fla-tbl" },
        { type: "newsItem", id: "news-fla-cap" },
      ],
      sources: [{ canonicalUrl: "https://www.tsn.ca/nhl/panthers-cap-crunch-2026", publishedAt: new Date("2026-10-23T03:00:00Z") }],
      eventContext: {
        games: [{ id: "nhl-2026-fla-tbl", leagueId: "NHL", homeTeamId: "nhl-tbl", awayTeamId: "nhl-fla", scheduledAt: new Date("2026-10-22T23:30:00Z") }],
        newsItems: [{ id: "news-fla-cap", title: "The bill for Florida's Cup core comes due", url: "https://www.tsn.ca/nhl/panthers-cap-crunch-2026", publishedAt: new Date("2026-10-23T03:00:00Z"), entities: ["Florida Panthers", "Tampa Bay Lightning"] }],
      },
      researchBrief: {
        facts: [{ text: "71% of the cap on nine skaters." }],
        sourceIds: [{ type: "newsItem", id: "news-fla-cap" }],
        argumentForHostA: "You pay whatever it costs to keep a champion together.",
        argumentForHostB: "Cap-tied cores age into last place.",
        mainAngle: "Florida's championship window is now a salary-cap arithmetic problem.",
        contrarianAngle: "Cup teams should never be run like spreadsheets.",
      },
    }),
  ];
}

/** The same three All-Star topics with EVERY hard identifier stripped: no game
 *  ref, no shared evidence row, no shared URL. Only prose is left. */
function allStarTextOnly(): Fixture[] {
  const base = allStarFixture();
  const rewire: Array<{ news: string; url: string }> = [
    { news: "news-only-trout", url: "https://example-a.com/a" },
    { news: "news-only-ratings", url: "https://example-b.com/b" },
    { news: "news-only-bullpen", url: "https://example-c.com/c" },
  ];
  return base.map((t, i) => ({
    ...t,
    evidenceIds: [{ type: "newsItem", id: rewire[i].news }],
    sources: [{ canonicalUrl: rewire[i].url, publishedAt: ASG_DATE }],
    eventContext: null,
    researchBrief: t.researchBrief
      ? { ...t.researchBrief, sourceIds: [{ type: "newsItem", id: rewire[i].news }] }
      : null,
  }));
}

/**
 * THE PARAPHRASE REGRESSION — the exact case the previous version failed.
 *
 * The same three All-Star topics, rewritten so that between them they share:
 *   - NO game id, NO evidence row, NO source URL (every ref is unique);
 *   - NO proper noun beyond the sport itself — no "All-Star", no "Mike Trout",
 *     no "Philadelphia", no "American League", no team, no city.
 * All that survives is the propositional content: one exhibition, a 4-0
 * shutout, eleven pitchers, a flat night. If duplicate protection can be
 * evaded by rewording, it is not duplicate protection.
 */
function allStarParaphrased(): Fixture[] {
  return [
    topic({
      id: "par-comeback",
      title: "Was One Comeback the Only Thing Worth Watching in a Drama-Free Baseball Exhibition?",
      summary:
        "A 34-year-old outfielder went 2-for-3 in his first midsummer exhibition appearance since 2023 as the winning side blanked the other four to nothing, and the loudest ovation of a quiet night went to a player nobody expected on the field.",
      debateScore: 91,
      evidenceIds: [{ type: "newsItem", id: "par-news-1" }],
      sources: [{ canonicalUrl: "https://par-example-one.test/story-one", publishedAt: ASG_DATE }],
      eventContext: null,
      researchBrief: {
        facts: [{ text: "Went two for three." }, { text: "Winning side blanked the other four to nothing." }],
        sourceIds: [{ type: "newsItem", id: "par-news-1" }],
        argumentForHostA: "The comeback was the only thing worth watching.",
        argumentForHostB: "One veteran's night out does not rescue an exhibition.",
        mainAngle: "One ageing outfielder's return carried an otherwise flat midsummer showcase.",
        contrarianAngle: "The four to nothing result was forgettable with or without him.",
      },
    }),
    topic({
      id: "par-snooze",
      title: "Did Baseball's Midsummer Showcase Just Become a Snoozefest?",
      summary:
        "The 4-0 final in the sport's annual midsummer exhibition was the lowest-scoring version in a decade, and the broadcast drew its smallest audience since 2018.",
      debateScore: 89,
      createdAt: new Date("2026-07-15T09:00:00Z"),
      evidenceIds: [{ type: "newsItem", id: "par-news-2" }],
      sources: [{ canonicalUrl: "https://par-example-two.test/story-two", publishedAt: new Date("2026-07-15T14:00:00Z") }],
      eventContext: null,
      researchBrief: {
        facts: [{ text: "Lowest-scoring version in ten years." }, { text: "Smallest audience since 2018." }],
        sourceIds: [{ type: "newsItem", id: "par-news-2" }],
        argumentForHostA: "A four to nothing exhibition nobody watched is a product problem.",
        argumentForHostB: "The showcase was never supposed to be competitive.",
        mainAngle: "The four-nothing midsummer exhibition was the least watchable version of the event yet.",
        contrarianAngle: "A ratings decline is a television story, not a baseball story.",
      },
    }),
    topic({
      id: "par-arms",
      title: "Is an 11-Pitcher Exhibition Shutout Great Baseball or Spreadsheet Baseball?",
      summary:
        "Eleven pitchers combined for a four-run shutout in the annual midsummer showcase, none of them working more than one inning, in a game managed exactly like a division-race Tuesday.",
      debateScore: 87,
      evidenceIds: [{ type: "newsItem", id: "par-news-3" }],
      sources: [{ canonicalUrl: "https://par-example-three.test/story-three", publishedAt: ASG_DATE }],
      eventContext: null,
      researchBrief: {
        facts: [{ text: "Eleven pitchers, none over one inning." }, { text: "Combined shutout." }],
        sourceIds: [{ type: "newsItem", id: "par-news-3" }],
        argumentForHostA: "An eleven-pitcher shutout is optimisation, not entertainment.",
        argumentForHostB: "Every one of those arms is the best in the world at one inning.",
        mainAngle: "The showcase's eleven-pitcher shutout is modern baseball in miniature.",
        contrarianAngle: "Bullpen specialisation is what makes a four to nothing shutout possible at all.",
      },
    }),
  ];
}

// ---------------------------------------------------------------------------
// ADVERSARIAL PRECISION FIXTURES
// Each pair is built to trip exactly one of the paraphrase-proof paths, so the
// discriminator that stops it has to do real work.
// ---------------------------------------------------------------------------

/** Same two franchises, same 4-0 shutout claim — THREE MONTHS APART. Only the
 *  date discriminates, and it must. */
function sameTeamsDifferentDates(): Fixture[] {
  return [
    topic({
      id: "adv-pair-may",
      title: "Was a 4-0 Shutout the Night the Angels' Season Turned?",
      createdAt: new Date("2026-05-04T08:00:00Z"),
      summary: "The Astros blanked the Angels 4-0 in Anaheim, the third time in a week the lineup went quiet.",
      evidenceIds: [{ type: "game", id: "mlb-2026-05-03-hou-laa" }, { type: "newsItem", id: "news-may-shutout" }],
      sources: [{ canonicalUrl: "https://adv-example.test/may-shutout", publishedAt: new Date("2026-05-04T02:00:00Z") }],
      eventContext: {
        games: [{ id: "mlb-2026-05-03-hou-laa", leagueId: "MLB", homeTeamId: "mlb-laa", awayTeamId: "mlb-hou", scheduledAt: new Date("2026-05-03T02:05:00Z") }],
        newsItems: [],
      },
      researchBrief: {
        facts: [{ text: "Shut out 4-0." }],
        sourceIds: [{ type: "newsItem", id: "news-may-shutout" }],
        argumentForHostA: "A 4-0 shutout in May is how seasons end early.",
        argumentForHostB: "One quiet night in May means nothing.",
        mainAngle: "The Angels were blanked 4-0 by the Astros and the lineup is the problem.",
        contrarianAngle: "A single 4-0 shutout is noise.",
      },
    }),
    topic({
      id: "adv-pair-aug",
      title: "Is a 4-0 Shutout Proof the Angels Finally Fixed Their Rotation?",
      createdAt: new Date("2026-08-20T08:00:00Z"),
      summary: "The Angels blanked the Astros 4-0 in Houston behind a rotation that has not allowed a run in three starts.",
      evidenceIds: [{ type: "game", id: "mlb-2026-08-19-laa-hou" }, { type: "newsItem", id: "news-aug-shutout" }],
      sources: [{ canonicalUrl: "https://adv-example.test/august-shutout", publishedAt: new Date("2026-08-20T02:00:00Z") }],
      eventContext: {
        games: [{ id: "mlb-2026-08-19-laa-hou", leagueId: "MLB", homeTeamId: "mlb-hou", awayTeamId: "mlb-laa", scheduledAt: new Date("2026-08-19T00:10:00Z") }],
        newsItems: [],
      },
      researchBrief: {
        facts: [{ text: "Shut out the Astros 4-0." }],
        sourceIds: [{ type: "newsItem", id: "news-aug-shutout" }],
        argumentForHostA: "A 4-0 shutout in August is a statement.",
        argumentForHostB: "The rotation has been carried by a soft schedule.",
        mainAngle: "The Angels blanked the Astros 4-0 and the rotation looks fixed.",
        contrarianAngle: "A single 4-0 shutout proves nothing about October.",
      },
    }),
  ];
}

/** Two different players on the SAME team, same night, near-identical framing.
 *  The shared franchises would carry a merge; the disjoint principals must not
 *  let it. */
function twoPlayersSameTeam(): Fixture[] {
  return [
    topic({
      id: "adv-player-bat",
      title: "Was Brady Whitlock's Two-Homer Night the Turning Point of the Angels' Season?",
      createdAt: new Date("2026-06-17T08:00:00Z"),
      summary: "Brady Whitlock was the story again against the Mariners on Tuesday night, his best game since April, and the Angels have now won four in a row at home in front of a sellout crowd.",
      evidenceIds: [{ type: "newsItem", id: "news-whitlock" }],
      sources: [{ canonicalUrl: "https://adv-example.test/whitlock", publishedAt: new Date("2026-06-17T03:00:00Z") }],
      eventContext: null,
      researchBrief: {
        facts: [{ text: "Two homers." }],
        sourceIds: [{ type: "newsItem", id: "news-whitlock" }],
        argumentForHostA: "Brady Whitlock is the bat this lineup was missing.",
        argumentForHostB: "One night against the Mariners is not a turning point.",
        mainAngle: "Brady Whitlock's power has arrived and the Angels are winning because of it.",
        contrarianAngle: "Multi-homer nights are the noisiest statistic in the sport.",
      },
    }),
    topic({
      id: "adv-player-arm",
      title: "Is Diego Salcedo Already the Best Starter the Angels Have?",
      createdAt: new Date("2026-06-17T08:00:00Z"),
      summary: "Diego Salcedo was the story again against the Mariners on Tuesday night, his best game since April, and the Angels have now won four in a row at home in front of a sellout crowd.",
      evidenceIds: [{ type: "newsItem", id: "news-salcedo" }],
      sources: [{ canonicalUrl: "https://adv-example.test/salcedo", publishedAt: new Date("2026-06-17T03:00:00Z") }],
      eventContext: null,
      researchBrief: {
        facts: [{ text: "Eleven strikeouts over seven innings." }],
        sourceIds: [{ type: "newsItem", id: "news-salcedo" }],
        argumentForHostA: "Diego Salcedo has the best stuff on the staff.",
        argumentForHostB: "Eleven strikeouts against the Mariners is a schedule artefact.",
        mainAngle: "Diego Salcedo has quietly become the Angels' number one starter.",
        contrarianAngle: "Strikeout totals flatter pitchers facing bad lineups.",
      },
    }),
  ];
}

/** Two DIFFERENT games in the same league on the same night, both 4-0 shutouts,
 *  described in almost the same words. The claim atoms match perfectly; only
 *  the franchises differ. This is the hardest precision case in the file. */
function sameNightDifferentGames(): Fixture[] {
  return [
    topic({
      id: "adv-night-yankees",
      title: "Was a 4-0 Shutout in the Bronx the Statement Win of the Yankees' Week?",
      createdAt: new Date("2026-06-17T08:00:00Z"),
      summary: "The Yankees blanked the Orioles 4-0 on Tuesday night behind eight shutout innings, the quietest game of the series.",
      evidenceIds: [{ type: "newsItem", id: "news-nyy-shutout" }],
      sources: [{ canonicalUrl: "https://adv-example.test/yankees-shutout", publishedAt: new Date("2026-06-17T03:00:00Z") }],
      eventContext: null,
      researchBrief: {
        facts: [{ text: "Blanked 4-0." }],
        sourceIds: [{ type: "newsItem", id: "news-nyy-shutout" }],
        argumentForHostA: "A 4-0 shutout is a statement about the rotation.",
        argumentForHostB: "The Orioles have not scored all week.",
        mainAngle: "The Yankees blanked the Orioles 4-0 behind eight shutout innings.",
        contrarianAngle: "A 4-0 shutout of a slumping lineup proves very little.",
      },
    }),
    topic({
      id: "adv-night-padres",
      title: "Did the Padres Just Announce Themselves With a 4-0 Shutout?",
      createdAt: new Date("2026-06-17T08:00:00Z"),
      summary: "The Padres blanked the Rockies 4-0 on Tuesday night behind eight shutout innings, the quietest game of the series.",
      evidenceIds: [{ type: "newsItem", id: "news-sd-shutout" }],
      sources: [{ canonicalUrl: "https://adv-example.test/padres-shutout", publishedAt: new Date("2026-06-17T03:00:00Z") }],
      eventContext: null,
      researchBrief: {
        facts: [{ text: "Blanked 4-0." }],
        sourceIds: [{ type: "newsItem", id: "news-sd-shutout" }],
        argumentForHostA: "A 4-0 shutout is a statement about the rotation.",
        argumentForHostB: "The Rockies have not scored all week.",
        mainAngle: "The Padres blanked the Rockies 4-0 behind eight shutout innings.",
        contrarianAngle: "A 4-0 shutout of a slumping lineup proves very little.",
      },
    }),
  ];
}

const BRAWL_GAME_ID = "mlb-2026-06-10-brawl";

/** One incident, three write-ups: the original (open question), a genuine
 *  follow-up that CLOSES it, and a restatement that adds nothing. */
function updateVsDuplicateFixture(): { base: Fixture; update: Fixture; restatement: Fixture } {
  const shared = {
    evidenceIds: [{ type: "game", id: BRAWL_GAME_ID }, { type: "newsItem", id: "news-brawl" }],
    eventContext: {
      games: [{ id: BRAWL_GAME_ID, leagueId: "MLB", homeTeamId: "mlb-sea", awayTeamId: "mlb-laa", scheduledAt: new Date("2026-06-10T02:10:00Z") }],
      newsItems: [] as Array<{ id: string; title?: string | null; url?: string | null; publishedAt?: Date | string | null; entities?: unknown }>,
    },
  };
  return {
    base: topic({
      id: "upd-base",
      title: "Should the League Suspend Marcus Reeve After the Bench-Clearing Brawl?",
      createdAt: new Date("2026-06-10T14:00:00Z"),
      summary:
        "Marcus Reeve threw a punch in the eighth inning on Tuesday and is awaiting a ruling from the league office, which has given no timetable for a decision.",
      debateScore: 99,
      ...shared,
      sources: [{ canonicalUrl: "https://adv-example.test/brawl", publishedAt: new Date("2026-06-10T13:00:00Z") }],
      researchBrief: {
        facts: [
          { text: "Marcus Reeve threw a punch in the 8th inning." },
          { text: "3 players were ejected by umpire Dana Whitcomb." },
          { text: "2nd bench-clearing incident between these clubs in 2026." },
        ],
        sourceIds: [{ type: "newsItem", id: "news-brawl" }],
        argumentForHostA: "A punch is a punch and the league has to act.",
        argumentForHostB: "Suspensions for brawls are handed out arbitrarily.",
        mainAngle: "Marcus Reeve is awaiting a ruling after the bench-clearing brawl.",
        contrarianAngle: "No timetable means the league is hoping this goes away.",
      },
    }),
    update: topic({
      id: "upd-followup",
      title: "Is a Six-Game Ban Enough for Marcus Reeve?",
      createdAt: new Date("2026-06-12T14:00:00Z"),
      summary:
        "The league announced on Thursday that Marcus Reeve was suspended for six games, and Ana Delgado was fined for her role in the same brawl.",
      debateScore: 70,
      ...shared,
      sources: [{ canonicalUrl: "https://adv-example.test/brawl-ruling", publishedAt: new Date("2026-06-12T13:00:00Z") }],
      researchBrief: {
        facts: [{ text: "Suspended for six games." }],
        sourceIds: [{ type: "newsItem", id: "news-brawl" }],
        argumentForHostA: "Six games is a slap on the wrist.",
        argumentForHostB: "Six games is the harshest ban of the season.",
        mainAngle: "Marcus Reeve was suspended for six games and Ana Delgado was fined.",
        contrarianAngle: "The length of the ban is the wrong argument.",
      },
    }),
    restatement: topic({
      id: "upd-restatement",
      title: "Was the Bench-Clearing Brawl the Ugliest Moment of the Season?",
      createdAt: new Date("2026-06-10T15:00:00Z"),
      summary:
        "Marcus Reeve threw a punch in the eighth inning on Tuesday, and the benches emptied for the second time this season.",
      debateScore: 60,
      ...shared,
      sources: [{ canonicalUrl: "https://adv-example.test/brawl-reaction", publishedAt: new Date("2026-06-10T14:30:00Z") }],
      researchBrief: {
        facts: [{ text: "Benches emptied in the eighth inning." }],
        sourceIds: [{ type: "newsItem", id: "news-brawl" }],
        argumentForHostA: "The brawl was the ugliest thing all season.",
        argumentForHostB: "Baseball has always had brawls.",
        mainAngle: "Marcus Reeve threw a punch and the benches emptied in the eighth inning.",
        contrarianAngle: "The reaction is louder than the incident.",
      },
    }),
  };
}

// ---------------------------------------------------------------------------
// Fake db — only the surface selectAutoTopics touches.
// ---------------------------------------------------------------------------
function makeFakeDb(topics: Fixture[]) {
  const games = topics.flatMap((t) => t.eventContext?.games ?? []);
  const news = topics.flatMap((t) => t.eventContext?.newsItems ?? []);
  const inFilter = (v: string, arg: any) => (arg?.in ? arg.in.includes(v) : true);
  return {
    topicCandidate: {
      findMany: async ({ where }: any) =>
        topics
          .filter((t) => (where?.status ? t.status === where.status : true))
          .slice()
          .sort((a, b) => b.debateScore - a.debateScore),
    },
    game: { findMany: async ({ where }: any) => games.filter((g) => inFilter(g.id, where?.id)) },
    newsItem: { findMany: async ({ where }: any) => news.filter((n) => inFilter(n.id, where?.id)) },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
async function run() {
  console.log("Story clustering — one event can never be three topics:\n");

  const allStar = allStarFixture();
  const control = controlFixture();

  // ---- Diagnostics: the actual numbers this code assigns ------------------
  const dump = (label: string, rows: Fixture[]) => {
    console.log(`  [${label}]`);
    for (let i = 0; i < rows.length; i++) {
      for (let j = i + 1; j < rows.length; j++) {
        const s = compareTopics(rows[i], rows[j]);
        console.log(
          `    ${rows[i].id} ~ ${rows[j].id}  lexical=${s.lexicalCosine.toFixed(3)} concept=${s.conceptCosine.toFixed(3)} entity=${s.entityJaccard.toFixed(3)} evidence=${s.evidenceJaccard.toFixed(3)} claimW=${s.claim.sharedWeight.toFixed(2)}/peak=${s.claim.peakWeight.toFixed(2)} days=${s.dayGap === null ? "?" : s.dayGap} overlap=${s.overlap.toFixed(3)} sameEvent=${s.sameEvent} [${s.signals.map((x) => x.code).join(",") || "none"}]${s.discriminators.length ? ` VETO[${s.discriminators.map((d) => d.code).join(",")}]` : ""}`
        );
      }
    }
  };
  dump("ALL-STAR (the real failure)", allStar);
  dump("CONTROL (genuinely distinct)", control);
  dump("ALL-STAR, hard identifiers stripped", allStarTextOnly());
  console.log("");

  // ---- deriveEventFingerprint reads REAL schema fields ---------------------
  await check("deriveEventFingerprint builds an identity from real columns", () => {
    const fp = deriveEventFingerprint(allStar[0]);
    assert.equal(fp.league, "MLB", "leagueId is the league");
    assert.deepEqual(fp.gameIds, [ASG_GAME_ID], "the game evidence ref becomes a game id");
    assert.deepEqual(fp.teamIds, ["mlb-american-league", "mlb-national-league"], "teams come from the resolved Game row");
    assert.ok(fp.eventDates.includes("2026-07-14"), `event date missing: ${fp.eventDates.join(",")}`);
    assert.ok(fp.people.includes("mike trout"), `people should name Trout, got ${JSON.stringify(fp.people)}`);
    assert.ok(fp.evidenceKeys.includes(`game:${ASG_GAME_ID}`), "evidence refs are keyed type:id");
    assert.ok(
      fp.sourceUrls.includes("espn.com/mlb/story/_/id/2026-all-star-game-recap"),
      `source URL should be normalized (scheme/query stripped), got ${JSON.stringify(fp.sourceUrls)}`
    );
    assert.equal(fp.titleFingerprint.length, 16, "title fingerprint is a stable digest");
  });

  await check("fingerprints are deterministic (same input, byte-identical output)", () => {
    const a = JSON.stringify(allStarFixture().map(deriveEventFingerprint));
    const b = JSON.stringify(allStarFixture().map(deriveEventFingerprint));
    assert.equal(a, b, "clustering must be reproducible in CI — no clocks, no randomness");
  });

  // ---- NEGATIVE: the three All-Star topics are ONE story -------------------
  await check("NEGATIVE FIXTURE: all three All-Star topics land in ONE cluster", () => {
    const res = clusterTopicsByEvent(allStar);
    assert.equal(res.clusters.length, 1, `expected 1 event cluster, got ${res.clusters.length}: ${JSON.stringify(res.clusters.map((c) => c.topicIds))}`);
    assert.deepEqual(res.clusters[0].topicIds.slice().sort(), ["asg-bullpen", "asg-snoozefest", "asg-trout"]);
    assert.ok(res.clusters[0].anchors.length > 0, "the cluster must be able to say what holds it together");
  });

  await check("the merge survives losing the shared gameId (evidence/URL anchors)", () => {
    const noGame = allStar.map((t) => ({
      ...t,
      evidenceIds: (t.evidenceIds as any[]).filter((e) => e.type !== "game"),
      eventContext: null,
    }));
    const res = clusterTopicsByEvent(noGame);
    assert.equal(res.clusters.length, 1, `expected 1 cluster without the gameId, got ${res.clusters.length}`);
  });

  await check("explainDuplicate names a CONCRETE shared signal", () => {
    const reasons = explainDuplicate(allStar[0], allStar[1]);
    const text = reasons.join(" ");
    assert.ok(/same game \(gameId mlb-2026-allstar-phi\)/.test(text), `no concrete gameId in: ${text}`);
    assert.ok(/same event/.test(text), "the verdict must be stated in words");
    // Not just the game: the evidence/URL overlap must be quantified too.
    const noGame = allStar.map((t) => ({ ...t, evidenceIds: (t.evidenceIds as any[]).filter((e) => e.type !== "game"), eventContext: null }));
    const t2 = explainDuplicate(noGame[0], noGame[1]).join(" ");
    assert.ok(/espn\.com/.test(t2) || /share \d+ of \d+ evidence sources/.test(t2), `no concrete source overlap named in: ${t2}`);
  });

  // ---- CONTROL: distinct stories must ALL survive --------------------------
  await check("CONTROL FIXTURE: three distinct stories stay three clusters", () => {
    const res = clusterTopicsByEvent(control);
    assert.equal(res.clusters.length, 3, `distinct stories were wrongly merged: ${JSON.stringify(res.clusters.map((c) => c.topicIds))}`);
    for (const c of res.clusters) assert.equal(c.topicIds.length, 1, "no cluster may hold two distinct stories");
    for (const p of res.pairs) assert.equal(p.sameEvent, false, `${p.topicIdA}/${p.topicIdB} wrongly judged the same event`);
  });

  await check("explainDuplicate on distinct topics says so, with numbers", () => {
    const text = explainDuplicate(control[0], control[1]).join(" ");
    assert.ok(/Different events/.test(text), `expected a 'different events' verdict, got: ${text}`);
  });

  // ---- Enforcement --------------------------------------------------------
  await check("enforceEventDiversity keeps AT MOST ONE All-Star topic", () => {
    const res = enforceEventDiversity(allStar, 3);
    assert.equal(res.chosen.length, 1, `expected 1 survivor, got ${res.chosen.length} (${res.chosen.map((c) => c.id).join(",")})`);
    assert.equal(res.chosen[0].id, "asg-trout", "the highest-ranked member of the cluster is the one kept");
    assert.equal(res.skipped.length, 2, "both duplicates must be reported, not silently dropped");
    for (const s of res.skipped) {
      assert.equal(s.duplicateOfTopicId, "asg-trout");
      assert.ok(s.reasons.join(" ").length > 20, "every skip carries an operator-readable reason");
      assert.ok(s.confidence >= 0.8, `confidence should be high for a same-game merge, got ${s.confidence}`);
    }
  });

  await check("CONTROL: enforceEventDiversity passes all three through", () => {
    const res = enforceEventDiversity(control, 3);
    assert.equal(res.chosen.length, 3, `the filter dropped a legitimate story: ${JSON.stringify(res.skipped.map((s) => s.topicId))}`);
    assert.equal(res.skipped.length, 0, "nothing may be skipped in a clean rundown");
    assert.deepEqual(res.chosen.map((c) => c.id), ["ctl-chiefs", "ctl-wemby", "ctl-panthers"], "rank order is preserved");
  });

  await check("a distinct-but-similar topic is DEFERRED, never deleted", () => {
    // Two real events, deliberately close in wording. Order must change; the
    // count must not.
    const pool = [control[0], allStar[0], control[1], control[2]];
    const res = enforceEventDiversity(pool, 4);
    assert.equal(res.chosen.length, 4, "a soft overlap must never cost a slot");
    assert.equal(res.skipped.length, 0, "soft overlap is not a skip");
  });

  await check("the human override lets duplicates through, and says so", () => {
    const res = enforceEventDiversity(allStar, 3, { allowDuplicateEvents: true });
    assert.equal(res.chosen.length, 3, "an explicit override must be honoured");
    assert.equal(res.overrideApplied, true);
    assert.equal(res.skipped.length, 0);
  });

  await check("maxPerEvent is a real dial (2 angles allowed => 2 kept)", () => {
    const res = enforceEventDiversity(allStar, 3, { maxPerEvent: 2 });
    assert.equal(res.chosen.length, 2, `expected 2, got ${res.chosen.length}`);
    assert.equal(res.skipped.length, 1);
  });

  // ---- Rundown-level scoring ----------------------------------------------
  await check("scoreRundownDiversity FAILS the real e7867729 rundown", () => {
    const r = scoreRundownDiversity(allStar);
    assert.equal(r.passed, false, "three angles on one game is not a rundown");
    assert.equal(r.clusterCount, 1, "one event");
    assert.equal(r.duplicateClusters.length, 1);
    assert.equal(r.duplicateClusters[0].topicIds.length, 3);
    assert.ok(r.score < RUNDOWN_DIVERSITY_THRESHOLD, `score ${r.score} should be below ${RUNDOWN_DIVERSITY_THRESHOLD}`);
    assert.equal(r.pairs.length, 3, "every pair is reported");
    assert.ok(r.pairs.every((p) => p.sameEvent), "each pair is flagged individually");
    assert.ok(r.warnings.length >= 3, "the operator gets a warning per offending pair");
  });

  await check("scoreRundownDiversity PASSES the control rundown", () => {
    const r = scoreRundownDiversity(control);
    assert.equal(r.passed, true, `a clean rundown must pass: score=${r.score} warnings=${JSON.stringify(r.warnings)}`);
    assert.equal(r.clusterCount, 3);
    assert.equal(r.duplicateClusters.length, 0);
    assert.ok(r.score >= RUNDOWN_DIVERSITY_THRESHOLD, `score ${r.score}`);
    assert.ok(r.axes.centralQuestion > 0.8, `central questions should be varied, got ${r.axes.centralQuestion}`);
    assert.ok(r.axes.evidence > 0.8, `evidence should be varied, got ${r.axes.evidence}`);
    assert.ok(r.axes.people > 0.8, `principals should be varied, got ${r.axes.people}`);
  });

  await check("the scorer reports every axis it claims to measure", () => {
    const r = scoreRundownDiversity(allStar);
    for (const [axis, v] of Object.entries(r.axes)) {
      assert.ok(typeof v === "number" && v >= 0 && v <= 1, `${axis} must be a 0..1 number, got ${v}`);
    }
    assert.ok(r.axes.consequence < 0.9, "three restatements of one argument are not varied consequences");
  });

  // ---- Wired into the real selection path ---------------------------------
  await check("selectAutoTopics returns ONE of the three All-Star topics", async () => {
    const db = makeFakeDb(allStar);
    const res = await selectAutoTopics({ targetCount: 3, minDebateScore: 50 }, db as any);
    assert.equal(res.chosen.length, 1, `selection took ${res.chosen.length} angles on one game: ${res.chosen.map((c) => c.title).join(" | ")}`);
    assert.equal(res.eventDiversity?.skipped.length, 2, "the skips must be recorded on the result");
    const why = res.reasons.join(" ");
    assert.ok(/same event as/.test(why), `the operator must be told why: ${why}`);
    assert.ok(/gameId/.test(why), `the reason must name the shared signal: ${why}`);
    assert.ok(/A shorter show beats the same story three times/.test(why), "the shortfall must be explained honestly");
  });

  await check("CONTROL: selectAutoTopics still fills all three slots", async () => {
    const db = makeFakeDb(control);
    const res = await selectAutoTopics({ targetCount: 3, minDebateScore: 50 }, db as any);
    assert.equal(res.chosen.length, 3, `distinct stories must fill the rundown, got ${res.chosen.length}`);
    assert.equal(res.eventDiversity?.skipped.length, 0, "nothing may be skipped");
    assert.ok(scoreRundownDiversity(res.chosen as any).passed, "the produced rundown passes its own diversity gate");
  });

  await check("MIXED POOL: one All-Star angle + the three distinct stories", async () => {
    const db = makeFakeDb([...allStar, ...control]);
    const res = await selectAutoTopics({ targetCount: 3, minDebateScore: 50 }, db as any);
    assert.equal(res.chosen.length, 3, "a full rundown is still available");
    const asgCount = res.chosen.filter((c) => c.id.startsWith("asg-")).length;
    assert.ok(asgCount <= 1, `${asgCount} All-Star angles survived; at most 1 is allowed`);
    assert.ok(scoreRundownDiversity(res.chosen as any).passed, "the produced rundown passes its own diversity gate");
  });

  await check("selectAutoTopics honours the explicit human override", async () => {
    const db = makeFakeDb(allStar);
    const res = await selectAutoTopics({ targetCount: 3, minDebateScore: 50, allowDuplicateEvents: true }, db as any);
    assert.equal(res.chosen.length, 3, "an operator who asks for three angles gets three");
    assert.ok(res.reasons.join(" ").includes("overridden"), "the override must be recorded on the result");
  });

  await check("PRE-EXISTING GATES ARE UNCHANGED: diversity only ever subtracts", async () => {
    // A topic that fails eligibility is still rejected for its OWN reason, and a
    // below-threshold debate score is still filtered — diversity never rescues.
    const pool = [
      { ...control[0], evidenceIds: [] },                      // weak evidence
      { ...control[1], researchBrief: null },                  // missing brief
      { ...control[2], debateScore: 10 },                      // below min score
      allStar[0],                                              // the only survivor
    ] as Fixture[];
    const db = makeFakeDb(pool);
    const res = await selectAutoTopics({ targetCount: 4, minDebateScore: 50 }, db as any);
    assert.deepEqual(res.chosen.map((c) => c.id), ["asg-trout"], `gates were weakened: ${res.chosen.map((c) => c.id).join(",")}`);
    assert.ok(res.weakEvidenceCount >= 1, "the evidence gate still counts");
    assert.ok(res.missingBriefCount >= 1, "the brief gate still counts");
    assert.equal(res.eventDiversity?.skipped.length, 0, "no diversity skip here — these failed for their own reasons");
  });

  await check("empty and single-topic inputs are safe", () => {
    assert.equal(clusterTopicsByEvent([]).clusters.length, 0);
    assert.equal(enforceEventDiversity([], 3).chosen.length, 0);
    assert.equal(enforceEventDiversity(allStar, 0).chosen.length, 0);
    const one = scoreRundownDiversity([allStar[0]]);
    assert.equal(one.passed, true, "a one-topic rundown cannot repeat itself");
    assert.equal(one.pairs.length, 0);
  });

  // ---- The documented limit of THE ANCHOR RULE -----------------------------
  await check("ANCHOR RULE: text-only near-duplicates are still visible to the scorer", () => {
    const stripped = allStarTextOnly();
    const report = scoreRundownDiversity(stripped);
    const worst = Math.max(...report.pairs.map((p) => Math.max(p.lexicalCosine, p.entityJaccard)));
    assert.ok(worst >= SOFT_OVERLAP_COSINE * 0.5, `the prose overlap should still register, got ${worst.toFixed(3)}`);
    assert.ok(
      report.score < 100,
      "a rundown of three near-identical prose topics must not score perfectly even when no hard anchor survives"
    );
  });

  // =========================================================================
  // DURABLE EVENT IDENTITY — the rejected caveat, closed.
  // =========================================================================
  const paraphrased = allStarParaphrased();
  dump("PARAPHRASED All-Star (no ids, no shared proper nouns)", paraphrased);
  dump("ADVERSARIAL: same teams, different dates", sameTeamsDifferentDates());
  dump("ADVERSARIAL: two players, same team, same night", twoPlayersSameTeam());
  dump("ADVERSARIAL: two different 4-0 games, same league, same night", sameNightDifferentGames());
  console.log("");

  // ---- 1. PARAPHRASE REGRESSION -------------------------------------------
  await check("PARAPHRASE FIXTURE really does share no identifiers and no proper nouns", () => {
    const fps = paraphrased.map(deriveEventFingerprint);
    for (let i = 0; i < fps.length; i++) {
      for (let j = i + 1; j < fps.length; j++) {
        const a = fps[i];
        const b = fps[j];
        assert.deepEqual(a.gameIds, [], "the fixture must carry no game ids");
        assert.deepEqual(
          a.evidenceKeys.filter((k) => b.evidenceKeys.includes(k)), [],
          `${a.topicId}/${b.topicId} share an evidence row — the fixture is not honest`
        );
        assert.deepEqual(
          a.sourceUrls.filter((u) => b.sourceUrls.includes(u)), [],
          `${a.topicId}/${b.topicId} share a source URL — the fixture is not honest`
        );
        assert.deepEqual(
          a.canonicalTeams.filter((t) => b.canonicalTeams.includes(t)), [],
          `${a.topicId}/${b.topicId} share a named franchise — the fixture is not honest`
        );
        assert.deepEqual(
          a.personKeys.filter((p) => b.personKeys.includes(p)), [],
          `${a.topicId}/${b.topicId} share a named person — the fixture is not honest`
        );
        const sim = compareFingerprints(a, b);
        assert.ok(
          sim.entityJaccard < SEMANTIC_SAME_EVENT_ENTITY_JACCARD,
          `entity overlap ${sim.entityJaccard.toFixed(3)} is above the old semantic bar — the fixture is not a real paraphrase`
        );
      }
    }
  });

  await check("PARAPHRASE REGRESSION: three reworded All-Star topics STILL cluster into one", () => {
    const res = clusterTopicsByEvent(paraphrased);
    assert.equal(
      res.clusters.length, 1,
      `a paraphrase escaped duplicate protection: ${JSON.stringify(res.clusters.map((c) => c.topicIds))}`
    );
    assert.deepEqual(res.clusters[0].topicIds.slice().sort(), ["par-arms", "par-comeback", "par-snooze"]);
    assert.ok(res.clusters[0].anchors.length > 0, "the cluster must still be able to name what holds it together");
    for (const p of res.pairs) {
      assert.ok(p.sameEvent, `${p.topicIdA}/${p.topicIdB} was not judged the same event`);
      assert.ok(
        p.signals.some((s) => s.code === "same_claim"),
        `${p.topicIdA}/${p.topicIdB} merged without the claim signal: ${p.signals.map((s) => s.code).join(",")}`
      );
    }
  });

  await check("PARAPHRASE REGRESSION: enforcement keeps ONE, and says why in words", () => {
    const res = enforceEventDiversity(paraphrased, 3);
    assert.equal(res.chosen.length, 1, `${res.chosen.length} paraphrases survived: ${res.chosen.map((c) => c.id).join(",")}`);
    assert.equal(res.skipped.length, 2);
    for (const s of res.skipped) {
      const text = s.reasons.join(" ");
      assert.ok(/same claim/.test(text), `the skip must NAME the shared claim: ${text}`);
      assert.ok(/score:4-0/.test(text), `the skip must quote the shared score atom: ${text}`);
      assert.equal(s.relation, "duplicate", "a reworded restatement is a duplicate, not an update");
    }
  });

  await check("PARAPHRASE REGRESSION: selectAutoTopics rejects the reworded rundown too", async () => {
    const db = makeFakeDb(paraphrased);
    const res = await selectAutoTopics({ targetCount: 3, minDebateScore: 50 }, db as any);
    assert.equal(res.chosen.length, 1, `selection took ${res.chosen.length} paraphrases of one event`);
    assert.equal(res.eventDiversity?.skipped.length, 2);
    assert.ok(/same claim/.test(res.reasons.join(" ")), "the operator must be told which claim was shared");
  });

  // ---- 2. IDENTIFIER-OMISSION REGRESSION ----------------------------------
  await check("IDENTIFIER OMISSION: the real All-Star prose with every durable id stripped still clusters", () => {
    const stripped = allStarTextOnly();
    for (const fp of stripped.map(deriveEventFingerprint)) {
      assert.deepEqual(fp.gameIds, [], "no game ids may survive the strip");
      assert.deepEqual(fp.teamIds, [], "no resolved Game rows may survive the strip");
    }
    const res = clusterTopicsByEvent(stripped);
    assert.equal(
      res.clusters.length, 1,
      `stripping the identifiers split one event into ${res.clusters.length}: ${JSON.stringify(res.clusters.map((c) => c.topicIds))}`
    );
    const enforced = enforceEventDiversity(stripped, 3);
    assert.equal(enforced.chosen.length, 1, "hard enforcement must fire, not just the scorer");
    assert.equal(scoreRundownDiversity(stripped).passed, false, "and the rundown gate must fail it");
  });

  // ---- 3. NUMERIC PARAPHRASE ----------------------------------------------
  await check("NUMERIC PARAPHRASE: 'four to nothing', '4-0' and 'a four-run shutout' agree", () => {
    const forms = [
      "the American League won four to nothing",
      "American League shuts out National League 4-0",
      "the winning side needed only a four-run shutout",
      "a 0-4 loss for the National League",
      "they were beaten four-nothing",
    ];
    const atomSets = forms.map((f) => extractClaimAtoms(f).map((a) => a.atom));
    for (let i = 0; i < forms.length; i++) {
      assert.ok(
        atomSets[i].includes("score:4-0"),
        `'${forms[i]}' produced ${JSON.stringify(atomSets[i])} — no score:4-0`
      );
      assert.ok(
        atomSets[i].includes("act:shutout"),
        `'${forms[i]}' should also read as a shutout, got ${JSON.stringify(atomSets[i])}`
      );
    }
    // Different scores must NOT collapse together.
    assert.ok(!extractClaimAtoms("a 6-3 win").map((a) => a.atom).includes("score:4-0"));
    // A batting line is not a score.
    const line = extractClaimAtoms("he went 2-for-3 with a walk").map((a) => a.atom);
    assert.ok(line.includes("line:2-3"), `expected a batting line, got ${JSON.stringify(line)}`);
    assert.ok(!line.includes("score:3-2"), "a 2-for-3 line must never be read as a 3-2 score");
    // Magnitudes: spelled-out and numeric forms agree.
    assert.ok(extractClaimAtoms("eleven pitchers").map((a) => a.atom).includes("mag:11:pitcher"));
    assert.ok(extractClaimAtoms("an 11-pitcher shutout").map((a) => a.atom).includes("mag:11:pitcher"));
  });

  await check("NUMERIC PARAPHRASE: the paraphrased topics carry identical score atoms", () => {
    const fps = paraphrased.map(deriveEventFingerprint);
    for (const fp of fps) {
      const atoms = fp.claimAtoms.map((a) => a.atom);
      assert.ok(atoms.includes("score:4-0"), `${fp.topicId} lost the score atom: ${JSON.stringify(atoms)}`);
      assert.ok(atoms.includes("evt:exhibition"), `${fp.topicId} lost the event type: ${JSON.stringify(atoms)}`);
    }
  });

  // ---- 4. ENTITY ALIAS -----------------------------------------------------
  await check("ENTITY ALIAS: nickname, official name and abbreviation are ONE canonical entity", () => {
    const forms = ["Halos", "Angels", "Los Angeles Angels", "LAA", "Anaheim"];
    for (const f of forms) {
      assert.equal(
        canonicalizeTeamName(f, "MLB"), "MLB:LAA",
        `'${f}' did not resolve to MLB:LAA (got ${canonicalizeTeamName(f, "MLB")})`
      );
    }
    // League scoping: the same nickname is two different franchises.
    assert.equal(canonicalizeTeamName("Rangers", "MLB"), "MLB:TEX");
    assert.equal(canonicalizeTeamName("Rangers", "NHL"), "NHL:NYR");
    assert.notEqual(canonicalizeTeamName("Rangers", "MLB"), canonicalizeTeamName("Rangers", "NHL"));
    assert.equal(canonicalizeTeamName("Giants", "NFL"), "NFL:NYG");
    // A franchise that is not in the table resolves to nothing rather than to
    // a guess.
    assert.equal(canonicalizeTeamName("Whitlock", "MLB"), null);
    // And it works end to end, through a real fingerprint.
    const withNickname = deriveEventFingerprint(topic({ id: "alias-a", title: "Are the Halos Finally Buyers?", sport: "MLB", leagueId: "MLB" }));
    const withFullName = deriveEventFingerprint(topic({ id: "alias-b", title: "Are the Los Angeles Angels Finally Buyers?", sport: "MLB", leagueId: "MLB" }));
    const withAbbr = deriveEventFingerprint(topic({ id: "alias-c", title: "Is LAA Finally Buying?", sport: "MLB", leagueId: "MLB" }));
    assert.deepEqual(withNickname.canonicalTeams, ["MLB:LAA"]);
    assert.deepEqual(withFullName.canonicalTeams, ["MLB:LAA"]);
    assert.deepEqual(withAbbr.canonicalTeams, ["MLB:LAA"]);
  });

  // ---- 5. UPDATE vs DUPLICATE ---------------------------------------------
  await check("UPDATE vs DUPLICATE: a real development is an `update`, a restatement is a `duplicate`", () => {
    const { base, update, restatement } = updateVsDuplicateFixture();
    const fpBase = deriveEventFingerprint(base);
    const fpUpdate = deriveEventFingerprint(update);
    const fpRestate = deriveEventFingerprint(restatement);

    // Both are genuinely the SAME event — otherwise this test proves nothing.
    assert.ok(compareFingerprints(fpBase, fpUpdate).sameEvent, "the follow-up must be the same event");
    assert.ok(compareFingerprints(fpBase, fpRestate).sameEvent, "the restatement must be the same event");

    const upd = classifyEventRelation(fpBase, fpUpdate, { referenceDate: "2026-06-12" });
    assert.equal(upd.relation, "update", `expected an update, got ${upd.relation}: ${upd.reason}`);
    assert.ok(upd.developments.length >= 2, `an update should name its developments, got ${JSON.stringify(upd.developments)}`);
    assert.ok(/resolves the open question/.test(upd.developments.join(" ")), `the closed question must be named: ${JSON.stringify(upd.developments)}`);
    assert.ok(/days newer/.test(upd.developments.join(" ")), `the newer date must be named: ${JSON.stringify(upd.developments)}`);

    const dup = classifyEventRelation(fpBase, fpRestate, { referenceDate: "2026-06-12" });
    assert.equal(dup.relation, "duplicate", `expected a duplicate, got ${dup.relation}: ${dup.reason}`);
    assert.deepEqual(dup.developments, [], "a restatement has no developments to name");
    assert.ok(/no new development/.test(dup.reason), `the verdict must be readable: ${dup.reason}`);
  });

  await check("UPDATE vs DUPLICATE: enforcement ALLOWS the update and BLOCKS the restatement", () => {
    const { base, update, restatement } = updateVsDuplicateFixture();
    const res = enforceEventDiversity([base, update, restatement] as Fixture[], 3);
    const ids = res.chosen.map((c) => c.id);
    assert.ok(ids.includes("upd-base"), "the original must be kept");
    assert.ok(ids.includes("upd-followup"), `the genuine follow-up must be kept, got ${ids.join(",")}`);
    assert.ok(!ids.includes("upd-restatement"), `a restatement must never take a slot, got ${ids.join(",")}`);
    assert.equal(res.skipped.length, 1);
    assert.equal(res.skipped[0].topicId, "upd-restatement");
    assert.equal(res.skipped[0].relation, "duplicate");
    const updateDecision = res.decisions.find((d) => d.topicId === "upd-followup")!;
    assert.equal(updateDecision.outcome, "accepted-as-update");
    assert.equal(updateDecision.relation, "update");

    // The dial must also be able to turn updates OFF entirely.
    const strict = enforceEventDiversity([base, update, restatement] as Fixture[], 3, { allowUpdates: false });
    assert.deepEqual(strict.chosen.map((c) => c.id), ["upd-base"], "with allowUpdates=false only one survives");
    assert.equal(strict.skipped.length, 2);
    assert.ok(
      strict.skipped.every((s) => /Updates are disabled|no new development/.test(s.reasons.join(" ") + " ")) ||
      strict.decisions.some((d) => /Updates are disabled/.test(d.reason)),
      "the operator must be told updates were switched off"
    );
  });

  await check("STALE duplicates are hard-blocked even when maxPerEvent would allow them", () => {
    const { base, restatement } = updateVsDuplicateFixture();
    // A fresh, unrelated story sets the reference day two weeks later, which
    // makes the brawl pair stale.
    const fresh = { ...control[0], id: "fresh-nfl", debateScore: 99 } as Fixture;
    const pool = [base, restatement, fresh] as Fixture[];
    const lenient = enforceEventDiversity(pool, 3, { maxPerEvent: 2, referenceDate: "2026-10-13" });
    const ids = lenient.chosen.map((c) => c.id);
    assert.ok(!ids.includes("upd-restatement"), `a STALE duplicate took a slot anyway: ${ids.join(",")}`);
    const skip = lenient.skipped.find((s) => s.topicId === "upd-restatement");
    assert.ok(skip, "the stale duplicate must be reported");
    assert.equal(skip!.stale, true, "and flagged as stale");
    const decision = lenient.decisions.find((d) => d.topicId === "upd-restatement")!;
    assert.ok(/more than 3 days behind/.test(decision.reason), `the staleness must be explained: ${decision.reason}`);
    // Sanity: with a fresh reference day, maxPerEvent=2 really does allow two.
    const fresher = enforceEventDiversity([base, restatement] as Fixture[], 3, { maxPerEvent: 2, referenceDate: "2026-06-11" });
    assert.equal(fresher.chosen.length, 2, "the allowance itself still works when nothing is stale");
  });

  // ---- 6. PRECISION CONTROL (the part recall must not break) ---------------
  await check("PRECISION: two games between the SAME teams on DIFFERENT dates never merge", () => {
    const pair = sameTeamsDifferentDates();
    const sim = compareTopics(pair[0], pair[1]);
    assert.equal(sim.sameEvent, false, `two different fixtures merged: ${sim.signals.map((s) => s.code).join(",")}`);
    assert.ok(
      sim.claim.sharedAtoms.some((a) => a.atom === "score:4-0"),
      "the fixture must genuinely share the 4-0 claim, or it proves nothing"
    );
    assert.ok(sim.sharedCanonicalTeams.length >= 2, "and the same two franchises");
    assert.ok(
      sim.discriminators.some((d) => d.code === "date_conflict"),
      `the DATE must be what separates them: ${JSON.stringify(sim.discriminators.map((d) => d.code))}`
    );
    assert.deepEqual(
      sim.discriminators.map((d) => d.code), ["date_conflict"],
      "and the date must be the ONLY thing separating them — everything else about these two agrees"
    );
    const res = enforceEventDiversity(pair, 2);
    assert.equal(res.chosen.length, 2, "both fixtures must fill their slots");
    assert.equal(res.skipped.length, 0);
  });

  await check("PRECISION: two players on the SAME team on the SAME night never merge", () => {
    const pair = twoPlayersSameTeam();
    const sim = compareTopics(pair[0], pair[1]);
    assert.equal(sim.sameEvent, false, `two player stories merged: ${sim.signals.map((s) => s.code).join(",")}`);
    assert.ok(sim.sharedCanonicalTeams.length >= 2, "the fixture must genuinely share both franchises");
    assert.equal(sim.dayGap, 0, "and sit on the same day");
    // The canonical-franchise path is ARMED here — same two teams, same day,
    // concept-space overlap above its bar. Only the principals stop it, which
    // is what makes this a real test of the discriminator rather than of a
    // threshold that happened to be missed.
    assert.ok(
      sim.conceptCosine >= CANONICAL_ENTITY_MIN_CONCEPT_COSINE,
      `the canonical-franchise path must actually be reachable, concept=${sim.conceptCosine.toFixed(3)} < ${CANONICAL_ENTITY_MIN_CONCEPT_COSINE}`
    );
    assert.ok(
      sim.discriminators.some((d) => d.code === "disjoint_people"),
      `the PRINCIPALS must be what separates them: ${JSON.stringify(sim.discriminators.map((d) => d.code))}`
    );
    assert.deepEqual(
      sim.discriminators.map((d) => d.code), ["disjoint_people"],
      "and the principals must be the ONLY thing separating them"
    );
    const res = enforceEventDiversity(pair, 2);
    assert.equal(res.chosen.length, 2, "both players' stories must fill their slots");
  });

  await check("PRECISION: two different 4-0 games in one league on one night never merge", () => {
    const pair = sameNightDifferentGames();
    const sim = compareTopics(pair[0], pair[1]);
    assert.equal(sim.sameEvent, false, `two different games merged: ${sim.signals.map((s) => s.code).join(",")}`);
    // This is the adversarial part: the claim fingerprints agree completely and
    // the prose is nearly identical.
    assert.ok(
      sim.claim.sharedAtoms.some((a) => a.atom === "score:4-0"),
      "the fixture must share the score atom, or it proves nothing"
    );
    assert.ok(sim.conceptCosine >= 0.6, `the prose must genuinely be near-identical, got ${sim.conceptCosine.toFixed(3)}`);
    assert.ok(
      sim.discriminators.some((d) => d.code === "disjoint_teams"),
      `the FRANCHISES must be what separates them: ${JSON.stringify(sim.discriminators.map((d) => d.code))}`
    );
    assert.deepEqual(
      sim.discriminators.map((d) => d.code), ["disjoint_teams"],
      "and the franchises must be the ONLY thing separating them"
    );
    const res = enforceEventDiversity(pair, 2);
    assert.equal(res.chosen.length, 2, "both games must fill their slots");
    assert.equal(res.skipped.length, 0);
  });

  await check("PRECISION: the original control still fills all three slots, unchanged", () => {
    const res = clusterTopicsByEvent(control);
    assert.equal(res.clusters.length, 3, "the recall work must not have merged the control");
    const enforced = enforceEventDiversity(control, 3);
    assert.deepEqual(enforced.chosen.map((c) => c.id), ["ctl-chiefs", "ctl-wemby", "ctl-panthers"]);
    assert.equal(enforced.skipped.length, 0);
    assert.equal(scoreRundownDiversity(control).passed, true);
  });

  await check("PRECISION: every adversarial pair survives the whole selection path together", async () => {
    const pool = [
      ...sameTeamsDifferentDates(),
      ...twoPlayersSameTeam(),
      ...sameNightDifferentGames(),
    ] as Fixture[];
    const db = makeFakeDb(pool);
    const res = await selectAutoTopics({ targetCount: 6, minDebateScore: 50 }, db as any);
    assert.equal(
      res.chosen.length, 6,
      `the filter deleted a legitimate story: kept ${res.chosen.map((c) => c.id).join(",")}; skipped ${JSON.stringify(res.eventDiversity?.skipped.map((s) => s.topicId))}`
    );
    assert.equal(res.eventDiversity?.skipped.length, 0, "nothing may be skipped in six distinct stories");
  });

  // ---- 7. REASON PERSISTENCE ----------------------------------------------
  await check("REASON PERSISTENCE: every candidate carries a readable accept/reject/update reason", () => {
    const { base, update, restatement } = updateVsDuplicateFixture();
    const pool = [...paraphrased, base, update, restatement] as Fixture[];
    const res = enforceEventDiversity(pool, 4);

    assert.equal(res.decisions.length, pool.length, "every candidate must appear in the audit trail exactly once");
    const ids = new Set(res.decisions.map((d) => d.topicId));
    for (const t of pool) assert.ok(ids.has(t.id), `${t.id} has no recorded decision`);

    for (const d of res.decisions) {
      assert.ok(d.reason.length > 25, `decision for ${d.topicId} is not a readable sentence: '${d.reason}'`);
      assert.ok(/[a-z]/.test(d.reason) && /\.$/.test(d.reason.trim()), `decision for ${d.topicId} is not prose: '${d.reason}'`);
      assert.ok(
        ["accepted", "accepted-as-update", "accepted-under-override", "rejected", "deferred", "not-considered"].includes(d.outcome),
        `unknown outcome ${d.outcome}`
      );
      assert.ok(typeof d.clusterId === "string" && d.clusterId.length > 0, "each decision names its event cluster");
    }

    const outcomes = new Map(res.decisions.map((d) => [d.topicId, d.outcome]));
    assert.equal(outcomes.get("par-comeback"), "accepted");
    assert.equal(outcomes.get("par-snooze"), "rejected");
    assert.equal(outcomes.get("par-arms"), "rejected");
    assert.equal(outcomes.get("upd-base"), "accepted");
    assert.equal(outcomes.get("upd-followup"), "accepted-as-update");
    assert.equal(outcomes.get("upd-restatement"), "rejected");

    const rejected = res.decisions.find((d) => d.topicId === "par-snooze")!;
    assert.equal(rejected.comparedToTopicId, "par-comeback", "a rejection names what it duplicated");
    assert.ok(/restates facts|no new development/.test(rejected.reason), `unhelpful rejection reason: ${rejected.reason}`);
    const updated = res.decisions.find((d) => d.topicId === "upd-followup")!;
    assert.ok(updated.developments.length > 0, "an update records the developments that earned its slot");
  });

  await check("REASON PERSISTENCE: the reasons reach the selection result an operator reads", async () => {
    const { base, update, restatement } = updateVsDuplicateFixture();
    const db = makeFakeDb([base, update, restatement] as Fixture[]);
    const res = await selectAutoTopics({ targetCount: 3, minDebateScore: 50 }, db as any);
    const decisions = res.eventDiversity?.decisions ?? [];
    assert.ok(decisions.length >= 3, `the audit trail must survive the service boundary, got ${decisions.length}`);
    assert.ok(
      decisions.some((d) => d.outcome === "accepted-as-update"),
      "the update must be visible on the result"
    );
    assert.ok(
      decisions.some((d) => d.outcome === "rejected" && d.relation === "duplicate"),
      "so must the duplicate"
    );
    const why = res.reasons.join(" ");
    assert.ok(/Kept .* as an UPDATE/.test(why), `the operator must be told an update kept its slot: ${why}`);
  });

  await check("the discriminators are reported even when nothing merged", () => {
    const pair = sameNightDifferentGames();
    const text = explainDuplicate(pair[0], pair[1]).join(" ");
    assert.ok(/Different events/.test(text), `expected a 'different events' verdict: ${text}`);
    assert.ok(/discriminator \(disjoint_teams\)/.test(text), `the discriminator must be named: ${text}`);
    assert.ok(/Yankees|Orioles|Padres|Rockies/.test(text), `and it must name the franchises: ${text}`);
  });

  await check("the offline semantic layer is honest: no embedding hook is installed", () => {
    assert.equal(isEmbeddingHookEnabled(), false, "CI must run on the offline path alone");
    // And the offline path is what produced every merge above.
    const res = clusterTopicsByEvent(paraphrased);
    assert.equal(res.clusters.length, 1, "the paraphrase merge must not depend on an encoder");
    for (const p of res.pairs) assert.equal(p.embeddingCosine, 0, "no embedding may have contributed");
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
