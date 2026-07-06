-- Cross-episode sound-cue usage ledger: the production planner's
-- anti-repetition cooldown store. Purely additive — nothing existing changes.
-- IF NOT EXISTS keeps it idempotent for local dbs using `prisma db push`.

CREATE TABLE IF NOT EXISTS "SoundCueUsage" (
    "id" TEXT NOT NULL,
    "episodeId" TEXT NOT NULL,
    "scriptId" TEXT,
    "assetId" TEXT NOT NULL,
    "assetName" TEXT,
    "cueType" TEXT NOT NULL,
    "usedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SoundCueUsage_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "SoundCueUsage_assetId_usedAt_idx" ON "SoundCueUsage"("assetId", "usedAt");
CREATE INDEX IF NOT EXISTS "SoundCueUsage_episodeId_idx" ON "SoundCueUsage"("episodeId");
CREATE INDEX IF NOT EXISTS "SoundCueUsage_usedAt_idx" ON "SoundCueUsage"("usedAt");
