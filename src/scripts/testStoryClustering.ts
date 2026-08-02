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
/* eslint-disable @typescript-eslint/no-explicit-any -- test harness: the
   in-memory fake DB doubles are intentionally loosely typed. */

import assert from "node:assert/strict";
import {
  clusterTopicsByEvent,
  compareTopics,
  deriveEventFingerprint,
  enforceEventDiversity,
  explainDuplicate,
  scoreRundownDiversity,
  RUNDOWN_DIVERSITY_THRESHOLD,
  SOFT_OVERLAP_COSINE,
  type ClusterableTopic,
} from "../lib/services/storyClustering";
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
          `    ${rows[i].id} ~ ${rows[j].id}  lexical=${s.lexicalCosine.toFixed(3)} title=${s.titleCosine.toFixed(3)} entity=${s.entityJaccard.toFixed(3)} evidence=${s.evidenceJaccard.toFixed(3)} overlap=${s.overlap.toFixed(3)} sameEvent=${s.sameEvent} [${s.signals.map((x) => x.code).join(",") || "none"}]`
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

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
