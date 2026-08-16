// A job whose worker died never gets to write its own ending.
//
// JobLog rows are written "running" when a job starts and rewritten
// "completed"/"failed" when it ends. If the process is killed in between --
// a deploy, an OOM, a container replacement -- nothing ever closes the row. It
// stays "running" forever, and the admin job table renders that as a live
// elapsed timer that counts up for as long as the row exists.
//
// On 2026-08-16 that table showed jobs "Running 44780s" (12.4 hours) while the
// BullMQ active list held ZERO jobs. 72 rows were stranded, the oldest from
// 2026-07-09 -- five weeks of a status field asserting work was in progress
// when the process that owned it had been gone since July. The operator
// reasonably concluded the app was churning through their quota all day.
//
// Two conditions, both required, because a false positive here means telling
// someone their running job died:
//
//   1. Older than this process. A row this process did not write cannot be
//      one this process is running.
//   2. Older than STALE_AFTER_MS. This is the guard against a second worker.
//      If another container is mid-job, its row is also older than our start,
//      and condition (1) alone would let us stomp it. No job in this pipeline
//      has ever taken more than ~33 minutes; a two-hour floor sits far outside
//      that while still being decisively shorter than "since July".
//
// The rows are marked failed with a message that names the restart as the
// cause, so an orphan is never mistaken for a job that genuinely broke.

/** How long a "running" row must sit untouched before a restart is the only
 *  explanation. Deliberately generous -- see condition (2) above. */
export const DEFAULT_STALE_AFTER_MS = 2 * 60 * 60 * 1000;

export const ORPHAN_ERROR_PREFIX = "Orphaned by a worker restart";

export type ReconcilableRow = { id: string; jobType: string; createdAt: Date; updatedAt?: Date | null };

export type OrphanDecision = {
  row: ReconcilableRow;
  /** Why this row was left alone; absent when it is an orphan. */
  keptBecause?: "started-after-this-process" | "still-within-stale-window";
};

/** The age we judge a row by: when it last showed signs of life. A job that
 *  updates its row as it progresses should not be killed for being long. */
function lastSeenAt(row: ReconcilableRow): Date {
  return row.updatedAt && row.updatedAt > row.createdAt ? row.updatedAt : row.createdAt;
}

export function classifyRow(
  row: ReconcilableRow,
  opts: { processStartedAt: Date; now: Date; staleAfterMs?: number }
): OrphanDecision {
  const staleAfterMs = opts.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const seen = lastSeenAt(row);

  // (1) Anything this process could plausibly have started is off limits.
  if (seen >= opts.processStartedAt) return { row, keptBecause: "started-after-this-process" };

  // (2) And it must be old enough that no in-flight job could look like this.
  if (opts.now.getTime() - seen.getTime() < staleAfterMs) {
    return { row, keptBecause: "still-within-stale-window" };
  }

  return { row };
}

export function selectOrphans(
  rows: ReconcilableRow[],
  opts: { processStartedAt: Date; now: Date; staleAfterMs?: number }
): ReconcilableRow[] {
  return rows.map((r) => classifyRow(r, opts)).filter((d) => !d.keptBecause).map((d) => d.row);
}

export function orphanMessage(row: ReconcilableRow, now: Date): string {
  const minutes = Math.round((now.getTime() - lastSeenAt(row).getTime()) / 60000);
  return (
    `${ORPHAN_ERROR_PREFIX}: this ${row.jobType} job stopped reporting ${minutes} minute(s) ago and the ` +
    `worker that owned it is gone, so it was not running in the meantime. It did not fail on its own -- ` +
    `re-run it if you still want the result.`
  );
}

/** Close every stranded row at boot. Returns how many were closed. Never
 *  throws into the boot path: a bookkeeping repair must not stop the worker
 *  from picking up real work. */
export async function reconcileOrphanedJobLogsOnBoot(deps: {
  db: any;
  processStartedAt: Date;
  now?: Date;
  staleAfterMs?: number;
  log?: (msg: string) => void;
}): Promise<number> {
  const now = deps.now ?? new Date();
  const log = deps.log ?? ((m: string) => console.log(m));
  try {
    const rows: ReconcilableRow[] = await deps.db.jobLog.findMany({
      where: { status: "running" },
      select: { id: true, jobType: true, createdAt: true, updatedAt: true },
    });
    const orphans = selectOrphans(rows, {
      processStartedAt: deps.processStartedAt,
      now,
      staleAfterMs: deps.staleAfterMs,
    });
    if (orphans.length === 0) {
      log(`[Worker] Job-log reconciliation: ${rows.length} running row(s), none orphaned.`);
      return 0;
    }
    // One update per row: the message carries that row's own age, which is the
    // detail that tells an operator how long they were misled.
    for (const row of orphans) {
      await deps.db.jobLog.update({
        where: { id: row.id },
        data: { status: "failed", error: orphanMessage(row, now) },
      });
    }
    log(
      `[Worker] Job-log reconciliation: closed ${orphans.length} orphaned running row(s) ` +
        `(of ${rows.length}); oldest had been stranded since ${lastSeenAt(orphans[0]).toISOString()}.`
    );
    return orphans.length;
  } catch (err) {
    log(`[Worker] Job-log reconciliation failed: ${(err as Error).message}`);
    return 0;
  }
}
