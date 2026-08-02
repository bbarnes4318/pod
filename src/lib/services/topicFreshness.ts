// One freshness policy for generation, lifecycle cleanup, and every Studio
// surface. A topic is a perishable production input, not an evergreen record.

const HOUR_MS = 60 * 60 * 1000;

function positiveHours(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Topics older than this are archived and never offered in Studio. */
export function activeTopicMaxAgeHours(): number {
  return positiveHours(process.env.TOPIC_MAX_AGE_HOURS, 48);
}

/** Duplicate protection is deliberately short-lived: a story may materially
 * evolve and become a new debate after the active board has expired. */
export function topicDedupeWindowHours(): number {
  return positiveHours(process.env.TOPIC_DEDUPE_WINDOW_HOURS, 168);
}

export function hoursBefore(now: Date, hours: number): Date {
  return new Date(now.getTime() - hours * HOUR_MS);
}

export function hoursAfter(now: Date, hours: number): Date {
  return new Date(now.getTime() + hours * HOUR_MS);
}

export function activeTopicCutoff(now: Date = new Date()): Date {
  return hoursBefore(now, activeTopicMaxAgeHours());
}

export function topicDedupeCutoff(now: Date = new Date()): Date {
  return hoursBefore(now, topicDedupeWindowHours());
}

/** Hard evidence windows. Stats can provide context for a fresh event, but
 * cannot keep a dead story alive by themselves. */
export function topicEvidenceWindow(now: Date = new Date()) {
  return {
    newsAfter: hoursBefore(now, positiveHours(process.env.TOPIC_NEWS_MAX_AGE_HOURS, 48)),
    injuryAfter: hoursBefore(now, positiveHours(process.env.TOPIC_INJURY_MAX_AGE_HOURS, 72)),
    gameAfter: hoursBefore(now, positiveHours(process.env.TOPIC_GAME_PAST_HOURS, 72)),
    gameBefore: hoursAfter(now, positiveHours(process.env.TOPIC_GAME_FUTURE_HOURS, 72)),
    oddsAfter: hoursBefore(now, positiveHours(process.env.TOPIC_ODDS_MAX_AGE_HOURS, 24)),
    statsAfter: hoursBefore(now, positiveHours(process.env.TOPIC_STATS_MAX_AGE_HOURS, 168)),
  };
}

