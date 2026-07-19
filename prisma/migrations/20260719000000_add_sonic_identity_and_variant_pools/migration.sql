-- PR 2: podcast SONIC IDENTITY + VARIANT POOLS + asset CUE METADATA.
--
-- ADDITIVE, forward-only, non-destructive. Existing rows receive safe
-- documented defaults so every existing podcast keeps its current sound
-- behavior (weight 1 = equal selection, no format restriction, no identity
-- prohibitions, unclassified asset metadata). No column is dropped, no row is
-- rewritten, no historical migration is touched.
--
-- The ONE relaxation is intentional and central to this PR: the old
-- "one ENABLED intro/outro/bed per podcast" singleton unique index is dropped
-- so a show can hold a POOL of intro/outro/bed VARIANTS and rotate among a
-- coherent brand family. Dropping an index removes a constraint; it destroys no
-- data. Every existing single-intro/outro/bed podcast remains valid.
--
-- Idempotent (IF NOT EXISTS + duplicate-safe constraint adds) so it is safe on
-- `prisma db push` and re-application. ASCII only (WIN1252 deployment-contract
-- rule). No fetches, no ffprobe.

-- ---------------------------------------------------------------------------
-- 1. PodcastProductionConfig: the versioned sonic identity (validated JSON).
-- ---------------------------------------------------------------------------
ALTER TABLE "PodcastProductionConfig" ADD COLUMN IF NOT EXISTS "sonicIdentity" JSONB;

-- ---------------------------------------------------------------------------
-- 2. PodcastSoundAssignment: variant-pool metadata.
-- ---------------------------------------------------------------------------
ALTER TABLE "PodcastSoundAssignment" ADD COLUMN IF NOT EXISTS "cueFamily" TEXT;
ALTER TABLE "PodcastSoundAssignment" ADD COLUMN IF NOT EXISTS "weight" DOUBLE PRECISION NOT NULL DEFAULT 1;
ALTER TABLE "PodcastSoundAssignment" ADD COLUMN IF NOT EXISTS "isBrandedMotif" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "PodcastSoundAssignment" ADD COLUMN IF NOT EXISTS "maxUsesPerEpisode" INTEGER;
ALTER TABLE "PodcastSoundAssignment" ADD COLUMN IF NOT EXISTS "minEpisodeCooldown" INTEGER;
ALTER TABLE "PodcastSoundAssignment" ADD COLUMN IF NOT EXISTS "allowedFormatIds" TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE "PodcastSoundAssignment" ADD COLUMN IF NOT EXISTS "prohibitedFormatIds" TEXT[] NOT NULL DEFAULT '{}';

-- Intro/outro/bed become POOLS: drop the singleton uniqueness. The composite
-- unique ("podcastId","role","assetId") still prevents duplicate pool entries.
DROP INDEX IF EXISTS "PodcastSoundAssignment_singleton_role_key";

-- Bounded selection weight (existing rows already default to 1).
DO $$ BEGIN
  ALTER TABLE "PodcastSoundAssignment"
    ADD CONSTRAINT "PodcastSoundAssignment_weight_chk" CHECK ("weight" >= 0 AND "weight" <= 100);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "PodcastSoundAssignment_podcastId_role_enabled_idx"
  ON "PodcastSoundAssignment" ("podcastId", "role", "enabled");

-- ---------------------------------------------------------------------------
-- 3. AudioAsset: reviewed cue metadata + verification state.
-- ---------------------------------------------------------------------------
ALTER TABLE "AudioAsset" ADD COLUMN IF NOT EXISTS "cueMetadata" JSONB;
ALTER TABLE "AudioAsset" ADD COLUMN IF NOT EXISTS "metadataState" TEXT NOT NULL DEFAULT 'unclassified';

DO $$ BEGIN
  ALTER TABLE "AudioAsset"
    ADD CONSTRAINT "AudioAsset_metadataState_chk"
    CHECK ("metadataState" IN ('unclassified', 'suggested', 'verified'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "AudioAsset_metadataState_idx" ON "AudioAsset" ("metadataState");
