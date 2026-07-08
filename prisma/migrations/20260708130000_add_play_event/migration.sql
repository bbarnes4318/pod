-- Additive: IAB-style analytics events. No existing table/column touched.
-- Privacy-first: clientHash is a truncated salted hash of (ip + user-agent) used
-- only for dedup — no raw IP or PII is stored. The UNIQUE index enforces IAB
-- dedup (one counted event per client / episode / UTC-day / kind).
CREATE TABLE IF NOT EXISTS "PlayEvent" (
    "id" TEXT NOT NULL,
    "episodeId" TEXT NOT NULL,
    "ownerId" TEXT,
    "kind" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "clientHash" TEXT NOT NULL,
    "country" TEXT,
    "appBucket" TEXT,
    "dayBucket" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PlayEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "PlayEvent_episodeId_clientHash_dayBucket_kind_key"
    ON "PlayEvent"("episodeId", "clientHash", "dayBucket", "kind");
CREATE INDEX IF NOT EXISTS "PlayEvent_ownerId_at_idx" ON "PlayEvent"("ownerId", "at");
CREATE INDEX IF NOT EXISTS "PlayEvent_episodeId_kind_idx" ON "PlayEvent"("episodeId", "kind");

DO $$ BEGIN
  ALTER TABLE "PlayEvent" ADD CONSTRAINT "PlayEvent_episodeId_fkey"
    FOREIGN KEY ("episodeId") REFERENCES "Episode"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
