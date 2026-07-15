-- Topic lifecycle decoupling + immutable episode-topic snapshots.
--
-- SAFETY: additive + in-place update only. No TopicCandidate, ResearchBrief,
-- Episode, EpisodeTopic, or Script row is ever deleted. Statements are guarded
-- (IF NOT EXISTS / WHERE-guarded / duplicate_object catch) so a partial re-run
-- is safe. Rollback + deployment notes are in the migration safety report.

-- =========================================================================
-- 1) Editorial-status enum (item 6). Convert legacy "used" BEFORE enforcing,
--    then FAIL LOUDLY on any value outside the editorial set (never coerce).
-- =========================================================================
-- Cast to text so this is safe to re-run after the column is already the enum
-- (an enum column compared to 'used' would otherwise raise).
UPDATE "TopicCandidate" SET "status" = 'approved' WHERE "status"::text = 'used';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "TopicCandidate"
    WHERE "status"::text NOT IN ('pending', 'approved', 'rejected', 'archived')
  ) THEN
    RAISE EXCEPTION 'Aborting migration: TopicCandidate.status has unexpected value(s): %',
      (SELECT string_agg(DISTINCT "status"::text, ', ')
         FROM "TopicCandidate"
        WHERE "status"::text NOT IN ('pending', 'approved', 'rejected', 'archived'));
  END IF;
END $$;

DO $$
BEGIN
  CREATE TYPE "TopicEditorialStatus" AS ENUM ('pending', 'approved', 'rejected', 'archived');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "TopicCandidate"
  ALTER COLUMN "status" TYPE "TopicEditorialStatus"
  USING "status"::"TopicEditorialStatus";

-- =========================================================================
-- 2) EpisodeTopic: immutable snapshot + accurate historical selectedAt (item 5).
-- =========================================================================
ALTER TABLE "EpisodeTopic" ADD COLUMN IF NOT EXISTS "snapshot" JSONB;
-- selectedAt is added NULLABLE so we can backfill a historical APPROXIMATION
-- rather than stamping every legacy row at migration time.
ALTER TABLE "EpisodeTopic" ADD COLUMN IF NOT EXISTS "selectedAt" TIMESTAMP(3);

-- Backfill selectedAt: best historical approximation — the Episode's createdAt,
-- else the TopicCandidate's createdAt, else migration time.
UPDATE "EpisodeTopic" et
SET "selectedAt" = COALESCE(e."createdAt", tc."createdAt", CURRENT_TIMESTAMP)
FROM "Episode" e, "TopicCandidate" tc
WHERE et."episodeId" = e."id" AND et."topicId" = tc."id" AND et."selectedAt" IS NULL;
-- Any row still null (no matching episode/topic — shouldn't happen under FKs).
UPDATE "EpisodeTopic" SET "selectedAt" = CURRENT_TIMESTAMP WHERE "selectedAt" IS NULL;

-- Backfill snapshots from CURRENT related data (only history available) using
-- the CORRECTED selectedAt for selectionTimestamp. Only fills NULLs, so a
-- re-run never clobbers a snapshot written at creation time.
UPDATE "EpisodeTopic" et
SET "snapshot" = jsonb_build_object(
  'version', 1,
  'source', 'backfill',
  'title', tc."title",
  'summary', tc."summary",
  'sport', tc."sport",
  'leagueId', tc."leagueId",
  'evidenceIds', COALESCE(tc."evidenceIds", '[]'::jsonb),
  'facts', COALESCE(rb."facts", '[]'::jsonb),
  'sourceIds', COALESCE(rb."sourceIds", '[]'::jsonb),
  'stats', rb."stats",
  'mainAngle', rb."mainAngle",
  'contrarianAngle', rb."contrarianAngle",
  'argumentForHostA', rb."argumentForHostA",
  'argumentForHostB', rb."argumentForHostB",
  'counterArguments', rb."counterArguments",
  'unsafeClaims', rb."unsafeClaims",
  'onAirTalkingPoints', rb."onAirTalkingPoints",
  'whyMattersNow', rb."whyMattersNow",
  'keyFactsContext', rb."keyFactsContext",
  'debateScore', tc."debateScore",
  'strongestDebateQuestion', rb."strongestDebateQuestion",
  'suggestedHostTake', rb."suggestedHostTake",
  'injuryContext', rb."injuryContext",
  'oddsContext', rb."oddsContext",
  'topicCreatedAt', to_char(tc."createdAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'selectionTimestamp', to_char(et."selectedAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'talkability', NULL,
  'evidenceFingerprint', md5(COALESCE(rb."facts"::text, '') || '|' || COALESCE(rb."sourceIds"::text, '') || '|' || COALESCE(tc."evidenceIds"::text, '')),
  'fingerprintAlgo', 'md5'
)
FROM "TopicCandidate" tc
LEFT JOIN "ResearchBrief" rb ON rb."topicId" = tc."id"
WHERE et."topicId" = tc."id" AND et."snapshot" IS NULL;

-- Enforce NOT NULL + default + index AFTER the backfill.
ALTER TABLE "EpisodeTopic" ALTER COLUMN "selectedAt" SET NOT NULL;
ALTER TABLE "EpisodeTopic" ALTER COLUMN "selectedAt" SET DEFAULT CURRENT_TIMESTAMP;
CREATE INDEX IF NOT EXISTS "EpisodeTopic_selectedAt_idx" ON "EpisodeTopic"("selectedAt");
