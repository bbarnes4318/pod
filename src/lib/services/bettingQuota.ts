// The betting quota: at most ONE betting-framed topic per rolling 30 days.
//
// Enforced at GENERATION, never at render. Filtering the picker while the
// generator keeps producing odds topics does not fix the pool — it hides the
// symptom, leaves the cost paid, and regresses the moment a different surface
// forgets to filter. Over quota means NOT GENERATED.
//
// A rolling window over creation timestamps, not a calendar month and not a
// counter that resets: there is no boundary to game and no reset job to forget.
//
// Odds may still appear as a supporting FACT inside a topic. This governs the
// FRAME only — see lib/services/bettingFrame.ts for that distinction.

import { db } from "@/lib/db";

/** How many betting-framed topics may exist inside the window. */
export const BETTING_QUOTA = 1;
/** The rolling window, in days. */
export const BETTING_WINDOW_DAYS = 30;

export interface QuotaState {
  used: number;
  limit: number;
  windowDays: number;
  /** True when another betting-framed topic may be created. */
  allows: boolean;
  /** When the oldest in-window betting topic ages out, if any. */
  nextFreeAt: Date | null;
}

/**
 * Current quota state.
 *
 * Deliberately NOT parameterised by podcast: TopicCandidate is a single
 * deployment-wide pool that every show picks from, so a per-podcast count would
 * imply a guarantee the data model cannot make. When topics become per-show this
 * gains a scope argument.
 */
export async function bettingQuotaState(): Promise<QuotaState> {
  const since = new Date(Date.now() - BETTING_WINDOW_DAYS * 86400000);
  const rows = await db.topicCandidate.findMany({
    where: { frame: "betting", createdAt: { gte: since } },
    orderBy: { createdAt: "asc" },
    select: { createdAt: true },
  });
  const oldest = rows[0]?.createdAt ?? null;
  return {
    used: rows.length,
    limit: BETTING_QUOTA,
    windowDays: BETTING_WINDOW_DAYS,
    allows: rows.length < BETTING_QUOTA,
    nextFreeAt: oldest ? new Date(oldest.getTime() + BETTING_WINDOW_DAYS * 86400000) : null,
  };
}

/**
 * Decide, for a batch about to be inserted, how many betting-framed topics may
 * still be admitted. Pure so the insert loop's behaviour is testable without a
 * database.
 */
export function admitsBetting(alreadyUsed: number, admittedSoFarInBatch: number): boolean {
  return alreadyUsed + admittedSoFarInBatch < BETTING_QUOTA;
}

/**
 * Betting share of the live selectable pool, as a percentage. Reported on every
 * scheduled generation run so a regression is visible in the job log rather than
 * rediscovered months later by reading the board.
 */
export async function poolBettingPercent(): Promise<number> {
  const [total, betting] = await Promise.all([
    db.topicCandidate.count({ where: { status: { in: ["approved", "pending"] } } }),
    db.topicCandidate.count({ where: { status: { in: ["approved", "pending"] }, frame: "betting" } }),
  ]);
  return total === 0 ? 0 : Math.round((betting / total) * 1000) / 10;
}
