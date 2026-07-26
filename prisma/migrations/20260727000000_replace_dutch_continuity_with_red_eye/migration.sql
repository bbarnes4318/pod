-- Replace the Dutch Mulkey recurring-bit continuity model with the Cal "Red Eye"
-- Mercer character-continuity model.
--
-- THREE PROPERTIES THIS MIGRATION MUST HAVE, and how each is achieved:
--
--   IDEMPOTENT      Every statement is IF EXISTS / IF NOT EXISTS guarded and the
--                   archive INSERT is ON CONFLICT DO NOTHING, so re-running it
--                   (a retried deploy, a re-applied shadow database) is a no-op.
--
--   NON-DESTRUCTIVE The retired columns are COPIED into an archive table before
--                   they are dropped, and each episode's retired continuity
--                   claim is MOVED to "legacyContinuityUpdate" rather than
--                   deleted. A rollback restores state instead of losing it.
--
--   LEAK-PROOF      The retired columns are actually DROPPED and the retired
--                   claims are actually CLEARED from "continuityUpdate". A
--                   dormant column is one schema edit away from reaching a
--                   prompt; an archived one is not. This is the whole reason the
--                   columns are not simply left in place and ignored.
--
-- No unrelated podcast data is touched. Podcast, Episode identity, cast, audio,
-- and every other continuity-adjacent table are untouched by this migration.

-- ---------------------------------------------------------------------------
-- 1. Archive the retired ShowContinuity columns.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "ShowContinuityLegacyDutch" (
    "podcastId"             TEXT NOT NULL,
    "episodeCount"          INTEGER NOT NULL DEFAULT 0,
    "phantomFansTotal"      INTEGER NOT NULL DEFAULT 0,
    "lastAttendanceClaim"   INTEGER,
    "lastAttendanceReal"    INTEGER,
    "weCount"               INTEGER NOT NULL DEFAULT 0,
    "weCountThisEpisode"    INTEGER NOT NULL DEFAULT 0,
    "currentDodge"          TEXT,
    "hoytStage"             INTEGER NOT NULL DEFAULT 0,
    "hoytFactsEstablished"  TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "arcBeat"               INTEGER NOT NULL DEFAULT 0,
    "badgeStage"            INTEGER NOT NULL DEFAULT 0,
    "wolverinesInvoked"     TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "lastWolverineUsed"     TEXT,
    "nuclearOptionFirings"  INTEGER[] NOT NULL DEFAULT ARRAY[]::INTEGER[],
    "coldOpenFullRuns"      INTEGER[] NOT NULL DEFAULT ARRAY[]::INTEGER[],
    "uncorrectedLedgerRuns" INTEGER[] NOT NULL DEFAULT ARRAY[]::INTEGER[],
    "wagerTerms"            TEXT,
    "wagerLeader"           TEXT,
    "wagerPot"              INTEGER NOT NULL DEFAULT 0,
    "archivedAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ShowContinuityLegacyDutch_pkey" PRIMARY KEY ("podcastId")
);

-- Copy, only if the source columns still exist (i.e. first run). Wrapped in a
-- DO block with dynamic SQL because a plain INSERT ... SELECT referencing a
-- dropped column fails to PARSE on the second run, guard or no guard.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'ShowContinuity' AND column_name = 'phantomFansTotal'
  ) THEN
    EXECUTE '
      INSERT INTO "ShowContinuityLegacyDutch" (
        "podcastId", "episodeCount", "phantomFansTotal", "lastAttendanceClaim",
        "lastAttendanceReal", "weCount", "weCountThisEpisode", "currentDodge",
        "hoytStage", "hoytFactsEstablished", "arcBeat", "badgeStage",
        "wolverinesInvoked", "lastWolverineUsed", "nuclearOptionFirings",
        "coldOpenFullRuns", "uncorrectedLedgerRuns", "wagerTerms", "wagerLeader", "wagerPot"
      )
      SELECT
        "podcastId", "episodeCount", "phantomFansTotal", "lastAttendanceClaim",
        "lastAttendanceReal", "weCount", "weCountThisEpisode", "currentDodge",
        "hoytStage", "hoytFactsEstablished", "arcBeat", "badgeStage",
        "wolverinesInvoked", "lastWolverineUsed", "nuclearOptionFirings",
        "coldOpenFullRuns", "uncorrectedLedgerRuns", "wagerTerms", "wagerLeader", "wagerPot"
      FROM "ShowContinuity"
      ON CONFLICT ("podcastId") DO NOTHING';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2. Drop the retired columns. Nothing may read them again.
-- ---------------------------------------------------------------------------

ALTER TABLE "ShowContinuity" DROP COLUMN IF EXISTS "phantomFansTotal";
ALTER TABLE "ShowContinuity" DROP COLUMN IF EXISTS "lastAttendanceClaim";
ALTER TABLE "ShowContinuity" DROP COLUMN IF EXISTS "lastAttendanceReal";
ALTER TABLE "ShowContinuity" DROP COLUMN IF EXISTS "weCount";
ALTER TABLE "ShowContinuity" DROP COLUMN IF EXISTS "weCountThisEpisode";
ALTER TABLE "ShowContinuity" DROP COLUMN IF EXISTS "currentDodge";
ALTER TABLE "ShowContinuity" DROP COLUMN IF EXISTS "hoytStage";
ALTER TABLE "ShowContinuity" DROP COLUMN IF EXISTS "hoytFactsEstablished";
ALTER TABLE "ShowContinuity" DROP COLUMN IF EXISTS "arcBeat";
ALTER TABLE "ShowContinuity" DROP COLUMN IF EXISTS "badgeStage";
ALTER TABLE "ShowContinuity" DROP COLUMN IF EXISTS "wolverinesInvoked";
ALTER TABLE "ShowContinuity" DROP COLUMN IF EXISTS "lastWolverineUsed";
ALTER TABLE "ShowContinuity" DROP COLUMN IF EXISTS "nuclearOptionFirings";
ALTER TABLE "ShowContinuity" DROP COLUMN IF EXISTS "coldOpenFullRuns";
ALTER TABLE "ShowContinuity" DROP COLUMN IF EXISTS "uncorrectedLedgerRuns";
ALTER TABLE "ShowContinuity" DROP COLUMN IF EXISTS "wagerTerms";
ALTER TABLE "ShowContinuity" DROP COLUMN IF EXISTS "wagerLeader";
ALTER TABLE "ShowContinuity" DROP COLUMN IF EXISTS "wagerPot";

-- ---------------------------------------------------------------------------
-- 3. Add the Cal Mercer continuity columns.
--
-- Every one carries a default, so existing rows become a valid, EMPTY new state
-- rather than a reinterpretation of the old one. Deliberately no backfill maps
-- an attendance counter or a Hoyt stage onto anything here: those measured a
-- different character's running gags and any mapping would be a fabrication.
-- ---------------------------------------------------------------------------

ALTER TABLE "ShowContinuity" ADD COLUMN IF NOT EXISTS "redEyeStage" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "ShowContinuity" ADD COLUMN IF NOT EXISTS "redEyeDisclosures" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "ShowContinuity" ADD COLUMN IF NOT EXISTS "redEyeFirings" INTEGER[] NOT NULL DEFAULT ARRAY[]::INTEGER[];
ALTER TABLE "ShowContinuity" ADD COLUMN IF NOT EXISTS "languageLedger" JSONB NOT NULL DEFAULT '[]'::JSONB;
ALTER TABLE "ShowContinuity" ADD COLUMN IF NOT EXISTS "languageRecallFirings" INTEGER[] NOT NULL DEFAULT ARRAY[]::INTEGER[];
ALTER TABLE "ShowContinuity" ADD COLUMN IF NOT EXISTS "positionMemory" JSONB NOT NULL DEFAULT '[]'::JSONB;
ALTER TABLE "ShowContinuity" ADD COLUMN IF NOT EXISTS "positionCallbackFirings" INTEGER[] NOT NULL DEFAULT ARRAY[]::INTEGER[];
ALTER TABLE "ShowContinuity" ADD COLUMN IF NOT EXISTS "trustLevel" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "ShowContinuity" ADD COLUMN IF NOT EXISTS "calDisclosureCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "ShowContinuity" ADD COLUMN IF NOT EXISTS "calRationalizationCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "ShowContinuity" ADD COLUMN IF NOT EXISTS "zabalaOverreachCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "ShowContinuity" ADD COLUMN IF NOT EXISTS "positionChangeCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "ShowContinuity" ADD COLUMN IF NOT EXISTS "openThread" TEXT;

-- The episodeCount carried over is a HONEST count of episodes this show has
-- produced, and every rolling window is measured against it. It is the one
-- retired column that means the same thing under the new engine, so it stays.

-- ---------------------------------------------------------------------------
-- 4. Quarantine the retired per-episode continuity claims.
--
-- Old claims are in the retired ContinuityUpdate shape. The new schema is
-- strict, so leaving them in "continuityUpdate" would make every fold log a
-- validation warning for every historical episode — forever — and would keep
-- retired running-bit state one schema edit away from a prompt.
-- ---------------------------------------------------------------------------

ALTER TABLE "Episode" ADD COLUMN IF NOT EXISTS "legacyContinuityUpdate" JSONB;

-- A retired claim is identified structurally, by a key only the old shape had.
-- New-shape claims are never touched, which is what makes this safe to re-run.
UPDATE "Episode"
SET "legacyContinuityUpdate" = "continuityUpdate",
    "continuityUpdate" = NULL
WHERE "continuityUpdate" IS NOT NULL
  AND "legacyContinuityUpdate" IS NULL
  AND (
    "continuityUpdate" ? 'attendanceClaimed'
    OR "continuityUpdate" ? 'weSaidCount'
    OR "continuityUpdate" ? 'hoytBeatDelivered'
    OR "continuityUpdate" ? 'wolverineUsed'
    OR "continuityUpdate" ? 'unityBeatPresent'
    OR "continuityUpdate" ? 'endedOnDodge'
  );
