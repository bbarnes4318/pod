-- One JobLog row per ENQUEUE, not per attempt.
--
-- Every worker handler created its JobLog row at the top of the handler, and
-- the background queue runs `attempts: 3`. A job that hit a provider rate limit
-- therefore wrote three "running" rows for one logical run, and the admin job
-- table counted attempts while an operator read it as runs. Between
-- 2026-08-21 and 2026-08-24 that inflated an already-fanned-out topic sweep
-- into 38 `generate:topics` rows and 139 `generate:research-brief` rows.
--
-- queueJobKey is `${bullmq job id}:${bullmq enqueue timestamp}`: stable across
-- the attempts of one enqueue, distinct across separate enqueues (a re-add of
-- the same deterministic jobId after `removeOnComplete` gets a new timestamp,
-- and is genuinely a new run). Handlers upsert on it, so attempt 2 updates the
-- row attempt 1 wrote.
--
-- Nullable because job logs written outside the queue — admin server actions,
-- services invoked directly — have no BullMQ job to key on. Postgres allows
-- many NULLs under a UNIQUE constraint, so those rows are unaffected.
ALTER TABLE "JobLog" ADD COLUMN "queueJobKey" TEXT;
ALTER TABLE "JobLog" ADD COLUMN "attempt" INTEGER NOT NULL DEFAULT 1;

CREATE UNIQUE INDEX "JobLog_queueJobKey_key" ON "JobLog"("queueJobKey");
