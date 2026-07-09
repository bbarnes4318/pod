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

/** Daily structured-data + odds ingest cadence. Default: 05:15 (provider TZ). */
export function sportsIngestCron(): string {
  return validateCron(process.env.SPORTS_INGEST_CRON, "15 5 * * *");
}

/** News ingest cadence (more frequent than the structured feed). Default: 3h. */
export function sportsNewsCron(): string {
  return validateCron(process.env.SPORTS_NEWS_CRON, "0 */3 * * *");
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
