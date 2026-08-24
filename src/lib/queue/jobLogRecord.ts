import type { Job } from "bullmq";
import type { Prisma } from "@prisma/client";
import { db } from "../db";
import { jobAttempt, queueJobKey } from "./queueJobIdentity";

/**
 * JobLog bookkeeping for queue handlers.
 *
 * Every handler used to open with `db.jobLog.create(...)`, and the background
 * queue runs `attempts: 3` (see podcastQueue.ts). One rate-limited job then
 * wrote three rows, so the admin job table reported attempts while an operator
 * counting it read runs. That is a large part of why a topic sweep that fans
 * out per league looked like dozens of independent sweeps.
 *
 * `beginJobLog` keys the row on the enqueue rather than the attempt, so a retry
 * reuses the row it already has.
 */

export interface JobLogRow {
  id: string;
}

/**
 * What a handler passes as the job's recorded input.
 *
 * The queue's payload interfaces (TopicGenJobData and friends) are plain
 * JSON-shaped objects but have no index signature, so they do not structurally
 * satisfy Prisma.InputJsonValue. Accepting the object and narrowing once here
 * keeps the cast in one place instead of an `as any` at all fourteen call
 * sites.
 */
export type JobLogInput = Prisma.InputJsonValue | object;

/**
 * Open (or re-open) the JobLog row for this job and mark it running.
 *
 * First attempt inserts; a retry updates the same row — clearing the previous
 * attempt's error so the table shows the live state, and recording which
 * attempt is running so a retried job is still visibly a retry.
 */
export async function beginJobLog(
  job: Pick<Job, "id" | "timestamp" | "attemptsMade"> | undefined | null,
  jobType: string,
  input: JobLogInput
): Promise<JobLogRow> {
  const key = queueJobKey(job);
  const attempt = jobAttempt(job);
  const empty: Prisma.InputJsonValue = {};
  const json = input as Prisma.InputJsonValue;
  const data = { jobType, status: "running", input: json, output: empty, attempt };

  if (!key) {
    return db.jobLog.create({ data, select: { id: true } });
  }

  return db.jobLog.upsert({
    where: { queueJobKey: key },
    create: { queueJobKey: key, ...data },
    // A retry re-opens the row its earlier attempt wrote: clear the stale
    // error so the table shows the live state, and record which attempt this
    // is so the retry stays visible now that it no longer gets its own row.
    update: { status: "running", error: null, output: empty, input: json, attempt },
    select: { id: true },
  });
}

export { jobAttempt, queueJobKey } from "./queueJobIdentity";
