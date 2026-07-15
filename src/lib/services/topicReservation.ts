// Concurrency-safe recent-use reservation for the `exclude_podcast` reuse
// policy.
//
// The plain check-then-create flow has a TOCTOU race: two episode builds for
// the same podcast + topic can BOTH pass the "recently used?" check before
// either commits, so both consume the topic. This helper closes that window
// with PostgreSQL transaction-scoped ADVISORY LOCKS: it must run INSIDE the
// same transaction that writes the Episode + EpisodeTopic rows, so the lock is
// held until commit and the second builder blocks, then re-reads the first
// builder's now-committed usage and backs off.

/** The tiny transaction surface this helper needs. Prisma's interactive `tx`
 *  satisfies it; a raw `pg` client is easily adapted in tests. */
export interface AdvisoryLockTx {
  $queryRawUnsafe: <T = unknown>(query: string, ...values: unknown[]) => Promise<T>;
}

/** True when the given transaction client can take advisory locks. The
 *  in-memory test doubles used by the unit suites cannot, so callers skip the
 *  lock there (unit tests don't exercise concurrency; the real-Postgres
 *  concurrency test does). */
export function supportsAdvisoryLocks(tx: unknown): tx is AdvisoryLockTx {
  return !!tx && typeof (tx as { $queryRawUnsafe?: unknown }).$queryRawUnsafe === "function";
}

export interface ReserveOptions {
  podcastId: string;
  topicIds: string[];
  cooldownDays: number;
}

/**
 * Acquire a transaction-scoped advisory lock per (podcast, topic) pair — in
 * DETERMINISTIC sorted order to avoid deadlocks between overlapping builds —
 * then re-query committed `EpisodeTopic` usage for the podcast within the
 * cooldown. Returns the set of topic ids that are recently used AS SEEN AFTER
 * THE LOCK (i.e. after any concurrent builder for the same pair has committed).
 *
 * Locks are keyed by `podcastId:topicId`, so two DIFFERENT podcasts never block
 * each other. Locks release automatically at COMMIT/ROLLBACK.
 */
export async function reserveRecentlyUsedTopics(
  tx: AdvisoryLockTx,
  opts: ReserveOptions
): Promise<Set<string>> {
  const uniq = [...new Set(opts.topicIds)];
  if (uniq.length === 0) return new Set();
  const sorted = [...uniq].sort();

  for (const topicId of sorted) {
    // Transaction-scoped, auto-released at commit/rollback. hashtextextended
    // maps the composite key to the bigint pg_advisory_xact_lock expects.
    await tx.$queryRawUnsafe(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      `${opts.podcastId}:${topicId}`
    );
  }

  const cutoff = new Date(Date.now() - opts.cooldownDays * 24 * 60 * 60 * 1000);
  const rows = await tx.$queryRawUnsafe<Array<{ topicId: string }>>(
    `SELECT DISTINCT et."topicId" AS "topicId"
       FROM "EpisodeTopic" et
       JOIN "Episode" e ON e."id" = et."episodeId"
      WHERE e."podcastId" = $1
        AND et."selectedAt" >= $2`,
    opts.podcastId,
    cutoff
  );
  const recent = new Set(rows.map((r) => r.topicId));
  return new Set(sorted.filter((id) => recent.has(id)));
}
