// Offline test of the recurring-scheduler date logic (no DB/Redis needed —
// only pure functions are exercised). Run: npm run test:recurring-scheduler

import {
  recurringCronPattern,
  schedulerDateParts,
  RECURRING_GENERATION_TZ,
} from "../lib/services/recurringSchedule";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}: ${JSON.stringify(actual)}${ok ? "" : ` (expected ${JSON.stringify(expected)})`}`);
  if (!ok) failures++;
}

// Defaults: 06:00 America/Chicago
check("default TZ", RECURRING_GENERATION_TZ, "America/Chicago");
check("default cron pattern", recurringCronPattern(), "0 6 * * *");

// 2026-07-06 is a Monday. 12:00Z = 07:00 CDT (UTC-5) — still Monday.
check("Mon 12:00Z → Chicago", schedulerDateParts(new Date("2026-07-06T12:00:00Z")), {
  dateKey: "2026-07-06",
  weekday: "mon",
});

// 04:00Z Monday = 23:00 CDT Sunday — the TZ boundary must matter.
check("Mon 04:00Z → Chicago is still Sunday", schedulerDateParts(new Date("2026-07-06T04:00:00Z")), {
  dateKey: "2026-07-05",
  weekday: "sun",
});

// Winter (CST, UTC-6): 2026-01-15 is a Thursday; 05:00Z = 23:00 CST Wed.
check("winter boundary (CST)", schedulerDateParts(new Date("2026-01-15T05:00:00Z")), {
  dateKey: "2026-01-14",
  weekday: "wed",
});

// A Mon/Thu podcast is due exactly on mon + thu.
const scheduleDays = ["mon", "thu"];
const due = (iso: string) => scheduleDays.includes(schedulerDateParts(new Date(iso)).weekday);
check("Mon/Thu podcast due on Monday", due("2026-07-06T12:00:00Z"), true);
check("Mon/Thu podcast due on Thursday", due("2026-07-09T12:00:00Z"), true);
check("Mon/Thu podcast NOT due on Wednesday", due("2026-07-08T12:00:00Z"), false);

// Same-day idempotency key: two runs on the same Chicago day yield the same
// dateKey (the DB claim + BullMQ jobId both key on it).
const run1 = schedulerDateParts(new Date("2026-07-06T11:05:00Z"));
const run2 = schedulerDateParts(new Date("2026-07-06T20:00:00Z"));
check("same-day re-run produces the same claim key", run1.dateKey === run2.dateKey, true);

// ---- Vertical ↔ topic matching (episode auto-selection) ----
import { topicMatchesVertical, topicMatchesAnyVertical } from "../lib/verticals";

const nflTopic = { leagueId: "NFL", sport: "Football", title: "Is Mahomes cooked?", summary: "", bettingRelevanceScore: 30 };
const bettingTopic = { leagueId: "NBA", sport: "Basketball", title: "Lakers moneyline madness", summary: "The spread moved 4 points overnight", bettingRelevanceScore: 82 };
const pokerTopic = { leagueId: "POKER", sport: "Poker", title: "Was that WSOP bluff genius?", summary: "", bettingRelevanceScore: 10 };
const fantasyTopic = { leagueId: "NFL", sport: "Football", title: "Waiver wire gold: who do you start?", summary: "Fantasy managers scramble", bettingRelevanceScore: 5 };
const mmaTopic = { leagueId: "MMA", sport: "Combat Sports", title: "Was the stoppage early?", summary: "", bettingRelevanceScore: 5 };

check("NFL topic matches NFL vertical", topicMatchesVertical(nflTopic, "NFL"), true);
check("NFL topic does not match NBA vertical", topicMatchesVertical(nflTopic, "NBA"), false);
check("high-betting topic matches Gambling vertical", topicMatchesVertical(bettingTopic, "Gambling/Point Spread"), true);
check("plain NFL topic does not match Gambling", topicMatchesVertical(nflTopic, "Gambling/Point Spread"), false);
check("POKER-league topic matches Poker vertical", topicMatchesVertical(pokerTopic, "Poker"), true);
check("fantasy keywords match Fantasy vertical", topicMatchesVertical(fantasyTopic, "Fantasy Sports"), true);
check("multi-vertical any-match", topicMatchesAnyVertical(bettingTopic, ["NFL", "Gambling/Point Spread"]), true);
check("'All' passes every topic (even MMA)", topicMatchesAnyVertical(mmaTopic, ["All"]), true);
check("full expanded selection also passes MMA", topicMatchesAnyVertical(mmaTopic, ["NFL","NBA","MLB","NHL","College Football","College Basketball","Gambling/Point Spread","Fantasy Sports","Poker"]), true);
check("narrow selection excludes MMA", topicMatchesAnyVertical(mmaTopic, ["NFL"]), false);

console.log(failures === 0 ? "\nAll scheduler + vertical-matching checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
