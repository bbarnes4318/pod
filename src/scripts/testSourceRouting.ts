// Validation Script for Research Brief Source Routing and Classification Heuristics
import { assertProductionEnv } from "../lib/env";

// Stub environment settings for local verification runs
process.env.LLM_PROVIDER = "stub"; 

function runHeuristicClassification(title: string, summary: string): string {
  const combined = `${title} ${summary || ""}`.toLowerCase();
  if (combined.match(/\b(odds|spread|total|moneyline|betting|wager|sportsbook)\b/i)) {
    return "betting_market";
  }
  if (combined.match(/\b(preview|matchup|versus|vs\b|play against|upcoming game)\b/i)) {
    return "game_preview";
  }
  if (combined.match(/\b(breaking|injury|injuries|trade\b|traded|signing|signed|fired|hired|announced)\b/i)) {
    return "news_reaction";
  }
  if (combined.match(/\b(coach|coaching|manager|head coach)\b/i)) {
    return "coach_topic";
  }
  if (combined.match(/\b(player|quarterback|qb|mvp|rookie|athlete)\b/i)) {
    return "player_topic";
  }
  if (combined.match(/\b(team|franchise|club|squad)\b/i)) {
    return "team_topic";
  }
  if (combined.match(/\b(conference|division|sec|big ten|acc|pac-12|playoff bracket)\b/i)) {
    return "conference_topic";
  }
  return "generic_sports_take";
}

const testCases = [
  {
    title: "Alabama vs Tennessee Betting Odds and Market Preview",
    summary: "Checking out the latest moneyline and spread movement for the SEC showdown.",
    expected: "betting_market",
  },
  {
    title: "Lakers vs Celtics Matchup Preview",
    summary: "An in-depth look at how the two teams match up tonight at TD Garden.",
    expected: "game_preview",
  },
  {
    title: "BREAKING: Star Quarterback Traded to Jets",
    summary: "In a stunning move, the trade was finalized this morning.",
    expected: "news_reaction",
  },
  {
    title: "New Head Coach Hired for Giants",
    summary: "The coaching carousel stops in New York with a fresh hire.",
    expected: "news_reaction",
  },
  {
    title: "Is Mahomes the MVP Frontrunner?",
    summary: "Analyzing Mahomes' play this season and if he's the leading player.",
    expected: "player_topic",
  },
  {
    title: "SEC Expansion and Conference Realignment",
    summary: "How the SEC division structure is changing next season.",
    expected: "conference_topic",
  },
  {
    title: "Why the 1990s Bulls Were the Greatest Dynasty",
    summary: "A generic debate on historical greatness in basketball.",
    expected: "generic_sports_take",
  },
];

console.log("--------------------------------------------------");
console.log("RUNNING TOPIC CLASSIFICATION HEURISTIC TESTS");
console.log("--------------------------------------------------");

let passCount = 0;
let failCount = 0;

for (const tc of testCases) {
  const result = runHeuristicClassification(tc.title, tc.summary);
  if (result === tc.expected) {
    console.log(`[PASS] "${tc.title}" -> ${result}`);
    passCount++;
  } else {
    console.error(`[FAIL] "${tc.title}" -> expected: ${tc.expected}, got: ${result}`);
    failCount++;
  }
}

console.log("--------------------------------------------------");
console.log(`RESULTS: ${passCount} Passed, ${failCount} Failed.`);
console.log("--------------------------------------------------");

if (failCount > 0) {
  process.exit(1);
} else {
  console.log("All tests passed successfully!");
  process.exit(0);
}
