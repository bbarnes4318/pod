// Each league's season is labelled by its own calendar, not ours.
//
// Production evidence (2026-08-23): the ingest handed every league the current
// calendar year. For NBA that is the season that ENDED 2026-04-12 — the Game
// table held 1,239 NBA rows, 0 of them in the future, while the Odds API was
// returning prices for the 2026-27 season starting in October. Those events had
// no Game row to attach to, so every snapshot was skipped and the job reported
// "oddsapi ingest for NBA wrote 0 rows ... matching Game not found in database".
//
// NETWORK-FREE. Run: npm run test:season-for-league

import { seasonForLeague } from "../lib/services/sportsIngestSchedule";

let passed = 0, failed = 0;
function check(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  OK  ${name}`); }
  catch (err) { failed++; console.error(`  FAIL ${name}\n       ${(err as Error).message}`); }
}
function assert(c: boolean, m: string) { if (!c) throw new Error(m); }
const at = (iso: string) => new Date(`${iso}T12:00:00Z`);

console.log("\nseason resolution per league\n");

check("THE BUG: NBA in August must point at the season about to start", () => {
  assert(seasonForLeague("NBA", at("2026-08-23")) === "2027",
    `the 2026-27 NBA season is "2027"; asking for "2026" returns a season that ended in April`);
});

check("NBA mid-season still resolves to the season being played", () => {
  assert(seasonForLeague("NBA", at("2027-01-15")) === "2027", "January is inside the 2026-27 season");
  assert(seasonForLeague("NBA", at("2027-04-01")) === "2027", "April is the tail of the same season");
});

check("MLB is a single calendar year and was never wrong", () => {
  assert(seasonForLeague("MLB", at("2026-08-23")) === "2026", "MLB 2026 runs inside 2026");
  assert(seasonForLeague("MLB", at("2026-03-25")) === "2026", "opening day is the same season");
});

check("NFL is labelled by the year it STARTS, through the January playoffs", () => {
  assert(seasonForLeague("NFL", at("2026-09-10")) === "2026", "September starts the 2026 season");
  assert(seasonForLeague("NFL", at("2027-01-20")) === "2026",
    "January playoffs still belong to the season that began in September");
  assert(seasonForLeague("NFL", at("2027-03-15")) === "2027", "March turns over to the next season");
});

check("an unknown league falls back to the calendar year, never to a crash", () => {
  assert(seasonForLeague("WNBA", at("2026-08-23")) === "2026", "unknown leagues must still resolve");
  assert(seasonForLeague("", at("2026-08-23")) === "2026", "an empty league id must not throw");
});

check("SPORTS_INGEST_SEASON still forces one season everywhere", () => {
  process.env.SPORTS_INGEST_SEASON = "2024";
  try {
    for (const league of ["NBA", "MLB", "NFL"]) {
      assert(seasonForLeague(league, at("2026-08-23")) === "2024",
        `${league} must honour a deliberate backfill override`);
    }
  } finally {
    delete process.env.SPORTS_INGEST_SEASON;
  }
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
