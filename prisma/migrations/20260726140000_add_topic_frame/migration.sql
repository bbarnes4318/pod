-- Durable betting-frame classification on each topic candidate.
--
-- Stored rather than computed at display time, because the quota is enforced at
-- GENERATION: a display-time filter would keep producing betting topics and
-- merely hide them, and "at most one per rolling 30 days" has to be answerable
-- with a query over what was actually created.
--
-- Defaults to 'human' so existing rows keep working; the backfill script
-- (src/scripts/backfillTopicFrame.ts) reclassifies them from their real text.

ALTER TABLE "TopicCandidate" ADD COLUMN "frame" TEXT NOT NULL DEFAULT 'human';
ALTER TABLE "TopicCandidate" ADD COLUMN "frameScore" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "TopicCandidate" ADD COLUMN "frameSignals" JSONB;

CREATE INDEX "TopicCandidate_frame_createdAt_idx" ON "TopicCandidate"("frame", "createdAt");
