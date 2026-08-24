import type { Job } from "bullmq";

/**
 * Pure identity helpers for a BullMQ job — no db, no redis, no env, so a test
 * can import them without standing up a connection.
 *
 * They exist because JobLog rows were written per ATTEMPT. The background queue
 * runs `attempts: 3` (podcastQueue.ts), so one rate-limited job wrote three
 * "running" rows and the admin job table reported attempts to an operator
 * reading runs.
 */

/**
 * Identity of ONE enqueue of a job, shared by all of its attempts.
 *
 * `job.id` alone is not enough: the schedulers use deterministic ids, and
 * `removeOnComplete: true` deletes the finished job, so the same id can be
 * added again later — a genuinely new run that deserves its own row. The
 * enqueue timestamp is fixed for the life of one job (retries do not change
 * it) and differs across re-adds, so the pair separates the two cases.
 *
 * Returns null when there is no BullMQ job to key on, in which case the caller
 * falls back to an unkeyed row.
 */
export function queueJobKey(job?: Pick<Job, "id" | "timestamp"> | null): string | null {
  const id = job?.id;
  if (id === undefined || id === null || id === "") return null;
  const ts = typeof job?.timestamp === "number" && Number.isFinite(job.timestamp) ? job.timestamp : 0;
  return `${id}:${ts}`;
}

/** 1-based attempt number for the run about to start. */
export function jobAttempt(job?: Pick<Job, "attemptsMade"> | null): number {
  const made = job?.attemptsMade;
  return (typeof made === "number" && Number.isFinite(made) && made >= 0 ? made : 0) + 1;
}
