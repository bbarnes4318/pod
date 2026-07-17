-- Prompt 6 (PR 1): scoped, immutable audio-asset ownership.
--
-- Replaces the "one global active library" premise with explicit scopes:
--   shared_system   admin-managed, usable by everyone (no owner, no podcast)
--   owner_private   belongs to one User
--   podcast_private belongs to one owned Podcast
--   legacy_global   pre-Prompt-6 asset of ambiguous ownership: admin-only,
--                   blocked from NEW selection until classified
--
-- This migration is ADDITIVE and NON-DESTRUCTIVE:
--   * no column is dropped or renamed; legacy audioUrl/license/rightsConfirmed
--     stay as compatibility fields;
--   * no asset row is deleted;
--   * the backfill classifies existing rows from EVIDENCE only (source='seed'
--     is provably ours; everything else becomes legacy_global awaiting admin
--     review) — no owner is ever fabricated;
--   * no remote object is fetched, no ffprobe runs, no hash is computed here.
--     contentHash stays NULL for legacy rows until the explicit repair tool
--     (npm run repair:audio-asset-metadata) fills it.
--
-- ASCII only: this file must be encodable under the WIN1252 client encoding the
-- deployment-contract test enforces.

-- ---------------------------------------------------------------------------
-- 1. Schema: ownership + immutability + license/rights columns, audit table.
-- ---------------------------------------------------------------------------

-- AlterTable
ALTER TABLE "AudioAsset" ADD COLUMN     "allowedUse" TEXT,
ADD COLUMN     "archiveReason" TEXT,
ADD COLUMN     "archivedAt" TIMESTAMP(3),
ADD COLUMN     "bitrateKbps" INTEGER,
ADD COLUMN     "channelCount" INTEGER,
ADD COLUMN     "contentHash" TEXT,
ADD COLUMN     "createdByAdminIdentity" TEXT,
ADD COLUMN     "fileSizeBytes" INTEGER,
ADD COLUMN     "isArchived" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "legacyScopeReviewRequired" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "licenseName" TEXT,
ADD COLUMN     "licenseReference" TEXT,
ADD COLUMN     "licenseStatus" TEXT NOT NULL DEFAULT 'unknown',
ADD COLUMN     "mimeType" TEXT,
ADD COLUMN     "originalFilename" TEXT,
ADD COLUMN     "ownerId" TEXT,
ADD COLUMN     "podcastId" TEXT,
ADD COLUMN     "processingError" TEXT,
ADD COLUMN     "processingStatus" TEXT NOT NULL DEFAULT 'ready',
ADD COLUMN     "rightsConfirmedAt" TIMESTAMP(3),
ADD COLUMN     "rightsConfirmedByAdminIdentity" TEXT,
ADD COLUMN     "rightsConfirmedByUserId" TEXT,
ADD COLUMN     "rightsDocumentStorageKey" TEXT,
ADD COLUMN     "rightsExpiresAt" TIMESTAMP(3),
ADD COLUMN     "rightsNotes" TEXT,
ADD COLUMN     "rightsStatus" TEXT NOT NULL DEFAULT 'not_required',
ADD COLUMN     "sampleRate" INTEGER,
ADD COLUMN     "scope" TEXT NOT NULL DEFAULT 'legacy_global',
ADD COLUMN     "supersededByAssetId" TEXT,
ADD COLUMN     "uploadedByUserId" TEXT;

-- CreateTable
CREATE TABLE "AudioAssetAuditEvent" (
    "id" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "actorType" TEXT NOT NULL,
    "userId" TEXT,
    "adminIdentity" TEXT,
    "podcastId" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AudioAssetAuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AudioAssetAuditEvent_assetId_createdAt_idx" ON "AudioAssetAuditEvent"("assetId", "createdAt");

-- CreateIndex
CREATE INDEX "AudioAssetAuditEvent_event_idx" ON "AudioAssetAuditEvent"("event");

-- CreateIndex
CREATE INDEX "AudioAsset_scope_idx" ON "AudioAsset"("scope");

-- CreateIndex
CREATE INDEX "AudioAsset_ownerId_idx" ON "AudioAsset"("ownerId");

-- CreateIndex
CREATE INDEX "AudioAsset_podcastId_idx" ON "AudioAsset"("podcastId");

-- CreateIndex
CREATE INDEX "AudioAsset_contentHash_idx" ON "AudioAsset"("contentHash");

-- AddForeignKey
ALTER TABLE "AudioAsset" ADD CONSTRAINT "AudioAsset_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AudioAsset" ADD CONSTRAINT "AudioAsset_podcastId_fkey" FOREIGN KEY ("podcastId") REFERENCES "Podcast"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AudioAsset" ADD CONSTRAINT "AudioAsset_supersededByAssetId_fkey" FOREIGN KEY ("supersededByAssetId") REFERENCES "AudioAsset"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AudioAssetAuditEvent" ADD CONSTRAINT "AudioAssetAuditEvent_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "AudioAsset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 2. Backfill: classify every existing asset from EVIDENCE, never invention.
-- ---------------------------------------------------------------------------

-- 2a. Seed assets are provably ours: the starter pack is generated in-house by
--     the sound-pack generator (zero third-party rights). They become the
--     shared system library, exactly as they behave today.
UPDATE "AudioAsset" SET
  "scope" = 'shared_system',
  "ownerId" = NULL,
  "podcastId" = NULL,
  "licenseStatus" = 'original',
  "licenseName" = COALESCE("licenseName", 'Original (generated in-house)'),
  "rightsStatus" = 'confirmed',
  "rightsConfirmedAt" = COALESCE("rightsConfirmedAt", CURRENT_TIMESTAMP),
  "rightsConfirmedByAdminIdentity" = COALESCE("rightsConfirmedByAdminIdentity", 'system:migration-20260717'),
  "legacyScopeReviewRequired" = false
WHERE "source" = 'seed';

-- 2b. Every non-seed asset predates ownership and has NO reliable evidence of
--     who uploaded it. It becomes legacy_global: admin-only, visible with an
--     explicit "ownership review required" flag, blocked from NEW selection
--     until an admin classifies it. Historical references (existing
--     SoundDesignConfig / SoundCueUsage / Episode.soundDesign highlights)
--     remain readable through the compatibility resolver.
--     rightsStatus maps the legacy boolean HONESTLY: the boolean was the only
--     rights signal, and it only ever gated highlights. Non-highlights render
--     today with no rights check at all, so not_required preserves exactly the
--     current behavior while the review flag marks them for classification.
UPDATE "AudioAsset" SET
  "scope" = 'legacy_global',
  "legacyScopeReviewRequired" = true,
  "licenseStatus" = 'unknown',
  "rightsStatus" = CASE
    WHEN "rightsConfirmed" THEN 'confirmed'
    WHEN "kind" = 'highlight' THEN 'pending'
    ELSE 'not_required'
  END
WHERE "source" <> 'seed';

-- ---------------------------------------------------------------------------
-- 3. Scope integrity constraints (added AFTER the backfill so existing rows
--    already satisfy them).
-- ---------------------------------------------------------------------------

ALTER TABLE "AudioAsset" ADD CONSTRAINT "AudioAsset_scope_valid_chk"
  CHECK ("scope" IN ('shared_system', 'owner_private', 'podcast_private', 'legacy_global'));

-- A shared-system asset can never carry a user owner or a podcast.
ALTER TABLE "AudioAsset" ADD CONSTRAINT "AudioAsset_shared_system_unowned_chk"
  CHECK ("scope" <> 'shared_system' OR ("ownerId" IS NULL AND "podcastId" IS NULL));

-- Only podcast_private assets may reference a podcast. (Owner presence for
-- private scopes is enforced at the service layer + data invariants, because
-- the FK is ON DELETE SET NULL: a deleted user leaves the asset fail-closed
-- inaccessible rather than blocking the user deletion.)
ALTER TABLE "AudioAsset" ADD CONSTRAINT "AudioAsset_podcast_scope_chk"
  CHECK ("podcastId" IS NULL OR "scope" = 'podcast_private');

-- ---------------------------------------------------------------------------
-- 4. Immutable media content: once an asset is ready, its bytes are frozen.
--    Replacing audio must create a NEW asset (supersession), so historical
--    Episode snapshots and render records stay auditable forever. NULL -> value
--    is allowed (the explicit repair tool backfills legacy metadata); changing
--    an existing non-null value is not.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION audio_asset_content_guard() RETURNS trigger AS $guard$
BEGIN
  IF OLD."processingStatus" = 'ready' THEN
    IF OLD."contentHash" IS NOT NULL AND NEW."contentHash" IS DISTINCT FROM OLD."contentHash" THEN
      RAISE EXCEPTION 'AudioAsset % is immutable: contentHash cannot change on a ready asset. Create a new asset that supersedes it.', OLD."id";
    END IF;
    IF OLD."storageKey" IS NOT NULL AND NEW."storageKey" IS DISTINCT FROM OLD."storageKey" THEN
      RAISE EXCEPTION 'AudioAsset % is immutable: storageKey cannot change on a ready asset. Create a new asset that supersedes it.', OLD."id";
    END IF;
    IF NEW."audioUrl" IS DISTINCT FROM OLD."audioUrl" THEN
      RAISE EXCEPTION 'AudioAsset % is immutable: audioUrl cannot change on a ready asset. Create a new asset that supersedes it.', OLD."id";
    END IF;
  END IF;
  RETURN NEW;
END
$guard$ LANGUAGE plpgsql;

CREATE TRIGGER audio_asset_content_guard
  BEFORE UPDATE ON "AudioAsset"
  FOR EACH ROW EXECUTE FUNCTION audio_asset_content_guard();
