// Pure date/cron logic for the recurring-podcast scheduler. Kept free of
// db/queue imports so it is testable offline (see testRecurringScheduler.ts).

export const RECURRING_GENERATION_TIME = process.env.RECURRING_GENERATION_TIME || "06:00";
export const RECURRING_GENERATION_TZ = process.env.RECURRING_GENERATION_TZ || "America/Chicago";

/** "HH:MM" → daily cron pattern; malformed values fall back to 06:00. */
export function recurringCronPattern(): string {
  const m = RECURRING_GENERATION_TIME.match(/^(\d{1,2}):(\d{2})$/);
  const hour = m ? Math.min(23, Number(m[1])) : 6;
  const minute = m ? Math.min(59, Number(m[2])) : 0;
  return `${minute} ${hour} * * *`;
}

/** Date key (YYYY-MM-DD) and weekday code (mon..sun) for `now` in the scheduler TZ. */
export function schedulerDateParts(now: Date = new Date()): { dateKey: string; weekday: string } {
  // en-CA formats as YYYY-MM-DD
  const dateKey = new Intl.DateTimeFormat("en-CA", {
    timeZone: RECURRING_GENERATION_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone: RECURRING_GENERATION_TZ, weekday: "short" })
    .format(now)
    .toLowerCase()
    .slice(0, 3);
  return { dateKey, weekday };
}
