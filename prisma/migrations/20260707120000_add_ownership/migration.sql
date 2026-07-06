-- Ownership: link podcasts + episodes to the User who created them.
-- Purely additive and nullable — legacy rows keep ownerId = NULL and stay
-- visible/functional. ON DELETE SET NULL so deleting a user never cascades
-- away their content. IF NOT EXISTS keeps it idempotent for `prisma db push`.

ALTER TABLE "Podcast" ADD COLUMN IF NOT EXISTS "ownerId" TEXT;
ALTER TABLE "Episode" ADD COLUMN IF NOT EXISTS "ownerId" TEXT;

CREATE INDEX IF NOT EXISTS "Podcast_ownerId_idx" ON "Podcast"("ownerId");
CREATE INDEX IF NOT EXISTS "Episode_ownerId_idx" ON "Episode"("ownerId");

DO $$ BEGIN
  ALTER TABLE "Podcast" ADD CONSTRAINT "Podcast_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "Episode" ADD CONSTRAINT "Episode_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
