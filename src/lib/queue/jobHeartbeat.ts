// PROOF OF LIFE FOR A ROW THAT ONLY EVER SPOKE TWICE.
//
// A JobLog row is written "running" when a job starts and rewritten
// "completed"/"failed" when it ends. Between those two moments it says nothing
// at all, and /admin/job-logs renders the silence as a counter ticking upward.
// "Running 4096s" therefore means one of two completely different things:
//
//   * a job that really is 68 minutes into its work, or
//   * a job that died 60 minutes ago and left a row nobody closed.
//
// The operator cannot tell which, and on 2026-08-24 that ambiguity is what
// turned a slow job into an emergency. jobLogReconciliation.ts already reads
// `updatedAt` as "when it last showed signs of life" and says so in as many
// words -- "a job that updates its row as it progresses should not be killed
// for being long" -- but nothing in the pipeline ever produced those signs.
// This is that missing writer.
//
// The heartbeat is deliberately dumb: it touches the row and nothing else. It
// makes no claim about PROGRESS, because a claim about progress that the
// pipeline does not actually measure would be a second lie layered over the
// first. It says only "the process that owns this row was alive N seconds ago",
// which is exactly the fact that was missing.

/** How often a running row is touched. Comfortably inside the two-hour
 *  staleness floor in jobLogReconciliation, and frequent enough that the admin
 *  table can call a row stranded within a few minutes of it going quiet. */
export const JOB_HEARTBEAT_INTERVAL_MS = 30_000;

/** A running row whose last heartbeat is older than this is not being worked
 *  on. Six intervals: a single slow write, a GC pause, or one dropped database
 *  connection must never be enough to accuse a live job of being dead. */
export const JOB_HEARTBEAT_STALE_AFTER_MS = 3 * 60_000;

export interface HeartbeatHandle {
  /** Stop beating. Safe to call more than once. */
  stop(): void;
}

/** The two writes this module can make. Declared separately from the parameter
 *  type because PrismaClient's generated `update` is far too specific to be
 *  described by a hand-written structural type — the client is accepted as
 *  `unknown` and narrowed here. */
interface JobLogWriter {
  jobLog: {
    updateMany?(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<unknown>;
    update(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<unknown>;
  };
}

export interface HeartbeatDeps {
  /** A Prisma client, or anything with a `jobLog.update`. */
  db: unknown;
  jobLogId: string;
  intervalMs?: number;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
  log?: (msg: string) => void;
}

/**
 * Start touching a running JobLog row until the returned handle is stopped.
 *
 * `updatedAt` is `@updatedAt` in the schema, so writing any field bumps it --
 * `status: "running"` is chosen because it is the field's existing value. The
 * write is therefore a no-op in content and a heartbeat in effect, and it can
 * never corrupt a row that some other path has meanwhile completed... except
 * that it would resurrect one, so `updateMany` with a status filter is used:
 * a row that is no longer "running" is not touched at all.
 *
 * A failed heartbeat is logged and swallowed. Losing the database briefly is
 * not a reason to abort an expensive job that is otherwise progressing.
 */
export function startJobLogHeartbeat(deps: HeartbeatDeps): HeartbeatHandle {
  const intervalMs = deps.intervalMs ?? JOB_HEARTBEAT_INTERVAL_MS;
  const setIntervalFn = deps.setIntervalFn ?? setInterval;
  const clearIntervalFn = deps.clearIntervalFn ?? clearInterval;
  const log = deps.log ?? ((m: string) => console.warn(m));
  const client = deps.db as JobLogWriter;

  const beat = async () => {
    try {
      if (typeof client.jobLog.updateMany === "function") {
        await client.jobLog.updateMany({
          where: { id: deps.jobLogId, status: "running" },
          data: { status: "running" },
        });
        return;
      }
      await client.jobLog.update({ where: { id: deps.jobLogId }, data: { status: "running" } });
    } catch (err) {
      log(`[JobHeartbeat] Could not touch job log ${deps.jobLogId}: ${(err as Error).message}`);
    }
  };

  const timer = setIntervalFn(() => void beat(), intervalMs);
  // Never hold the process open for a heartbeat.
  (timer as unknown as { unref?: () => void }).unref?.();

  let stopped = false;
  return {
    stop() {
      if (stopped) return;
      stopped = true;
      clearIntervalFn(timer as unknown as NodeJS.Timeout);
    },
  };
}

/** Has a running row gone quiet? Used by the admin table to label a counter
 *  that is climbing for the wrong reason. Rows written before heartbeats
 *  existed have `updatedAt === createdAt`; those are reported as unknown
 *  rather than stranded, because absence of a heartbeat is not evidence of
 *  death for a job that predates the feature. */
export function heartbeatState(
  row: { createdAt: Date; updatedAt?: Date | null },
  now: Date = new Date(),
  staleAfterMs: number = JOB_HEARTBEAT_STALE_AFTER_MS
): { kind: "alive" | "stale" | "unknown"; sinceMs: number } {
  const beat = row.updatedAt && row.updatedAt > row.createdAt ? row.updatedAt : null;
  if (!beat) {
    const age = now.getTime() - row.createdAt.getTime();
    // No beat yet is normal for the first interval of a brand new row.
    if (age <= staleAfterMs) return { kind: "alive", sinceMs: age };
    return { kind: "unknown", sinceMs: age };
  }
  const sinceMs = now.getTime() - beat.getTime();
  return { kind: sinceMs > staleAfterMs ? "stale" : "alive", sinceMs };
}
