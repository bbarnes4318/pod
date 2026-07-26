-- Persistent per-show continuity state (one row per Podcast).
--
-- ADDITIVE and NON-DESTRUCTIVE: a new table plus one nullable back-reference.
-- No existing column is touched. A podcast with no row behaves exactly as it
-- does today — the generator treats a missing row as "no continuity yet" and
-- lazily creates one, so this migration needs no backfill.
--
-- There is deliberately NO season column. Rate-limited runners are stored as
-- the LIST OF EPISODE INDICES where they fired, not as counts, so a rolling
-- window enforces scarcity without a boundary and without a reset job.

CREATE TABLE IF NOT EXISTS "ShowContinuity" (
    "id" TEXT NOT NULL,
    "podcastId" TEXT NOT NULL,

    -- COUNTER: the index every rolling window below is measured against.
    "episodeCount" INTEGER NOT NULL DEFAULT 0,

    -- The Attendance Ledger.
    "phantomFansTotal" INTEGER NOT NULL DEFAULT 0,
    "lastAttendanceClaim" INTEGER,
    "lastAttendanceReal" INTEGER,

    -- The Pronoun Hunt.
    "weCount" INTEGER NOT NULL DEFAULT 0,
    "weCountThisEpisode" INTEGER NOT NULL DEFAULT 0,
    "currentDodge" TEXT,

    -- The Duane Hoyt arc (LADDER — terminates, never wraps).
    "hoytStage" INTEGER NOT NULL DEFAULT 0,
    "hoytFactsEstablished" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],

    -- Season arc + the badge (LADDERS).
    "arcBeat" INTEGER NOT NULL DEFAULT 0,
    "badgeStage" INTEGER NOT NULL DEFAULT 0,

    -- Wolverines bank (ROTATION — full history, windowed recency check).
    "wolverinesInvoked" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "lastWolverineUsed" TEXT,

    -- RATE LIMITS: episode indices where each fired, newest last.
    "nuclearOptionFirings" INTEGER[] NOT NULL DEFAULT ARRAY[]::INTEGER[],
    "coldOpenFullRuns" INTEGER[] NOT NULL DEFAULT ARRAY[]::INTEGER[],
    "uncorrectedLedgerRuns" INTEGER[] NOT NULL DEFAULT ARRAY[]::INTEGER[],

    -- The Standing Wager.
    "wagerTerms" TEXT,
    "wagerLeader" TEXT,
    "wagerPot" INTEGER NOT NULL DEFAULT 0,

    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShowContinuity_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ShowContinuity_podcastId_key" ON "ShowContinuity"("podcastId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ShowContinuity_podcastId_fkey'
  ) THEN
    ALTER TABLE "ShowContinuity"
      ADD CONSTRAINT "ShowContinuity_podcastId_fkey"
      FOREIGN KEY ("podcastId") REFERENCES "Podcast"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
