-- Prompt 6 (PR 2): Podcast sound profiles, normalized assignments, render
-- versions, and owner/podcast-scoped cue usage.
--
-- ADDITIVE and NON-DESTRUCTIVE. Backfill notes:
--   * SoundCueUsage.ownerId/podcastId are copied from the usage row's Episode
--     (the only evidence that exists); rows with no episode stay honest NULLs.
--   * selectionSource stays at its 'legacy' default for pre-existing rows: we
--     cannot know retroactively whether the planner or the legacy path picked
--     an asset, so we do not pretend to.
--   * No remote fetch, no ffprobe, no hashing here.
-- ASCII only (WIN1252 deployment-contract rule).

-- AlterTable
ALTER TABLE "PodcastProductionConfig" ADD COLUMN     "cooldownScope" TEXT NOT NULL DEFAULT 'podcast',
ADD COLUMN     "defaultIntroEnabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "defaultOutroEnabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "reactionCooldownEpisodes" INTEGER,
ADD COLUMN     "soundProfileMode" TEXT NOT NULL DEFAULT 'system_default',
ADD COLUMN     "stingerCooldownEpisodes" INTEGER,
ADD COLUMN     "targetLoudnessLufs" DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "SoundCueUsage" ADD COLUMN     "assetContentHash" TEXT,
ADD COLUMN     "assetKind" TEXT,
ADD COLUMN     "assetScope" TEXT,
ADD COLUMN     "fadeInMs" INTEGER,
ADD COLUMN     "fadeOutMs" INTEGER,
ADD COLUMN     "gainDb" DOUBLE PRECISION,
ADD COLUMN     "lineIndex" INTEGER,
ADD COLUMN     "orderIndex" INTEGER,
ADD COLUMN     "ownerId" TEXT,
ADD COLUMN     "podcastId" TEXT,
ADD COLUMN     "renderId" TEXT,
ADD COLUMN     "selectionSource" TEXT NOT NULL DEFAULT 'legacy',
ADD COLUMN     "timelinePositionMs" INTEGER;

-- CreateTable
CREATE TABLE "PodcastSoundAssignment" (
    "id" TEXT NOT NULL,
    "productionConfigId" TEXT NOT NULL,
    "podcastId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "orderIndex" INTEGER NOT NULL DEFAULT 0,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "gainDb" DOUBLE PRECISION,
    "fadeInMs" INTEGER,
    "fadeOutMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PodcastSoundAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EpisodeAudioRender" (
    "id" TEXT NOT NULL,
    "episodeId" TEXT NOT NULL,
    "scriptId" TEXT,
    "renderVersion" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "renderMode" TEXT NOT NULL,
    "plannerSeed" INTEGER,
    "productionStyle" TEXT,
    "sfxDensity" TEXT,
    "targetLoudnessLufs" DOUBLE PRECISION,
    "configurationFingerprint" TEXT,
    "plan" JSONB,
    "outputAudioUrl" TEXT,
    "failureReason" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EpisodeAudioRender_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PodcastSoundAssignment_podcastId_role_idx" ON "PodcastSoundAssignment"("podcastId", "role");

-- CreateIndex
CREATE INDEX "PodcastSoundAssignment_assetId_idx" ON "PodcastSoundAssignment"("assetId");

-- CreateIndex
CREATE UNIQUE INDEX "PodcastSoundAssignment_podcastId_role_assetId_key" ON "PodcastSoundAssignment"("podcastId", "role", "assetId");

-- CreateIndex
CREATE INDEX "EpisodeAudioRender_episodeId_idx" ON "EpisodeAudioRender"("episodeId");

-- CreateIndex
CREATE INDEX "EpisodeAudioRender_status_idx" ON "EpisodeAudioRender"("status");

-- CreateIndex
CREATE UNIQUE INDEX "EpisodeAudioRender_episodeId_renderVersion_key" ON "EpisodeAudioRender"("episodeId", "renderVersion");

-- CreateIndex
CREATE INDEX "SoundCueUsage_podcastId_usedAt_idx" ON "SoundCueUsage"("podcastId", "usedAt");

-- CreateIndex
CREATE INDEX "SoundCueUsage_ownerId_usedAt_idx" ON "SoundCueUsage"("ownerId", "usedAt");

-- CreateIndex
CREATE INDEX "SoundCueUsage_renderId_idx" ON "SoundCueUsage"("renderId");

-- AddForeignKey
ALTER TABLE "PodcastSoundAssignment" ADD CONSTRAINT "PodcastSoundAssignment_productionConfigId_fkey" FOREIGN KEY ("productionConfigId") REFERENCES "PodcastProductionConfig"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PodcastSoundAssignment" ADD CONSTRAINT "PodcastSoundAssignment_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "AudioAsset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EpisodeAudioRender" ADD CONSTRAINT "EpisodeAudioRender_episodeId_fkey" FOREIGN KEY ("episodeId") REFERENCES "Episode"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SoundCueUsage" ADD CONSTRAINT "SoundCueUsage_renderId_fkey" FOREIGN KEY ("renderId") REFERENCES "EpisodeAudioRender"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Singleton roles: at most ONE ENABLED intro/outro/bed assignment per Podcast
-- (pool roles stinger/reaction are exempt; deduped by the composite unique).
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX "PodcastSoundAssignment_singleton_role_key"
  ON "PodcastSoundAssignment" ("podcastId", "role")
  WHERE "enabled" = true AND "role" IN ('intro', 'outro', 'bed');

-- Role vocabulary guard.
ALTER TABLE "PodcastSoundAssignment" ADD CONSTRAINT "PodcastSoundAssignment_role_chk"
  CHECK ("role" IN ('intro', 'outro', 'bed', 'stinger', 'reaction'));

-- ---------------------------------------------------------------------------
-- Backfill: scope existing cue usage to its episode's owner/podcast.
-- ---------------------------------------------------------------------------
UPDATE "SoundCueUsage" u
SET "ownerId" = e."ownerId", "podcastId" = e."podcastId"
FROM "Episode" e
WHERE u."episodeId" = e."id" AND u."ownerId" IS NULL AND u."podcastId" IS NULL;
