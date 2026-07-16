// Live research state per topic, derived from REAL job history.
//
// The research worker (queue/worker.ts handleResearchBriefGeneration) writes a
// JobLog row for every `generate:research-brief` run: status "running" when it
// picks the job up, then "completed" or "failed", with `input.topicId`
// identifying the topic. That row is the only durable record of a research
// attempt, so it is what we read here — no new column, no invented field.
//
// HONEST LIMITS (why "queued" is not returned):
// A job that has been enqueued but not yet picked up has NO JobLog row at all —
// it is indistinguishable, in the database, from a topic nobody ever researched.
// Reporting those as "research queued" would be a guess, so this returns only
// the two states the data can actually prove: in_progress and failed. The
// contract's `queued` code stays available for a caller that genuinely knows
// (e.g. one holding the enqueue result).

import { db } from "../db";
import type { ResearchState } from "./topicEligibility";

const RESEARCH_JOB_TYPE = "generate:research-brief";

/** The DB surface this reads — satisfied by PrismaClient and test doubles. */
export interface ResearchStateDb {
  jobLog: {
    findMany: (args: unknown) => Promise<Array<{ status: string; input: unknown; createdAt: Date | string }>>;
  };
}

/**
 * Map topicId → current research state, newest attempt wins.
 *
 * Bounded by `take` because JobLog is append-only and unbounded: we read a
 * recent window rather than the whole table. A topic whose last attempt fell
 * outside the window is reported as having no state — which is the truthful
 * answer, since we can no longer see its attempt.
 */
export async function getResearchStates(
  topicIds: string[],
  dbi: ResearchStateDb = db as unknown as ResearchStateDb,
  opts: { take?: number } = {}
): Promise<Map<string, ResearchState>> {
  const out = new Map<string, ResearchState>();
  const ids = new Set(topicIds);
  if (ids.size === 0) return out;

  const rows = await dbi.jobLog.findMany({
    where: { jobType: RESEARCH_JOB_TYPE },
    orderBy: { createdAt: "desc" },
    take: opts.take ?? 200,
    select: { status: true, input: true, createdAt: true },
  });

  for (const row of rows) {
    const topicId = (row.input as { topicId?: unknown } | null)?.topicId;
    if (typeof topicId !== "string" || !ids.has(topicId)) continue;
    // Newest first, so the first row seen for a topic is its latest attempt.
    if (out.has(topicId)) continue;

    if (row.status === "running") out.set(topicId, "in_progress");
    else if (row.status === "failed") out.set(topicId, "failed");
    // "completed" → no warning: the brief either exists (and the hard gates
    // judge it) or was deleted since, which the brief gates already report.
  }
  return out;
}
