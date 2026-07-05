-- Post-production sound design layer: managed audio asset library, show
-- sound configuration, and per-episode production settings.
-- IF NOT EXISTS keeps it idempotent for local dbs using `prisma db push`.

ALTER TABLE "Episode" ADD COLUMN IF NOT EXISTS "soundDesign" JSONB;

CREATE TABLE IF NOT EXISTS "AudioAsset" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "category" TEXT,
    "tags" JSONB NOT NULL,
    "audioUrl" TEXT NOT NULL,
    "storageKey" TEXT,
    "durationMs" INTEGER,
    "license" TEXT NOT NULL,
    "licenseNote" TEXT,
    "rightsConfirmed" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "source" TEXT NOT NULL DEFAULT 'upload',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AudioAsset_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "AudioAsset_kind_idx" ON "AudioAsset"("kind");
CREATE INDEX IF NOT EXISTS "AudioAsset_isActive_idx" ON "AudioAsset"("isActive");

CREATE TABLE IF NOT EXISTS "SoundDesignConfig" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "themeIntroAssetId" TEXT,
    "themeOutroAssetId" TEXT,
    "bedAssetId" TEXT,
    "stingerAssetIds" JSONB,
    "defaultStyle" TEXT NOT NULL DEFAULT 'full',
    "defaultSfxDensity" TEXT NOT NULL DEFAULT 'subtle',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SoundDesignConfig_pkey" PRIMARY KEY ("id")
);
