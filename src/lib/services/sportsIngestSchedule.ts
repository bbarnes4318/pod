// Pure config/cron logic for the SCHEDULED sports-data ingestion. Kept free of
// db/queue imports so it stays trivially testable and importable anywhere.
//
// The worker registers two idempotent BullMQ schedulers from these values:
//   - sports-ingest-daily  → structured data (games/stats/injuries) + odds
//   - sports-news-frequent → RSS news, on a shorter cadence
// Cadence, leagues, and season are all env-tunable so operators can match their
// provider's rate limits and in-season leagues without a code change.

export const SPORTS_INGEST_TZ = process.env.SPORTS_INGEST_TZ || "Etc/UTC";

/** Delay (ms) applied to the per-league Odds API job so the SportsDataIO games
 *  it must match are ingested first (odds attach to existing Game rows). */
export const SPORTS_ODDS_DELAY_MS = (() => {
  const n = Number(process.env.SPORTS_ODDS_DELAY_MINUTES);
  return (Number.isFinite(n) && n > 0 ? n : 10) * 60 * 1000;
})();

/** Leagues to auto-ingest. Default: the three SportsDataIO fully supports
 *  (schedules / standings / team+player stats / injuries) and Odds API maps. */
export function getSportsIngestLeagues(): string[] {
  const raw = process.env.SPORTS_INGEST_LEAGUES || "NFL,NBA,MLB";
  return raw.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
}

/** Season/year passed to SportsDataIO schedules/standings/stats endpoints. */
export function getSportsIngestSeason(now: Date = new Date()): string {
  const env = (process.env.SPORTS_INGEST_SEASON || "").trim();
  return env || String(now.getUTCFullYear());
}

/**
 * Leagues whose season SPANS the new year and is therefore labelled by the year
 * it ENDS. The 2026-27 NBA season is season "2027", not "2026".
 */
const SPLIT_YEAR_LEAGUES = new Set(["NBA", "NHL", "NCAAB"]);

/**
 * Leagues that start in autumn and are labelled by the year they BEGIN. The
 * 2026 NFL season runs Sep 2026 into Feb 2027 and is season "2026" throughout.
 */
const AUTUMN_START_LEAGUES = new Set(["NFL", "NCAAF"]);

/**
 * The season to ingest for ONE league, right now.
 *
 * Every league used to be handed the current calendar year, and for two of the
 * three configured leagues that is correct: MLB 2026 runs inside 2026, and NFL
 * 2026 is labelled by the year it starts. For NBA it is silently a season out
 * of date for half the year.
 *
 * On 2026-08-23 the ingest asked SportsDataIO for NBA season "2026" and got the
 * season that ENDED on 2026-04-12 — 1,239 games, all of them already stored and
 * all of them in the past. Meanwhile the Odds API was returning prices for the
 * 2026-27 season that starts in October. Those events had no Game row to attach
 * to, so every odds snapshot was skipped and the job reported
 * "oddsapi ingest for NBA wrote 0 rows ... matching Game not found in database".
 * The odds matcher was never the problem: it cannot match a game nobody
 * ingested.
 *
 * Past games are unaffected either way — Game rows persist, so last season stays
 * available for a podcast to discuss. What was missing was the FUTURE half of
 * the calendar, which is where an upcoming-game debate has to come from.
 *
 * SPORTS_INGEST_SEASON still forces one season across every league, for
 * backfilling a specific year on purpose.
 */
export function seasonForLeague(leagueId: string, now: Date = new Date()): string {
  const forced = (process.env.SPORTS_INGEST_SEASON || "").trim();
  if (forced) return forced;

  const league = (leagueId || "").trim().toUpperCase();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() + 1; // 1-12

  if (SPLIT_YEAR_LEAGUES.has(league)) {
    // Seasons tip over in the summer: from July the relevant season is the one
    // that tips into NEXT year, which is the one labelled year + 1.
    return String(month >= 7 ? year + 1 : year);
  }

  if (AUTUMN_START_LEAGUES.has(league)) {
    // Jan/Feb are the tail of the PREVIOUS season (playoffs), still labelled by
    // the year that season began.
    return String(month <= 2 ? year - 1 : year);
  }

  // MLB and anything else: one season, inside one calendar year.
  return String(year);
}

/** Daily structured-data + odds ingest cadence. Default: 05:15 (provider TZ). */
export function sportsIngestCron(): string {
  return validateCron(process.env.SPORTS_INGEST_CRON, "15 5 * * *");
}

/** News ingest cadence (more frequent than the structured feed). Default: 3h. */
export function sportsNewsCron(): string {
  return validateCron(process.env.SPORTS_NEWS_CRON, "0 */3 * * *");
}

/**
 * Topic generation runs TWICE A DAY, not every three hours.
 *
 * It used to be `30 * /3 * * *` — eight runs a day, each fanning out into a
 * research brief per topic. On 2026-08-16 that produced 47 topic jobs and 225
 * research briefs in 24 hours, all of them background work nobody asked for.
 *
 * The cost was not the tokens. Those jobs share provider accounts with the
 * foreground script pipeline, so the background fan-out was spending the
 * free-tier rate limits that a user's episode then needed: the operator's
 * script runs died on `rate_limited (HTTP 429)` from Z.ai and
 * `quota_exhausted` from Cerebras while the schedulers were mid-sweep. The app
 * was competing with itself and the background work was winning.
 *
 * 05:30 lands after the 05:15 structured ingest; 17:30 picks up the afternoon
 * news cycle. Anyone who wants fresher topics runs it on demand, where the run
 * is attributable to a person and its cost is shown before they commit.
 * TOPICS_GENERATE_CRON still overrides this for a deployment that has its own
 * provider headroom.
 */
export function topicsGenerateCron(): string {
  return validateCron(process.env.TOPICS_GENERATE_CRON, "30 5,17 * * *");
}

/** Scheduled runs per day implied by the active cron — shown in the UI next to
 *  the on-demand control so "more often" is a comparison, not a guess. */
export function scheduledTopicRunsPerDay(cron: string = topicsGenerateCron()): number {
  const hours = cron.trim().split(/\s+/)[1] ?? "*";
  if (hours === "*") return 24;
  const step = hours.match(/^\*\/(\d+)$/);
  if (step) return Math.floor(24 / Number(step[1]));
  return hours.split(",").filter(Boolean).length;
}

/** Minimum debate score for scheduler-generated topics (0 = keep all). */
export function topicsGenerateMinScore(): number {
  const n = Number(process.env.TOPICS_GENERATE_MIN_SCORE);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** UTC day bucket (YYYY-MM-DD) for deterministic per-day child job ids. */
export function ingestDateKey(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** UTC day+hour bucket (YYYY-MM-DDTHH) for the news job's dedupe id. */
export function ingestHourKey(now: Date = new Date()): string {
  return now.toISOString().slice(0, 13);
}

/** Accept a well-formed 5-field cron, else fall back. */
function validateCron(val: string | undefined, fallback: string): string {
  const v = (val || "").trim();
  return v && v.split(/\s+/).length === 5 ? v : fallback;
}
