-- Topic lifecycle decoupling + immutable episode-topic snapshots.
--
-- SAFETY: additive + in-place update only. No TopicCandidate, ResearchBrief,
-- Episode, EpisodeTopic, or Script row is ever deleted. Every statement is
-- idempotent-friendly (IF NOT EXISTS / WHERE-guarded), so a partial re-run is
-- safe. Rollback notes are in the migration safety report.

-- 1) EpisodeTopic gains an immutable snapshot + selection timestamp.
ALTER TABLE "EpisodeTopic" ADD COLUMN IF NOT EXISTS "snapshot" JSONB;
ALTER TABLE "EpisodeTopic" ADD COLUMN IF NOT EXISTS "selectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
CREATE INDEX IF NOT EXISTS "EpisodeTopic_selectedAt_idx" ON "EpisodeTopic"("selectedAt");

-- 2) Editorial-readiness lifecycle: "used" was a global usage flag and is now
-- derived from EpisodeTopic. Convert every legacy "used" topic back to the
-- editorial state it actually holds ("approved" — it passed approval to be
-- built from). History is untouched: the EpisodeTopic joins that recorded the
-- usage remain.
UPDATE "TopicCandidate" SET "status" = 'approved' WHERE "status" = 'used';

-- 3) Backfill snapshots for existing EpisodeTopic rows from CURRENT related
-- data (the only history available). Only fills NULLs, so re-running is safe
-- and never clobbers a snapshot written at creation time.
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
  'evidenceFingerprint', md5(COALESCE(rb."facts"::text, '') || '|' || COALESCE(rb."sourceIds"::text, '') || '|' || COALESCE(tc."evidenceIds"::text, '')),
  'selectionTimestamp', to_char(et."selectedAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
  'backfilledAt', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
)
FROM "TopicCandidate" tc
LEFT JOIN "ResearchBrief" rb ON rb."topicId" = tc."id"
WHERE et."topicId" = tc."id" AND et."snapshot" IS NULL;
