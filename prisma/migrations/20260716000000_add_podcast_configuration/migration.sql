-- Prompt 5: make Podcast the canonical, versioned show configuration and
-- snapshot it into every Episode.
--
-- This migration is ADDITIVE and NON-DESTRUCTIVE:
--   * every existing column is preserved (the legacy Podcast.verticals/teams/
--     segmentCount/hostIds columns stay; a compatibility adapter reads them
--     during the transition);
--   * no existing row is deleted or rewritten in a way that changes meaning;
--   * existing Episodes keep their exact configuration and are marked
--     configurationSource = 'legacy' (the column default), which honestly says
--     "built before snapshots existed" rather than fabricating one.
--
-- ASCII only: this file must be encodable under the WIN1252 client encoding the
-- deployment-contract test enforces. No non-ASCII characters anywhere.

-- ---------------------------------------------------------------------------
-- 1. Schema: identity columns, the three 1-1 config tables, Episode snapshot.
-- ---------------------------------------------------------------------------

-- AlterTable
ALTER TABLE "Podcast" ADD COLUMN     "author" TEXT,
ADD COLUMN     "category" TEXT,
ADD COLUMN     "configVersion" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "copyright" TEXT,
ADD COLUMN     "coverImageUrl" TEXT,
ADD COLUMN     "description" TEXT,
ADD COLUMN     "explicit" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "language" TEXT NOT NULL DEFAULT 'en',
ADD COLUMN     "ownerEmail" TEXT,
ADD COLUMN     "ownerName" TEXT,
ADD COLUMN     "slug" TEXT,
ADD COLUMN     "subcategory" TEXT,
ADD COLUMN     "visibility" TEXT NOT NULL DEFAULT 'private',
ADD COLUMN     "websiteUrl" TEXT;

-- AlterTable
ALTER TABLE "Episode" ADD COLUMN     "configurationFingerprint" TEXT,
ADD COLUMN     "configurationSnapshot" JSONB,
ADD COLUMN     "configurationSource" TEXT NOT NULL DEFAULT 'legacy',
ADD COLUMN     "podcastConfigurationVersion" INTEGER;

-- CreateTable
CREATE TABLE "PodcastEditorialConfig" (
    "id" TEXT NOT NULL,
    "podcastId" TEXT NOT NULL,
    "verticals" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "teams" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "segmentCount" INTEGER NOT NULL DEFAULT 3,
    "format" TEXT NOT NULL DEFAULT 'two_host_debate',
    "minDebateScore" INTEGER,
    "scriptStyle" TEXT,
    "maxWords" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PodcastEditorialConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PodcastProductionConfig" (
    "id" TEXT NOT NULL,
    "podcastId" TEXT NOT NULL,
    "hostIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "ttsProvider" TEXT,
    "ttsVoiceOverrides" JSONB,
    "productionStyle" TEXT,
    "sfxDensity" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PodcastProductionConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PodcastPublishingConfig" (
    "id" TEXT NOT NULL,
    "podcastId" TEXT NOT NULL,
    "autoGenerateChapters" BOOLEAN NOT NULL DEFAULT true,
    "autoGenerateShowNotes" BOOLEAN NOT NULL DEFAULT true,
    "autoGenerateCover" BOOLEAN NOT NULL DEFAULT true,
    "includeTranscript" BOOLEAN NOT NULL DEFAULT true,
    "downloadsEnabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PodcastPublishingConfig_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PodcastEditorialConfig_podcastId_key" ON "PodcastEditorialConfig"("podcastId");

-- CreateIndex
CREATE UNIQUE INDEX "PodcastProductionConfig_podcastId_key" ON "PodcastProductionConfig"("podcastId");

-- CreateIndex
CREATE UNIQUE INDEX "PodcastPublishingConfig_podcastId_key" ON "PodcastPublishingConfig"("podcastId");

-- CreateIndex
CREATE UNIQUE INDEX "Podcast_slug_key" ON "Podcast"("slug");

-- CreateIndex
CREATE INDEX "Podcast_visibility_idx" ON "Podcast"("visibility");

-- AddForeignKey
ALTER TABLE "PodcastEditorialConfig" ADD CONSTRAINT "PodcastEditorialConfig_podcastId_fkey" FOREIGN KEY ("podcastId") REFERENCES "Podcast"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PodcastProductionConfig" ADD CONSTRAINT "PodcastProductionConfig_podcastId_fkey" FOREIGN KEY ("podcastId") REFERENCES "Podcast"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PodcastPublishingConfig" ADD CONSTRAINT "PodcastPublishingConfig_podcastId_fkey" FOREIGN KEY ("podcastId") REFERENCES "Podcast"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 2. Backfill: every existing Podcast becomes a complete canonical show.
-- ---------------------------------------------------------------------------
-- Deterministic unique slug. Base = the name lowercased with runs of non
-- [a-z0-9] collapsed to a single '-' and trimmed; empty/degenerate names fall
-- back to 'show'. A short md5(id)-derived suffix is appended to every backfilled
-- slug so the result is (a) deterministic, (b) unique without a second pass, and
-- (c) incapable of colliding with a reserved word (the suffix is always present).
-- New shows created through the resolver get clean, reserved-name-checked slugs;
-- this suffix only marks legacy backfilled rows.
UPDATE "Podcast" p
SET "slug" = COALESCE(
      NULLIF(trim(BOTH '-' FROM regexp_replace(lower(p."name"), '[^a-z0-9]+', '-', 'g')), ''),
      'show'
    ) || '-' || substr(md5(p."id"), 1, 8)
WHERE p."slug" IS NULL;

-- One editorial config row per podcast, mirroring the legacy columns verbatim so
-- resolution is byte-for-byte identical to today's inheritance path.
INSERT INTO "PodcastEditorialConfig" ("id", "podcastId", "verticals", "teams", "segmentCount", "format", "updatedAt")
SELECT md5(p."id" || ':editorial'), p."id", p."verticals", p."teams", p."segmentCount", 'two_host_debate', CURRENT_TIMESTAMP
FROM "Podcast" p
WHERE NOT EXISTS (SELECT 1 FROM "PodcastEditorialConfig" e WHERE e."podcastId" = p."id");

-- One production config row per podcast, carrying the legacy hostIds. Voice /
-- sound-design overrides start null: legacy podcasts never stored per-show voice
-- pins, so claiming any would be fabrication. The resolver falls through to
-- host/env exactly as before.
INSERT INTO "PodcastProductionConfig" ("id", "podcastId", "hostIds", "updatedAt")
SELECT md5(p."id" || ':production'), p."id", p."hostIds", CURRENT_TIMESTAMP
FROM "Podcast" p
WHERE NOT EXISTS (SELECT 1 FROM "PodcastProductionConfig" pr WHERE pr."podcastId" = p."id");

-- One publishing config row per podcast at the honest defaults (all auto-assets
-- on, downloads on) which is exactly today's behavior.
INSERT INTO "PodcastPublishingConfig" ("id", "podcastId", "updatedAt")
SELECT md5(p."id" || ':publishing'), p."id", CURRENT_TIMESTAMP
FROM "Podcast" p
WHERE NOT EXISTS (SELECT 1 FROM "PodcastPublishingConfig" pu WHERE pu."podcastId" = p."id");

-- Existing Episodes keep configurationSource = 'legacy' from the column default.
-- No snapshot is fabricated for them; the snapshot service reconstructs an
-- explicitly incomplete=true view on demand instead of pretending history.
