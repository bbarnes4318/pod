// Topic-aware host-casting report + test. Run: npm run test:host-fit
//
// Exercises the fit scoring (scoreHostFit / selectBestPair in
// hostCastingShared.ts) that the resolveEpisodeHosts fallback now uses. Prints
// each host's fit against three representative topics and the pair the scorer
// selects, then asserts the behavior the bug report cares about:
//   - a betting/point-spread topic surfaces the market personas, and
//   - a baseball-nostalgia topic does NOT cast the betting persona (Mickey) —
//     the exact miscast that motivated this work.
//
// NOTE ON ROSTER: prod's live roster is not reachable from this sandbox (the DB
// host is Coolify-internal). This uses a representative roster — the two seeded
// hosts verbatim plus a betting-markets persona ("Mickey") and a nostalgia
// persona ("Sunny") — to demonstrate selection across >2 candidates. On prod the
// same pure functions run against the live AiHost rows. Pure: no DB, no ffmpeg.

import {
  scoreHostFit,
  selectBestPair,
  MIN_STAKE,
  type ScorableHost,
  type CastingTopicInput,
  type CastingBriefInput,
} from "../lib/services/hostCastingShared";

let passed = 0;
let failed = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.error(`  ✗ ${name}\n      ${(err as Error).message}`);
  }
}
function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

// --- Representative roster ---------------------------------------------------
const ROSTER: ScorableHost[] = [
  {
    id: "marcus",
    name: 'Marcus "Money" Ellison',
    intensityLevel: 9,
    worldview:
      "Legacy is everything. Rings, banners, grit, heart, and performance under pressure define greatness. Stats are excuses from people who never faced a full count in the 9th.",
    likes: ["High stakes", "Game-winning plays", "Championship pedigree", "Old-school defense", "Playoff pressure", "Rivalry games", "Fighter grit", "Coach hot seats"],
    dislikes: ["Spreadsheets", "Regression models", "Analytical projections", "Expected efficiency margins"],
    argumentPatterns: ["Compare legacy and rings of players and coaches", "Accuse the opponent of over-analyzing simple sports", "Emphasize pressure, heart, and legacy-defining moments"],
  },
  {
    id: "daniel",
    name: 'Daniel "The Professor" Reyes',
    intensityLevel: 3,
    worldview:
      "The scoreboard tells what happened, the data tells what will happen. Clutch and legacy narratives are noise. Value lives in efficiency margins, true shooting, EPA, run differential, and betting market movements.",
    likes: ["True shooting percentage", "Adjusted net ratings", "Under-valued betting odds", "Regression models", "Expected Points Added", "Run differential", "Strength of schedule", "Coaching tendencies"],
    dislikes: ["Rings arguments", "Intangibles", "Clutch narratives", "Eye-test observations", "Hot takes"],
    argumentPatterns: ["Dismantle narrative claims with statistical evidence", "Explain how expected performance contradicts short-term outcomes", "Patronize emotional arguments as mathematically illiterate"],
  },
  {
    id: "mickey",
    name: 'Mickey "The Line" Doyle',
    intensityLevel: 6,
    worldview:
      "The market prices everything. Point spreads, closing line value, and sharp money reveal the true number long before the narrative catches up. Expected value is the only honest scoreboard.",
    likes: ["Point spreads", "Sharp money", "Closing line value", "Betting market moves", "Line movement", "Arbitrage", "Vig and juice", "Expected value"],
    dislikes: ["Narrative", "Nostalgia", "Gut-feel picks", "Homer takes", "Ignoring the number"],
    argumentPatterns: ["Cite line movement and closing value", "Frame every take as expected value", "Trust the market over the story"],
  },
  {
    id: "sunny",
    name: 'Sunny "The Bard" Alvarez',
    intensityLevel: 7,
    worldview:
      "Sports are a story we tell across generations. Dynasties, ballpark history, franchise legacy, and the romance of a golden era matter more than any number on a screen.",
    likes: ["Dynasty history", "Ballpark nostalgia", "Franchise legacy", "Storylines", "Tradition", "Golden era greatness", "Rivalry lore"],
    dislikes: ["Spreadsheets", "Betting market talk", "Regression models", "Cold analytics"],
    argumentPatterns: ["Invoke history and dynasty legacy", "Tell the story behind the game", "Dismiss numbers as missing the romance"],
  },
];

// --- Three sample topics -----------------------------------------------------
interface Sample {
  label: string;
  topic: CastingTopicInput;
  brief: CastingBriefInput;
}
const SAMPLES: Sample[] = [
  {
    label: "Betting / point-spread",
    topic: {
      sport: "Betting",
      leagueId: "GAMBLING",
      title: "Why the spread moved three points on a quiet Tuesday",
      summary:
        "A point spread jumped from six and a half to three and a half on no injury news. Sharp money hit the side and the books respected the line movement instantly.",
    },
    brief: {
      mainAngle: "Sharp money and closing line value reveal the true number the market trusts.",
      contrarianAngle: "The eye test and the matchup story beat the model when the number overcorrects.",
    },
  },
  {
    label: "Baseball nostalgia / narrative",
    topic: {
      sport: "Baseball",
      leagueId: "MLB",
      title: "Was that golden-era dynasty the greatest franchise run ever?",
      summary:
        "A debate over whether a legendary franchise's championship dynasty, its rings and its grit, stands as the greatest run in the sport's history.",
    },
    brief: {
      mainAngle: "Rings, legacy, and dynasty grit define greatness across generations.",
      contrarianAngle: "Regression and efficiency analytics show the era was overrated against its competition.",
    },
  },
  {
    label: "Injury news",
    topic: {
      sport: "Basketball",
      leagueId: "NBA",
      title: "Does the star's injury gut the contender's playoff ceiling?",
      summary:
        "A contender loses its star to injury before the playoffs. Question is whether the ceiling collapses or depth and coaching adjustments absorb the loss.",
    },
    brief: {
      mainAngle: "The injury guts the contender's ceiling and its pressure moments.",
      contrarianAngle: "Roster depth, run differential, and coaching tendencies absorb the loss.",
    },
  },
];

function reportTopic(s: Sample) {
  console.log(`\n=== ${s.label} ===`);
  console.log(`Topic: ${s.topic.title}`);
  const fits = ROSTER.map((h) => ({ h, f: scoreHostFit(h, s.topic, s.brief) }))
    .sort((a, b) => b.f.fit - a.f.fit);
  for (const { h, f } of fits) {
    const stake = f.fit >= MIN_STAKE ? "stake" : "no stake";
    const side = f.lean > 0 ? "main" : f.lean < 0 ? "contra" : "neutral";
    console.log(
      `  ${h.name.padEnd(28)} fit=${f.fit.toFixed(1).padStart(4)}  lean=${String(f.lean).padStart(3)} (${side}, ${stake})  [for ${f.forHits}, against ${f.againstHits}]`
    );
  }
  const best = selectBestPair(ROSTER, s.topic, s.brief);
  if (!best) {
    console.log("  -> no stake-qualified pair; would fall back to intensity sort");
    return null;
  }
  const A = ROSTER[best.aIndex].name;
  const B = ROSTER[best.bIndex].name;
  console.log(
    `  -> SELECTED: ${A}  +  ${B}   pairScore=${best.pair.pairScore.toFixed(1)} (fitA=${best.pair.a.fit.toFixed(1)}, fitB=${best.pair.b.fit.toFixed(1)}, opposition=${best.pair.opposition.toFixed(1)} [leanSpread=${best.pair.leanSpread}, clash=${best.pair.clash}])`
  );
  return { best, ids: [ROSTER[best.aIndex].id, ROSTER[best.bIndex].id] };
}

function main() {
  console.log("Topic-aware host casting — fit report across 3 topics");
  console.log("Formula: pairScore = fit(A) + fit(B) + opposition; opposition = |lean(A)-lean(B)| + 0.5*clash");
  console.log("Gate: both fit >= MIN_STAKE, else fall back to intensity sort.");

  const betting = reportTopic(SAMPLES[0]);
  const nostalgia = reportTopic(SAMPLES[1]);
  const injury = reportTopic(SAMPLES[2]);

  console.log("\nAssertions:");

  check("every selected pair has two staked hosts that disagree (opposition > 0)", () => {
    for (const r of [betting, nostalgia, injury]) {
      assert(!!r, "expected a selected pair");
      assert(r!.best.pair.a.fit >= MIN_STAKE && r!.best.pair.b.fit >= MIN_STAKE, "both must have a stake");
      assert(r!.best.pair.opposition > 0, "pair must actually disagree");
    }
  });

  check("betting topic casts the betting-markets persona (Mickey)", () => {
    assert(!!betting && betting.ids.includes("mickey"), "Mickey should be cast on a point-spread topic");
  });

  check("nostalgia topic does NOT cast the betting persona (the reported miscast)", () => {
    assert(!!nostalgia && !nostalgia.ids.includes("mickey"), "Mickey must NOT be cast on a baseball-nostalgia debate");
  });

  check("nostalgia topic pairs a legacy voice against an analytics voice", () => {
    // Marcus (legacy, main) vs Daniel (analytics, contra) is the sensible clash.
    assert(!!nostalgia && nostalgia.ids.includes("daniel"), "an analytics contrarian belongs on the nostalgia debate");
    assert(!!nostalgia && (nostalgia.ids.includes("marcus") || nostalgia.ids.includes("sunny")), "a legacy/nostalgia voice belongs on it too");
  });

  check("selection is NOT just the two most intense (Marcus 9 + Sunny 7)", () => {
    // If casting ignored topic fit it would always pick intensity 9 + 7.
    const naive = new Set(["marcus", "sunny"]);
    const anyDiffers = [betting, nostalgia, injury].some(
      (r) => r && !(r.ids.every((id) => naive.has(id)) && r.ids.length === 2)
    );
    assert(anyDiffers, "topic-aware casting should diverge from pure intensity ranking");
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
