-- Additive: social clips table. No existing table/column is touched. Clips are
-- derived promo assets; a cascade on episode delete cleans them up.
CREATE TABLE IF NOT EXISTS "SocialClip" (
    "id" TEXT NOT NULL,
    "episodeId" TEXT NOT NULL,
    "scriptId" TEXT NOT NULL,
    "ownerId" TEXT,
    "startLineIndex" INTEGER NOT NULL,
    "endLineIndex" INTEGER NOT NULL,
    "title" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "kind" TEXT,
    "audioUrl" TEXT,
    "videoUrl" TEXT,
    "captionsUrl" TEXT,
    "durationMs" INTEGER,
    "autoSelected" BOOLEAN NOT NULL DEFAULT false,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SocialClip_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "SocialClip_episodeId_idx" ON "SocialClip"("episodeId");
CREATE INDEX IF NOT EXISTS "SocialClip_ownerId_idx" ON "SocialClip"("ownerId");

DO $$ BEGIN
  ALTER TABLE "SocialClip" ADD CONSTRAINT "SocialClip_episodeId_fkey"
    FOREIGN KEY ("episodeId") REFERENCES "Episode"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
